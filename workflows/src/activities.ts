import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { extractCompanySpec, launchPlaybook, llmConfigFromEnv, type CompanySpec } from "@opencorp/llm";
import { Ledger, PgStore, type LedgerEventInput } from "@opencorp/ledgerd";
import { StalwartAdmin, deriveMailboxPassword, stalwartEnv } from "@opencorp/stalwart";
import { InfisicalAdmin, InfisicalClient, infisicalEnv } from "@opencorp/secrets";
import { ensureHeartbeatSchedule } from "./schedule";

/**
 * CreateCompany activities. All idempotent:
 *  - DB writes use ON CONFLICT
 *  - external creates treat "already exists" (409/422) as success
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const FORGEJO_URL = process.env.FORGEJO_URL;
const FORGEJO_TOKEN = process.env.FORGEJO_TOKEN;
const UMAMI_URL = process.env.UMAMI_URL;
const UMAMI_TOKEN = process.env.UMAMI_TOKEN;
const DEPLOYD_URL = process.env.DEPLOYD_URL ?? "http://localhost:3002";
const DOMAIN = process.env.OPENCORP_DOMAIN ?? "localhost";
// Mail lives on its own (sub)domain (Resend-verified + Stalwart MX); fall back to
// the apex only when unset. provisionMailbox re-asserts this, but seed it right.
const MAIL_DOMAIN = process.env.MAIL_DOMAIN ?? DOMAIN;
// The gateway serves the local checkout page; starter payment links point here.
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3004";
const CHECKOUT_BASE = process.env.CHECKOUT_BASE_URL ?? `${GATEWAY_URL}/checkout`;

const sql = postgres(DATABASE_URL, { max: 5 });
const ledger = new Ledger(new PgStore(DATABASE_URL));

export async function extractSpec(prompt: string): Promise<CompanySpec> {
  return extractCompanySpec(llmConfigFromEnv(), prompt);
}

export async function upsertCompany(input: {
  conglomerateId: string;
  spec: CompanySpec;
}): Promise<{ companyId: string }> {
  const { spec } = input;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, subdomain, email_address, db_name)
    VALUES (${input.conglomerateId}, ${spec.slug}, ${spec.name}, ${spec.mission},
            ${`${spec.slug}.${DOMAIN}`}, ${`${spec.slug}@${MAIL_DOMAIN}`}, ${`corp_${spec.slug.replaceAll("-", "_")}`})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id`;
  const companyId = row!.id;
  await sql`
    INSERT INTO agents (company_id, kind, name, role_prompt, model_tier)
    SELECT ${companyId}, 'ceo', 'CEO', 'prompts/ceo.md', 'frontier'
    WHERE NOT EXISTS (SELECT 1 FROM agents WHERE company_id = ${companyId} AND kind = 'ceo')`;
  return { companyId };
}

/** Dedicated per-company database on the shared cluster (§3). */
export async function provisionCompanyDb(slug: string): Promise<string> {
  const dbName = `corp_${slug.replaceAll("-", "_")}`;
  const [exists] = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (!exists) {
    // CREATE DATABASE cannot run in a transaction; unsafe() because identifiers
    // can't be parameterized — dbName is derived from the validated slug only.
    await sql.unsafe(`CREATE DATABASE "${dbName}"`);
  }
  return dbName;
}

export async function createForgejoRepo(slug: string): Promise<string | null> {
  if (!FORGEJO_URL || !FORGEJO_TOKEN) return null; // optional in dev
  const res = await fetch(`${FORGEJO_URL}/api/v1/user/repos`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `token ${FORGEJO_TOKEN}` },
    body: JSON.stringify({ name: slug, private: false, auto_init: true }),
  });
  if (!res.ok && res.status !== 409 && res.status !== 422) {
    throw new Error(`forgejo create repo failed: ${res.status} ${await res.text()}`);
  }
  return slug;
}

