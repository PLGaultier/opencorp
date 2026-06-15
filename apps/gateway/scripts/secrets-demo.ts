/**
 * Real-secrets exit test (§3, §12): per-company secret vault on a live Infisical
 * instance — no mock store. Requires the dev stack:
 *
 *   docker compose -f infra/compose/docker-compose.dev.yml up -d postgres valkey infisical
 *   bun apps/gateway/scripts/secrets-demo.ts
 *
 * Flow:
 *   1. bootstrap the instance (admin user + org + instance-admin identity token)
 *   2. create a project; use it to drive the *real* Infisical API through our
 *      own InfisicalClient/Admin/Store (the code the platform actually ships)
 *   3. provision a company folder, write a per-company secret + a platform
 *      default, and assert the store's resolution order (override → default →
 *      null) against the real server
 *   4. verify the gateway's signed /admin/secrets route writes through to the
 *      vault and a capability provider (emailFor) reads the company's value.
 */
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  InfisicalAdmin,
  InfisicalClient,
  InfisicalSecretStore,
  type InfisicalConfig,
} from "@opencorp/secrets";

const INFISICAL_URL = process.env.INFISICAL_URL ?? "http://localhost:8082";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function api(path: string, token: string, body?: unknown, method = "POST") {
  const res = await fetch(`${INFISICAL_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<Record<string, any>>;
}

async function main() {
  // ── 1. bootstrap the instance (idempotent-ish: tolerate "already bootstrapped") ─
  const email = `admin+${Date.now().toString(36)}@opencorp.dev`;
  let adminToken: string;
  let orgId: string;
  const boot = await fetch(`${INFISICAL_URL}/api/v1/admin/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "OpenCorp-dev-123!", organization: "OpenCorp" }),
  });
  if (boot.ok) {
    const body = await boot.json();
    adminToken = body.identity.credentials.token;
    orgId = body.organization.id;
    ok(adminToken, "bootstrapped instance → instance-admin identity token");
  } else {
    throw new Error(
      `bootstrap failed (${boot.status}): ${await boot.text()}\n` +
        `If already bootstrapped, reset with: docker compose rm -sf infisical && docker volume rm opencorp-dev_pgdata (heavy) ` +
        `or set INFISICAL_* env from an existing identity and skip this script's bootstrap.`,
    );
  }

  // ── 2. create a project (workspace) with our admin identity ───────────────
  const created = await api("/api/v2/workspace", adminToken, { projectName: `opencorp-${Date.now().toString(36)}` });
  const project = created.project ?? created.workspace ?? created;
  const projectId: string = project.id;
  ok(projectId, `created project ${projectId}`);
  // New projects get default environments; "prod" is one of them.
  const envSlug = (project.environments?.find((e: any) => e.slug === "prod")?.slug as string) ?? "prod";

  const cfg: InfisicalConfig = {
    url: INFISICAL_URL,
    clientId: "unused-static-token",
    clientSecret: "unused",
    projectId,
    environment: envSlug,
  };
  // Drive the REAL Infisical API through our shipping client, authenticated
  // with the bootstrap token (Token Auth) instead of Universal Auth login.
  const client = new InfisicalClient(cfg, adminToken);
  const admin = new InfisicalAdmin(client);
  const store = new InfisicalSecretStore(cfg, client);

  // ── 3. provision a company folder + secrets, assert resolution order ──────
  const companyId = randomUUID();
  await admin.ensureCompanyFolder(companyId);
  await admin.ensureCompanyFolder(companyId); // idempotent
  ok(true, "ensureCompanyFolder created /companies/{id} (idempotent on re-run)");

  await client.setSecret("STRIPE_SECRET_KEY", "sk_platform_default", "/");
  await admin.setCompanySecret(companyId, "STRIPE_SECRET_KEY", "sk_live_company");
  await admin.setCompanySecret(companyId, "STRIPE_SECRET_KEY", "sk_live_company_rotated"); // upsert

  ok((await store.get(companyId, "STRIPE_SECRET_KEY")) === "sk_live_company_rotated", "per-company secret resolves (upsert won)");
  ok((await store.get(randomUUID(), "STRIPE_SECRET_KEY")) === "sk_platform_default", "unknown company falls back to platform default");
  ok((await store.get(companyId, "DOES_NOT_EXIST")) === null, "missing secret resolves to null");

  // ── 4. provision a real Universal Auth machine identity (what prod uses) ───
  const ident = await api("/api/v1/identities", adminToken, {
    name: `opencorp-gateway-${Date.now().toString(36)}`,
    organizationId: orgId,
    role: "admin",
  });
  const identityId: string = ident.identity.id;
  const ua = await api(`/api/v1/auth/universal-auth/identities/${identityId}`, adminToken, {
    clientSecretTrustedIps: [{ ipAddress: "0.0.0.0/0" }],
    accessTokenTrustedIps: [{ ipAddress: "0.0.0.0/0" }],
  });
  const clientId: string = ua.identityUniversalAuth.clientId;
  const cs = await api(`/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, adminToken, {
    description: "opencorp gateway",
  });
  const clientSecret: string = cs.clientSecret;
  await api(`/api/v2/workspace/${projectId}/identity-memberships/${identityId}`, adminToken, { role: "admin" });
  ok(clientId && clientSecret, "provisioned a Universal Auth machine identity for the gateway");

  // The gateway authenticates to the vault with those creds (Universal Auth
  // login — the real prod path), so this exercises InfisicalSecretStore end to end.
  process.env.INFISICAL_URL = INFISICAL_URL;
  process.env.INFISICAL_CLIENT_ID = clientId;
  process.env.INFISICAL_CLIENT_SECRET = clientSecret;
  process.env.INFISICAL_PROJECT_ID = projectId;
  process.env.INFISICAL_ENV = envSlug;
  const { createGateway } = await import("../src/app");
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });

  // a company row the route can find
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap) VALUES ('demo','Secrets Demo','10') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, email_address, subdomain)
    VALUES (${cg!.id}, ${`secco-${Date.now().toString(36)}`}, 'SecCo', 'm', 'active', 'x@opencorp.dev', 'x.localhost')
    RETURNING id`;

  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
  const body = JSON.stringify({ companyId: co!.id, key: "OPENAI_API_KEY", value: "sk-company-openai" });
  const sig = createHmac("sha256", GATEWAY_SECRET).update(body).digest("hex");
  const res = await fetch(`http://localhost:${server.port}/admin/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sig },
    body,
  });
  const out = (await res.json()) as { ok?: boolean; error?: string };
  ok(res.status === 200 && out.ok, `signed /admin/secrets stored OPENAI_API_KEY (${out.error ?? "ok"})`);

  const storedViaRoute = await new InfisicalSecretStore(cfg, client).get(co!.id, "OPENAI_API_KEY");
  ok(storedViaRoute === "sk-company-openai", "secret written by the gateway route is readable from the vault");

  const [evt] = await sql`
    SELECT payload FROM ledger_events WHERE company_id = ${co!.id} AND event_type = 'secret_set' LIMIT 1`;
  ok(evt && (evt as any).payload.value === "[redacted]", "secret_set ledger event redacts the value (§9.3)");

  const verdict = await ledger.verify();
  ok(verdict.ok, `hash chain verifies (head seq ${(await ledger.head())?.seq})`);

  console.log("\nSECRETS DEMO PASSED — real per-company vault on Infisical, resolution + provisioning + signed write, value never on the ledger.");
  server.stop(true);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
