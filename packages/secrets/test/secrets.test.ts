import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EnvSecretStore } from "../src/store";
import {
  InfisicalAdmin,
  InfisicalClient,
  InfisicalSecretStore,
  companyPath,
  infisicalEnv,
} from "../src/infisical";

describe("EnvSecretStore", () => {
  const env = {
    OPENCORP_SECRET__STRIPEKEY: "platform-default",
    OPENCORP_SECRET__ABC123__STRIPEKEY: "company-override",
  };
  const store = new EnvSecretStore(env);

  test("per-company override beats platform default", async () => {
    expect(await store.get("abc-123", "STRIPEKEY")).toBe("company-override");
  });
  test("falls back to platform default", async () => {
    expect(await store.get("other-co", "STRIPEKEY")).toBe("platform-default");
  });
  test("null when nothing configured", async () => {
    expect(await store.get("abc-123", "MISSING")).toBeNull();
  });
});

describe("infisicalEnv", () => {
  test("null unless fully configured", () => {
    expect(infisicalEnv({ INFISICAL_URL: "http://x" })).toBeNull();
  });
  test("parses + defaults environment to prod, strips trailing slash", () => {
    expect(
      infisicalEnv({
        INFISICAL_URL: "http://vault:8080/",
        INFISICAL_CLIENT_ID: "cid",
        INFISICAL_CLIENT_SECRET: "csec",
        INFISICAL_PROJECT_ID: "proj1",
      }),
    ).toEqual({
      url: "http://vault:8080",
      clientId: "cid",
      clientSecret: "csec",
      projectId: "proj1",
      environment: "prod",
    });
  });
});

// ── Fake Infisical server ───────────────────────────────────────────────────

interface Store {
  // secretPath → key → value
  secrets: Map<string, Map<string, string>>;
  folders: Set<string>; // "path::name"
  logins: number;
}
const db: Store = { secrets: new Map(), folders: new Set(), logins: 0 };
let server: ReturnType<typeof Bun.serve>;
let base: string;

function cfg() {
  return {
    url: base,
    clientId: "cid",
    clientSecret: "csec",
    projectId: "proj1",
    environment: "prod",
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const auth = req.headers.get("authorization");

      if (p === "/api/v1/auth/universal-auth/login") {
        const body = (await req.json()) as { clientId: string; clientSecret: string };
        if (body.clientId !== "cid" || body.clientSecret !== "csec")
          return new Response("bad creds", { status: 401 });
        db.logins++;
        return Response.json({ accessToken: "tok-abc", expiresIn: 3600, tokenType: "Bearer" });
      }

      // everything else requires the bearer token
      if (auth !== "Bearer tok-abc") return new Response("unauthorized", { status: 401 });

      if (p === "/api/v1/folders" && req.method === "POST") {
        const b = (await req.json()) as { name: string; path: string };
        const id = `${b.path}::${b.name}`;
        if (db.folders.has(id)) return new Response("folder already exists", { status: 409 });
        db.folders.add(id);
        return Response.json({ folder: { id, name: b.name } });
      }

      if (p.startsWith("/api/v3/secrets/raw/")) {
        const key = decodeURIComponent(p.slice("/api/v3/secrets/raw/".length));
        const secretPath = url.searchParams.get("secretPath") ?? "/";
        const folder = db.secrets.get(secretPath);

        if (req.method === "GET") {
          const v = folder?.get(key);
          if (v === undefined) return new Response("not found", { status: 404 });
          return Response.json({ secret: { secretKey: key, secretValue: v } });
        }
        const b = (await req.json()) as { secretPath: string; secretValue: string };
        const f = db.secrets.get(b.secretPath) ?? new Map<string, string>();
        if (req.method === "POST") {
          if (f.has(key)) return new Response("secret already exists", { status: 409 });
          f.set(key, b.secretValue);
          db.secrets.set(b.secretPath, f);
          return Response.json({ secret: { secretKey: key } });
        }
        if (req.method === "PATCH") {
          f.set(key, b.secretValue);
          db.secrets.set(b.secretPath, f);
          return Response.json({ secret: { secretKey: key } });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));
beforeEach(() => {
  db.secrets.clear();
  db.folders.clear();
  db.logins = 0;
});

describe("InfisicalClient", () => {
  test("logs in once and caches the token across calls", async () => {
    const c = new InfisicalClient(cfg());
    await c.setSecret("K", "v", "/");
    await c.getSecret("K", "/");
    await c.getSecret("K", "/");
    expect(db.logins).toBe(1);
  });

  test("setSecret upserts (POST then PATCH on conflict)", async () => {
    const c = new InfisicalClient(cfg());
    await c.setSecret("K", "first", "/");
    await c.setSecret("K", "second", "/"); // 409 → PATCH
    expect(await c.getSecret("K", "/")).toBe("second");
  });

  test("ensureFolder is idempotent", async () => {
    const c = new InfisicalClient(cfg());
    await c.ensureFolder("companies", "/");
    await c.ensureFolder("companies", "/"); // 409 swallowed
    expect(db.folders.has("/::companies")).toBe(true);
  });
});

describe("InfisicalSecretStore", () => {
  test("per-company path beats platform default, then null", async () => {
    const store = new InfisicalSecretStore(cfg());
    const client = new InfisicalClient(cfg());
    await client.setSecret("STRIPE", "platform", "/");
    await client.setSecret("STRIPE", "acme-key", companyPath("acme"));

    expect(await store.get("acme", "STRIPE")).toBe("acme-key");
    expect(await store.get("other", "STRIPE")).toBe("platform"); // falls back
    expect(await store.get("acme", "MISSING")).toBeNull();
  });
});

describe("InfisicalAdmin", () => {
  test("provisions the company folder (and parent) and writes scoped secrets", async () => {
    const client = new InfisicalClient(cfg());
    const admin = new InfisicalAdmin(client);
    await admin.ensureCompanyFolder("co-1");
    expect(db.folders.has("/::companies")).toBe(true);
    expect(db.folders.has("/companies::co-1")).toBe(true);

    await admin.setCompanySecret("co-1", "OPENAI_KEY", "sk-xyz");
    expect(await new InfisicalSecretStore(cfg()).get("co-1", "OPENAI_KEY")).toBe("sk-xyz");
  });
});