/**
 * Per-company mailbox address. With Stalwart configured, creates a real JMAP
 * mailbox (inbound + outbound). With just MAIL_DOMAIN set, assigns the address
 * so Resend can send outbound from {slug}@{domain} (requires the domain to be
 * verified in Resend). Both paths are idempotent under Temporal retries.
 */
export async function provisionMailbox(input: {
  companyId: string;
  slug: string;
  name: string;
}): Promise<string | null> {
  const cfg = stalwartEnv();
  const mailDomain = cfg?.domain ?? process.env.MAIL_DOMAIN;
  if (!mailDomain) return null;

  const address = `${input.slug}@${mailDomain}`;

  if (cfg) {
    const admin = new StalwartAdmin(cfg.url, cfg.adminUser, cfg.adminSecret);
    await admin.ensureDomain(cfg.domain);
    await admin.ensureMailbox(address, deriveMailboxPassword(cfg.masterSecret, address), input.name);
  }

  await sql`UPDATE companies SET email_address = ${address} WHERE id = ${input.companyId}`;
  await ledger.append({
    companyId: input.companyId,
    actor: "system",
    eventType: "mailbox_provisioned",
    payload: { address, transport: cfg ? "stalwart" : "resend" },
  });
  return address;
}

/**
 * Per-company secret vault (§6 step 2: "create Infisical project + machine
 * identity"). Provisions the company's folder so the owner can store keys
 * (Stripe, BYO enrichment) that capability providers resolve at runtime.
 * Idempotent (folder creation swallows "already exists"); optional in dev
 * (no INFISICAL_URL → secrets resolve from env instead).
 */
export async function provisionSecrets(companyId: string): Promise<boolean> {
  const cfg = infisicalEnv();
  if (!cfg) return false; // optional in dev
  const admin = new InfisicalAdmin(new InfisicalClient(cfg));
  await admin.ensureCompanyFolder(companyId);
  await ledger.append({
    companyId,
    actor: "system",
    eventType: "secrets_provisioned",
    payload: { backend: "infisical", path: `/companies/${companyId}` },
  });
  return true;
}

export async function createUmamiSite(slug: string, name: string): Promise<string | null> {
  if (!UMAMI_URL || !UMAMI_TOKEN) return null; // optional in dev
  const headers = { "content-type": "application/json", authorization: `Bearer ${UMAMI_TOKEN}` };
  const domain = `${slug}.${DOMAIN}`;
  const list = await fetch(`${UMAMI_URL}/api/websites?query=${domain}`, { headers });
  if (list.ok) {
    const { data } = (await list.json()) as { data: { id: string; domain: string }[] };
    const hit = data?.find((w) => w.domain === domain);
    if (hit) return hit.id;
  }
  const res = await fetch(`${UMAMI_URL}/api/websites`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, domain }),
  });
  if (!res.ok) throw new Error(`umami create site failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

export async function recordProvisioning(input: {
  companyId: string;
  repo: string | null;
  umamiSiteId: string | null;
}): Promise<void> {
  await sql`
    UPDATE companies
    SET forgejo_repo = COALESCE(${input.repo}, forgejo_repo),
        umami_site_id = COALESCE(${input.umamiSiteId}, umami_site_id)
    WHERE id = ${input.companyId}`;
}

export async function deployLanding(input: {
  companyId: string;
  spec: CompanySpec;
  umamiSiteId: string | null;
}): Promise<{ url: string }> {
  const { spec } = input;
  const res = await fetch(`${DEPLOYD_URL}/deploy/landing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: spec.slug,
      companyName: spec.name,
      emailAddress: `${spec.slug}@${DOMAIN}`,
      umamiSiteId: input.umamiSiteId ?? undefined,
      copy: spec.landing_copy,
    }),
  });
  if (!res.ok) throw new Error(`deployd failed: ${res.status} ${await res.text()}`);
  return { url: ((await res.json()) as { url: string }).url };
}

