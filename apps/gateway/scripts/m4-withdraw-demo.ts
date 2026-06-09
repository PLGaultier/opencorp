/**
 * M4 money-out: close the financial loop. A company earns revenue (M3) and then
 * the owner withdraws it (§10) — debited from real balance, paid out via the
 * provider, recorded as a money_out event on the ledger, and the whole chain
 * passes the redaction audit (§9.3).
 *
 * Hits the gateway's signed /admin/withdraw directly (the durable Withdrawal
 * workflow is a thin wrapper around the same call). Run with the dev stack up:
 *   bun apps/gateway/scripts/m4-withdraw-demo.ts
 */
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import { createGateway } from "../src/app";
import { auditChain, PgStore } from "@opencorp/ledgerd";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
const sign = (raw: string) => createHmac("sha256", GATEWAY_SECRET).update(raw).digest("hex");

async function main() {
  const slug = `m4w-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name) VALUES ('demo', 'M4 Withdraw') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, real_balance_cents)
    VALUES (${cg!.id}, ${slug}, 'Cashflow Co', 'Earn then withdraw.', 5000) RETURNING id`;
  console.log(`Company ${slug} starts with €50.00 balance`);

  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const base = `http://localhost:${server.port}`;

  // ── withdraw €30.00 ───────────────────────────────────────────────────────
  const withdrawalId = randomUUID();
  const body = JSON.stringify({ withdrawalId, companyId: co!.id, amountCents: 3000, currency: "eur" });
  const res = await fetch(`${base}/admin/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sign(body) },
    body,
  });
  const result = await res.json();
  ok(res.ok && result.status === "paid", `withdrawal paid (${result.status}, transfer ${result.transferId})`);

  const [c1] = await sql<{ real_balance_cents: string }[]>`SELECT real_balance_cents FROM companies WHERE id = ${co!.id}`;
  ok(Number(c1!.real_balance_cents) === 2000, `balance debited to €20.00 — got ${c1!.real_balance_cents}`);
  const [w] = await sql<{ status: string }[]>`SELECT status FROM withdrawals WHERE id = ${withdrawalId}`;
  ok(w!.status === "paid", "withdrawals row marked paid");
  const [mo] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM ledger_events WHERE company_id = ${co!.id} AND event_type = 'money_out'`;
  ok(Number(mo!.n) === 1, "money_out event on the ledger");

  // ── idempotency + overdraw guard ─────────────────────────────────────────
  const replay = await fetch(`${base}/admin/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sign(body) },
    body,
  });
  ok((await replay.json()).status === "already_done", "replayed withdrawal is idempotent (no double-pay)");
  const [c2] = await sql<{ real_balance_cents: string }[]>`SELECT real_balance_cents FROM companies WHERE id = ${co!.id}`;
  ok(Number(c2!.real_balance_cents) === 2000, "balance unchanged after replay");

  const overBody = JSON.stringify({ withdrawalId: randomUUID(), companyId: co!.id, amountCents: 999999, currency: "eur" });
  const over = await fetch(`${base}/admin/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sign(overBody) },
    body: overBody,
  });
  ok(over.status === 422 && (await over.json()).reason === "insufficient_balance", "overdraw rejected");

  // ── transparency: full chain still verifies and passes redaction audit ────
  const verify = await ledger.verify(1);
  ok(verify.ok, `hash chain verifies (${verify.checked} events)`);
  const store = new PgStore(DATABASE_URL);
  const audit = await auditChain(store, 1);
  await store.close();
  ok(audit.violations.length === 0, `redaction audit clean (${audit.scanned} events, 0 leaks)`);

  server.stop();
  await sql.end();
  console.log("\nM4 money-out PASSED — earn → withdraw → verifiable ledger, audit clean.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
