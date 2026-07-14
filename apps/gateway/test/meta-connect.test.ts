import { afterEach, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import {
  signMetaState,
  verifyMetaState,
  metaConnectStart,
  metaConnectCallback,
  metaAppConfig,
  META_OAUTH_SCOPES,
} from "../src/meta-connect";
import { EnvSecretStore } from "../src/secrets";

const APP_ENV = {
  OPENCORP_SECRET__META_APP_ID: "app-1",
  OPENCORP_SECRET__META_APP_SECRET: "sec-1",
};
const appSecrets = new EnvSecretStore(APP_ENV);
const CID = "11111111-1111-1111-1111-111111111111";
const REDIRECT = "https://gw.example/connect/meta/callback";

describe("meta connect state signing", () => {
  test("round-trips a conglomerate id", () => {
    const st = signMetaState(CID);
    expect(verifyMetaState(st)).toEqual({ conglomerateId: CID });
  });

  test("rejects a tampered state", () => {
    const st = signMetaState(CID);
    const tampered = st.replace(CID, "22222222-2222-2222-2222-222222222222");
    expect(verifyMetaState(tampered)).toBeNull();
  });

  test("rejects an expired state", () => {
    const old = signMetaState(CID, Date.now() - 2 * 60 * 60 * 1000); // 2h ago
    expect(verifyMetaState(old)).toBeNull();
  });

  test("rejects a malformed state", () => {
    expect(verifyMetaState("nonsense")).toBeNull();
  });
});

describe("meta connect start", () => {
  test("is OFF with no app configured", async () => {
    const r = await metaConnectStart(new EnvSecretStore({}), { conglomerateId: CID, redirectUri: REDIRECT });
    expect(r.mode).toBe("off");
    expect(r.authUrl).toBeNull();
  });

  test("builds the OAuth dialog URL when the app is configured", async () => {
    expect(await metaAppConfig(appSecrets)).toEqual({ appId: "app-1", appSecret: "sec-1" });
    const r = await metaConnectStart(appSecrets, { conglomerateId: CID, redirectUri: REDIRECT });
    expect(r.mode).toBe("meta");
    const u = new URL(r.authUrl!);
    expect(u.hostname).toBe("www.facebook.com");
    expect(u.searchParams.get("client_id")).toBe("app-1");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("scope")).toBe(META_OAUTH_SCOPES);
    expect(u.searchParams.get("response_type")).toBe("code");
    // the state carries our conglomerate id, verifiably
    expect(verifyMetaState(u.searchParams.get("state")!)).toEqual({ conglomerateId: CID });
  });
});

describe("meta connect callback", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /** Fake tagged-template sql: conglomerate exists, record the UPDATE. */
  function fakeSql(opts: { exists?: boolean; onUpdate?: (account: string, page: string, cid: string) => void }) {
    return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join(" ");
      if (q.includes("UPDATE conglomerates")) {
        opts.onUpdate?.(String(vals[0]), String(vals[1]), String(vals[2]));
        return Promise.resolve([]);
      }
      if (q.includes("SELECT 1 FROM conglomerates")) {
        return Promise.resolve(opts.exists === false ? [] : [{ "?column?": 1 }]);
      }
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
  }

  /** Stub the Graph token-exchange + account/page reads. */
  function stubGraph(overrides?: { adAccounts?: unknown[]; pages?: unknown[] }) {
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const u = new URL(String(url));
      const path = u.pathname.split("/").slice(2).join("/"); // drop /<version>/
      calls.push(path);
      if (path === "oauth/access_token") {
        // short-lived on code exchange, long-lived on fb_exchange_token
        const token = u.searchParams.get("grant_type") === "fb_exchange_token" ? "long-tok" : "short-tok";
        return new Response(JSON.stringify({ access_token: token, expires_in: 5184000 }), { status: 200 });
      }
      if (path === "me/adaccounts") {
        return new Response(JSON.stringify({ data: overrides?.adAccounts ?? [{ id: "act_1", account_id: "1", name: "Acct" }] }), { status: 200 });
      }
      if (path === "me/accounts") {
        return new Response(JSON.stringify({ data: overrides?.pages ?? [{ id: "page_1", name: "Page" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "unexpected" } }), { status: 400 });
    }) as typeof fetch;
    return calls;
  }

  test("exchanges the code, links account + page, and stores the token", async () => {
    const calls = stubGraph();
    let updated: { account: string; page: string; cid: string } | null = null;
    let saved: { cid: string; token: string } | null = null;
    const sql = fakeSql({ onUpdate: (account, page, cid) => (updated = { account, page, cid }) });

    const r = await metaConnectCallback(
      sql,
      appSecrets,
      { code: "the-code", state: signMetaState(CID), redirectUri: REDIRECT },
      async (cid, token) => { saved = { cid, token }; },
    );

    expect(r).toMatchObject({ conglomerateId: CID, adAccountId: "act_1", pageId: "page_1", adAccountName: "Acct", pageName: "Page", tokenStored: true });
    // both token exchanges happened, then the two reads
    expect(calls).toEqual(["oauth/access_token", "oauth/access_token", "me/adaccounts", "me/accounts"]);
    // persisted the long-lived token + linked ids
    expect(saved).toEqual({ cid: CID, token: "long-tok" });
    expect(updated).toEqual({ account: "act_1", page: "page_1", cid: CID });
  });

  test("without a vault writer, links ids but flags the token as unstored", async () => {
    stubGraph();
    const r = await metaConnectCallback(
      fakeSql({}),
      appSecrets,
      { code: "c", state: signMetaState(CID), redirectUri: REDIRECT },
      null,
    );
    expect(r.tokenStored).toBe(false);
    expect(r.message).toContain("OPENCORP_SECRET__META_ACCESS_TOKEN");
  });

  test("rejects a forged state before any network call", async () => {
    const calls = stubGraph();
    await expect(
      metaConnectCallback(fakeSql({}), appSecrets, { code: "c", state: "forged.123.deadbeef", redirectUri: REDIRECT }, null),
    ).rejects.toThrow("bad_state");
    expect(calls).toHaveLength(0);
  });

  test("throws when the account has no ad account", async () => {
    stubGraph({ adAccounts: [] });
    await expect(
      metaConnectCallback(fakeSql({}), appSecrets, { code: "c", state: signMetaState(CID), redirectUri: REDIRECT }, null),
    ).rejects.toThrow("no_ad_account");
  });

  test("throws when there is no Facebook Page", async () => {
    stubGraph({ pages: [] });
    await expect(
      metaConnectCallback(fakeSql({}), appSecrets, { code: "c", state: signMetaState(CID), redirectUri: REDIRECT }, null),
    ).rejects.toThrow("no_facebook_page");
  });
});
