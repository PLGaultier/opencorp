import { createHmac, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import type { SecretStore } from "./secrets";
import { GRAPH_VERSION } from "./providers/ads";

/**
 * Meta Ads connect (§14). The owner-facing counterpart to Stripe Connect
 * (`connect.ts`): a one-click OAuth flow that connects a conglomerate's Meta ad
 * account + Facebook Page so agents can run real campaigns, instead of the owner
 * hand-editing the vault. Same "one connected identity per conglomerate" model —
 * Meta bills the owner's payment method, not our Stripe.
 *
 * Two halves, mirroring the Stripe routes:
 *   - start:    build the Facebook OAuth dialog URL (owner-initiated, signed).
 *   - callback: Facebook redirects the browser back with ?code — we exchange it
 *               for a long-lived token, pick the ad account + Page, and persist
 *               (token → vault, account/page ids → conglomerates row).
 *
 * With no Meta *app* configured (the dev default — no META_APP_ID/SECRET),
 * connect is off and start returns a local stub so the dashboard still renders;
 * ads then stay on the offline mock (see `adsFor`).
 *
 * Token note: the OAuth path yields a long-lived *user* token (~60 days). A
 * non-expiring System-User token is sturdier for an always-on system; upgrading
 * to that (or refreshing before expiry) is a follow-up — the connected ids and
 * the vault write are the same either way.
 */

/** OAuth scopes we need: manage + read ads, read the business, list Pages. */
export const META_OAUTH_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
].join(",");

/** How long a signed OAuth `state` stays valid (guards the redirect round-trip). */
const STATE_TTL_MS = 60 * 60 * 1000; // 1h

const stateSecret = () => process.env.GATEWAY_SECRET ?? "dev-gateway-secret";

/**
 * Sign the OAuth `state`: `<conglomerateId>.<issuedAtMs>.<hmac>`. The callback
 * verifies the HMAC (so a caller can't forge which conglomerate a token lands
 * on) and the age, then trusts the conglomerate id inside.
 */
export function signMetaState(conglomerateId: string, now = Date.now()): string {
  const payload = `${conglomerateId}.${now}`;
  const mac = createHmac("sha256", stateSecret()).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

export function verifyMetaState(state: string, now = Date.now()): { conglomerateId: string } | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [conglomerateId, issuedAt, mac] = parts;
  const expected = createHmac("sha256", stateSecret()).update(`${conglomerateId}.${issuedAt}`).digest("hex");
  if (mac!.length !== expected.length || !timingSafeEqual(Buffer.from(mac!), Buffer.from(expected))) return null;
  if (!Number.isFinite(Number(issuedAt)) || now - Number(issuedAt) > STATE_TTL_MS) return null;
  return { conglomerateId: conglomerateId! };
}

/** The platform Meta app credentials (one app for all conglomerates), or null. */
export async function metaAppConfig(secrets: SecretStore): Promise<{ appId: string; appSecret: string } | null> {
  const appId = await secrets.get("platform", "META_APP_ID");
  const appSecret = await secrets.get("platform", "META_APP_SECRET");
  return appId && appSecret ? { appId, appSecret } : null;
}

export interface MetaStartRequest {
  conglomerateId: string;
  /** The public callback URL Facebook redirects back to (must match the app). */
  redirectUri: string;
}

export type MetaStartResult =
  | { mode: "meta"; authUrl: string }
  | { mode: "off"; authUrl: null; message: string };