/** Seed a fixed list of tasks, deduped by title (so Temporal retries don't double-queue). */
async function seedTaskList(
  companyId: string,
  tasks: { title: string; description: string; priority: number }[],
): Promise<void> {
  for (const t of tasks) {
    await sql`
      INSERT INTO tasks (company_id, title, description, status, priority)
      SELECT ${companyId}, ${t.title}, ${t.description}, 'queued', ${t.priority}
      WHERE NOT EXISTS (
        SELECT 1 FROM tasks WHERE company_id = ${companyId} AND title = ${t.title}
      )`;
  }
}

/**
 * §6/§10 — seed the deterministic week-1 launch playbook (no LLM tokens). Replaces
 * the founding LLM's `initial_tasks`; the CEO plans real work from heartbeat 2.
 */
export async function seedLaunchPlaybook(input: { companyId: string; spec: CompanySpec }): Promise<void> {
  await seedTaskList(input.companyId, launchPlaybook(input.spec));
}

/** Legacy: seed the spec's LLM-generated tasks (offline fallback still provides them). */
export async function seedTasks(input: { companyId: string; spec: CompanySpec }): Promise<void> {
  await seedTaskList(input.companyId, input.spec.initial_tasks ?? []);
}

/**
 * Deterministic starter commerce (§6, §14) — seed a starter product + a *paused*
 * local ads campaign at creation, before any CEO work, so the company launches
 * already equipped to sell. Nothing spends or charges until the owner/CEO
 * activates it (the campaign starts paused; the product is just a listing).
 * Idempotent: a no-op once a starter product exists.
 */
export async function seedStarterCommerce(input: { companyId: string; spec: CompanySpec }): Promise<void> {
  const { companyId, spec } = input;
  const productId = randomUUID();
  const campaignId = randomUUID();
  const priceCents = Number(process.env.STARTER_PRODUCT_CENTS ?? 2900); // default tier; CEO can reprice
  const budgetCents = Number(process.env.STARTER_AD_DAILY_CENTS ?? 500); // daily budget; campaign is paused
  const paymentLink = `${CHECKOUT_BASE}/pay/${spec.slug}/${productId}`;
  const creative = {
    headline: spec.landing_copy.headline,
    body: spec.landing_copy.subheadline || spec.mission.slice(0, 140),
    linkUrl: `${paymentLink}?c=${campaignId}`, // ?c tag → ROAS attribution (§14)
  };
  const seeded = await sql.begin(async (tx) => {
    const [exists] = await tx`
      SELECT 1 FROM products WHERE company_id = ${companyId} AND provider_ref LIKE 'local:starter:%'`;
    if (exists) return false;
    await tx`
      INSERT INTO products (id, company_id, name, price_cents, currency, provider_ref, payment_link)
      VALUES (${productId}, ${companyId}, ${`${spec.name} — Starter`}, ${priceCents}, 'eur',
              ${`local:starter:${productId}`}, ${paymentLink})`;
    await tx`
      INSERT INTO ad_campaigns
        (id, company_id, product_id, provider, status, name, objective, budget_cents, budget_type, creative)
      VALUES (${campaignId}, ${companyId}, ${productId}, 'local', 'paused', 'Starter campaign',
              'OUTCOME_SALES', ${budgetCents}, 'daily', ${tx.json(creative)})`;
    return true;
  });
  if (seeded) {
    await ledger.append({
      companyId,
      actor: "system",
      eventType: "starter_commerce_seeded",
      payload: { productId, priceCents, paymentLink, campaignId, campaignStatus: "paused", budgetCents },
    });
  }
}

export async function appendLedger(input: LedgerEventInput): Promise<void> {
  await ledger.append(input);
}

/** §6 step 4 — schedule the company's daily autonomous heartbeat (§1 feature 5). */
export async function scheduleHeartbeat(companyId: string): Promise<{ scheduleId: string }> {
  const { scheduleId, created } = await ensureHeartbeatSchedule(companyId);
  if (created) {
    await ledger.append({
      companyId,
      actor: "system",
      eventType: "heartbeat_scheduled",
      payload: { scheduleId, cron: process.env.HEARTBEAT_CRON ?? "0 7 * * *" },
    });
  }
  return { scheduleId };
}
