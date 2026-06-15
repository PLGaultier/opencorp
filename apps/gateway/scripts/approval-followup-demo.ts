/**
 * Approval follow-up exit test (§7.3): the human-in-the-loop only works if the
 * human is pulled in and the queue can't stall forever. This proves:
 *   1. stale pending approvals auto-expire (system rejection on the ledger)
 *   2. the CEO context surfaces live pending approvals + recent owner rejections
 *   3. the daily brief flags pending approvals to the owner
 *
 * Drives the real DB-backed helpers (no LLM/Temporal needed):
 *   docker compose -f infra/compose/docker-compose.dev.yml up -d postgres
 *   bun apps/gateway/scripts/approval-followup-demo.ts
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { ceoCompany, expireStaleApprovals, gatherCeoContext } from "@opencorp/workflows";
import { fallbackPlan } from "@opencorp/llm";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const sql = postgres(DATABASE_URL, { max: 4 });
const ledger = new Ledger(new PgStore(DATABASE_URL));

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const addApproval = (companyId: string, tool: string, ageHours: number, status = "pending", decidedBy: string | null = null) =>
  sql<{ id: string }[]>`
    INSERT INTO approvals (company_id, task_id, server, tool, args, status, decided_by, created_at, decided_at)
    VALUES (${companyId}, NULL, 'payments', ${tool}, ${sql.json({ productId: randomUUID() })}, ${status}, ${decidedBy},
            now() - make_interval(hours => ${ageHours}),
            ${status === "pending" ? null : sql`now()`})
    RETURNING id`;

async function main() {
  const slug = `apprfu-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap) VALUES ('demo','Approval FU','100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, email_address, subdomain, daily_task_cap)
    VALUES (${cg!.id}, ${slug}, 'StaleCo', 'Sell mugs.', 'active', 'supervised', ${`${slug}@opencorp.dev`}, ${`${slug}.localhost`}, 3)
    RETURNING id`;
  const companyId = co!.id;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  // a stale pending request (10 days old), a fresh one, and a recent owner reject
  const [stale] = await addApproval(companyId, "delete_product", 240);
  await addApproval(companyId, "set_custom_domain", 1);
  await addApproval(companyId, "delete_product", 5, "rejected", "owner-user");

  // ── 1. expiry: the 10-day-old request is auto-rejected; fresh one survives ─
  const n = await expireStaleApprovals(sql, ledger, 168); // 7-day TTL
  ok(n === 1, "expireStaleApprovals rejected exactly the one stale request");
  const [staleRow] = await sql<{ status: string; error: string }[]>`
    SELECT status, error FROM approvals WHERE id = ${stale!.id}`;
  ok(staleRow?.status === "rejected" && staleRow.error === "expired", "stale request is rejected with reason=expired");
  const [{ n: stillPending }] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM approvals WHERE company_id = ${companyId} AND status = 'pending'`;
  ok(Number(stillPending) === 1, "the fresh request is still pending");

  const expiredEvt = await sql`
    SELECT 1 FROM ledger_events WHERE company_id = ${companyId} AND event_type = 'approval_resolved'
      AND payload->>'reason' = 'expired' AND seq > ${seqBefore}`;
  ok(expiredEvt.length === 1, "the expiry is a system rejection on the ledger");

  // running it again is a no-op (nothing left stale)
  ok((await expireStaleApprovals(sql, ledger, 168)) === 0, "second run expires nothing (idempotent)");

  // ── 2. the CEO context now sees the live queue + the owner's rejection ────
  const company = await ceoCompany(sql, companyId);
  const ctx = await gatherCeoContext(sql, company);
  ok(ctx.pendingApprovals?.length === 1 && ctx.pendingApprovals[0]!.tool === "set_custom_domain",
    "CEO context lists the one live pending approval");
  ok(ctx.recentlyRejected?.includes("delete_product"),
    "CEO context flags the owner-rejected tool (don't re-propose)");

  // ── 3. the daily brief tells the owner there's something to approve ───────
  const brief = fallbackPlan(ctx).user_brief;
  ok(/1 action\(s\) await your approval/.test(brief), `brief flags the pending approval — "${brief.slice(0, 90)}…"`);

  const verdict = await ledger.verify();
  ok(verdict.ok, `hash chain verifies (head seq ${(await ledger.head())?.seq})`);

  console.log("\nAPPROVAL FOLLOW-UP PASSED — stale requests expire, the CEO sees the live queue, the owner is told.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