/** Build the Facebook OAuth dialog URL for the owner to authorize. */
export async function metaConnectStart(secrets: SecretStore, req: MetaStartRequest): Promise<MetaStartResult> {
  const app = await metaAppConfig(secrets);
  if (!app) {
    return {
      mode: "off",
      authUrl: null,
      message: "Meta connect is off (no platform META_APP_ID/META_APP_SECRET); set META_ACCESS_TOKEN + the account/page ids manually to go live.",
    };
  }
  const qs = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: req.redirectUri,
    state: signMetaState(req.conglomerateId),
    scope: META_OAUTH_SCOPES,
    response_type: "code",
  });
  return { mode: "meta", authUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${qs}` };
}

export interface MetaCallbackRequest {
  code: string;
  state: string;
  /** Must be byte-identical to the redirectUri used at start (Meta checks it). */
  redirectUri: string;
}

export interface MetaCallbackResult {
  conglomerateId: string;
  adAccountId: string;
  pageId: string;
  adAccountName: string;
  pageName: string;
  /** null when the token was persisted to the vault; a message when it couldn't. */
  tokenStored: boolean;
  message?: string;
}

/** Persist the long-lived token for a conglomerate (vault write). */
export type SaveToken = (conglomerateId: string, token: string) => Promise<void>;

async function graphGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}?${qs}`);
  const body = (await res.json()) as { error?: { message: string } } & Record<string, unknown>;
  if (!res.ok) throw new Error(`meta ${path} failed: ${body.error?.message ?? res.status}`);
  return body;
}

/**
 * Complete the OAuth round-trip: verify state → code→short→long-lived token →
 * pick the first ad account + Page → persist. Auto-selecting the first of each
 * keeps v1 one-click; multi-account owners can be given a picker later. Throws
 * with a terminal-ish message on a bad state / no ad account / no Page so the
 * route can 4xx rather than retry.
 */
export async function metaConnectCallback(
  sql: postgres.Sql,
  secrets: SecretStore,
  req: MetaCallbackRequest,
  saveToken: SaveToken | null,
): Promise<MetaCallbackResult> {
  const app = await metaAppConfig(secrets);
  if (!app) throw new Error("meta_connect_off");
  const st = verifyMetaState(req.state);
  if (!st) throw new Error("bad_state");
  const [cg] = await sql`SELECT 1 FROM conglomerates WHERE id = ${st.conglomerateId}`;
  if (!cg) throw new Error("conglomerate_not_found");

  // code → short-lived token
  const short = (await graphGet("oauth/access_token", {
    client_id: app.appId,
    client_secret: app.appSecret,
    redirect_uri: req.redirectUri,
    code: req.code,
  })) as { access_token?: string };
  if (!short.access_token) throw new Error("no_token_from_code");

  // short-lived → long-lived (~60 days)
  const long = (await graphGet("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: app.appId,
    client_secret: app.appSecret,
    fb_exchange_token: short.access_token,
  })) as { access_token?: string };
  const token = long.access_token ?? short.access_token;

  // Pick the first ad account + Page (v1 auto-select).
  const accounts = (await graphGet("me/adaccounts", { fields: "account_id,name", access_token: token })) as {
    data?: { id: string; account_id: string; name: string }[];
  };
  const account = accounts.data?.[0];
  if (!account) throw new Error("no_ad_account");

  const pages = (await graphGet("me/accounts", { fields: "id,name", access_token: token })) as {
    data?: { id: string; name: string }[];
  };
  const page = pages.data?.[0];
  if (!page) throw new Error("no_facebook_page");

  await sql`
    UPDATE conglomerates
    SET meta_ad_account_id = ${account.id}, facebook_page_id = ${page.id}
    WHERE id = ${st.conglomerateId}`;

  // The token is a secret → vault. When the vault isn't wired (dev), we still
  // record the account/page so the owner only needs to drop the token in by hand.
  let tokenStored = false;
  let message: string | undefined;
  if (saveToken) {
    await saveToken(st.conglomerateId, token);
    tokenStored = true;
  } else {
    message = "Account + Page linked, but the secrets vault is off — set OPENCORP_SECRET__META_ACCESS_TOKEN to finish.";
  }

  return {
    conglomerateId: st.conglomerateId,
    adAccountId: account.id,
    pageId: page.id,
    adAccountName: account.name,
    pageName: page.name,
    tokenStored,
    message,
  };
}
