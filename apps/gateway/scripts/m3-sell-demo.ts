/**
 * M3 exit test (§14): a company sells a digital product end-to-end with zero
 * human action after the initial prompt, every step on the public ledger.
 *
 * Drives the *real* pipeline against the live dev DB + deployd:
 *   1. provision a demo company (active, supervised, with a mailbox + credits)
 *   2. run the worker's scripted sell flow through the MCP gateway over HTTP:
 *      create_product → get_payment_link → deploy storefront → announce by email
 *   3. an *external* customer pays — POST the signed payment webhook
 *   4. assert revenue mirrored + ledger has product_created/email_sent/money_in
 *      and the hash chain still verifies.
 *
 * Run with the dev stack up:  bun apps/gateway/scripts/m3-sell-demo.ts
 */
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import { createGateway } from "../src/app";
import { signToken } from "@opencorp/mcp-client";
import { runWorkerTask } from "@opencorp/agentd";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ── 1. provision a fresh demo company ────────────────────────────────────
  const slug = `m3demo-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo-user', 'M3 Demo Conglomerate', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'Pixel Press', 'Sell a polished digital wallpaper pack.',
            'active', 'supervised', ${`${slug}@opencorp.app`}, ${`${slug}.localhost`})
    RETURNING id`;
  await sql`INSERT INTO credit_entries (conglomerate_id, company_id, delta, reason)
            VALUES (${cg!.id}, ${co!.id}, '100', 'grant')`;
  console.log(`Provisioned company ${slug} (${co!.id})`);

  // ── 2. start the gateway in-process against the live DB ──────────────────
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const gatewayUrl = `http://localhost:${server.port}`;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  // ── 3. run the autonomous worker (scripted policy, no LLM) ────────────────
  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, company_id, title, description, status)
            VALUES (${taskId}, ${co!.id}, 'Launch and sell our first product', 'Monetize the wallpaper pack.', 'running')`;
  const token = signToken({ companyId: co!.id, taskId, exp: Math.floor(Date.now() / 1000) + 600 });
  const result = await runWorkerTask({
    gatewayUrl,
    token,
    task: { id: taskId, title: "Launch and sell our first product", description: "Monetize the wallpaper pack." },
    company: { name: "Pixel Press", slug, mission: "Sell a polished digital wallpaper pack." },
    onStep: (s) => console.log(`  · step ${s.n}: ${s.thought}${s.tool ? ` [${s.tool}]` : ""}`),
  });
  console.log(`Worker finished: ${result.summary}`);

  const [product] = await sql<{ id: string; provider_ref: string }[]>`
    SELECT id, provider_ref FROM products WHERE company_id = ${co!.id} LIMIT 1`;
  ok(product, "product was created");

  // ── 4. an external customer pays (signed webhook) ────────────────────────
  const body = JSON.stringify({
    companyId: co!.id,
    productId: product!.id,
    amountCents: 1900,
    currency: "eur",
    providerRef: `demo-charge-${randomUUID()}`,
    feeCents: 85,
  });
  const sig = createHmac("sha256", GATEWAY_SECRET).update(body).digest("hex");
  const webhook = await fetch(`${gatewayUrl}/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sig },
    body,
  });
  ok(webhook.ok, `payment webhook accepted (${webhook.status})`);
  ok((await webhook.json()).recorded === true, "payment recorded (idempotent)");

  // ── 5. assertions: revenue + ledger transparency + chain integrity ───────
  const [c] = await sql<{ real_balance_cents: string }[]>`
    SELECT real_balance_cents FROM companies WHERE id = ${co!.id}`;
  ok(Number(c!.real_balance_cents) === 1815, `real balance mirrored net of fees (€18.15) — got ${c!.real_balance_cents}`);

  const events = await sql<{ event_type: string }[]>`
    SELECT event_type FROM ledger_events WHERE company_id = ${co!.id} AND seq > ${seqBefore}`;
  const types = new Set(events.map((e) => e.event_type));
  for (const t of ["product_created", "deploy", "email_sent", "money_in"])
    ok(types.has(t), `ledger has a ${t} event`);

  const verify = await ledger.verify(1);
  ok(verify.ok, `hash chain verifies (${verify.checked} events)`);

  // §7.3 safety gate: an irreversible tool is refused under supervised autonomy.
  const gated = await fetch(`${gatewayUrl}/tools/payments/delete_product`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ productId: product!.id }),
  });
  ok(gated.status === 403, `delete_product gated under supervised autonomy (${gated.status})`);
  ok((await gated.json()).error === "approval_required", "gate returns approval_required");

  server.stop();
  await sql.end();
  console.log("\nM3 exit test PASSED — product sold end-to-end, fully on the ledger.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
