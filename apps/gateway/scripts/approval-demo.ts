/**
 * Human-in-the-loop approval exit test (§7.3, §15): a gated tool call by an
 * agent on a company below autonomy_level=full doesn't execute — it parks as a
 * pending approval; an owner rejects or approves it (the gateway then runs the
 * action). Drives the real pipeline against the live dev DB:
 *
 *   docker compose -f infra/compose/docker-compose.dev.yml up -d postgres
 *   bun apps/gateway/scripts/approval-demo.ts
 */
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import { signToken } from "@opencorp/mcp-client";
import { createGateway } from "../src/app";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ── company (supervised → gated tools need approval) + a product to delete ─
  const slug = `apprco-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo', 'Approval Demo', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'GatedCo', 'Test approvals.', 'active', 'supervised', ${`${slug}@opencorp.dev`}, ${`${slug}.localhost`})
    RETURNING id`;
  const companyId = co!.id;

  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
  const gatewayUrl = `http://localhost:${server.port}`;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, company_id, title, description, status)
            VALUES (${taskId}, ${companyId}, 'Tidy the catalogue', 'Remove a product.', 'running')`;
  const token = signToken({ companyId, taskId, exp: Math.floor(Date.now() / 1000) + 600 });
  const callTool = async (server: string, tool: string, args: unknown) => {
    const res = await fetch(`${gatewayUrl}/tools/${server}/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const resolve = async (approvalId: string, decision: "approve" | "reject") => {
    const raw = JSON.stringify({ decision, decidedBy: "owner-user" });
    const sig = createHmac("sha256", GATEWAY_SECRET).update(raw).digest("hex");
    const res = await fetch(`${gatewayUrl}/admin/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencorp-sig": sig },
      body: raw,
    });
    return (await res.json()) as Record<string, any>;
  };
  const productExists = async (id: string) =>
    (await sql`SELECT 1 FROM products WHERE id = ${id}`).length > 0;

  // a product the agent will try to delete
  const created = await callTool("payments", "create_product", { name: "Sticker pack", priceCents: 500 });
  const productId: string = created.body.productId;
  ok(productId, "created a product to delete");

  // ── 1. agent calls a gated tool → parks as pending, does NOT execute ──────
  const attempt = await callTool("payments", "delete_product", { productId });
  ok(attempt.status === 403 && attempt.body.error === "approval_required", "gated delete_product returns approval_required");
  const approvalId: string = attempt.body.approvalId;
  ok(approvalId, "response carries an approvalId");
  ok(await productExists(productId), "product still exists — nothing executed yet");

  const [pending] = await sql<{ status: string }[]>`SELECT status FROM approvals WHERE id = ${approvalId}`;
  ok(pending?.status === "pending", "approval row is pending");

  // retrying the identical action reuses the same pending approval (idempotent)
  const again = await callTool("payments", "delete_product", { productId });
  ok(again.body.approvalId === approvalId, "identical retry reuses the pending approval (no pile-up)");

  // ── 2. owner rejects → action never runs ──────────────────────────────────
  const rejected = await resolve(approvalId, "reject");
  ok(rejected.status === "rejected", "owner reject resolves the approval");
  ok(await productExists(productId), "product still exists after rejection");
  const idem = await resolve(approvalId, "approve");
  ok(idem.alreadyResolved && idem.status === "rejected", "re-resolving a decided approval is a no-op (idempotent)");

  // ── 3. agent re-requests → owner approves → gateway executes it ────────────
  const second = await callTool("payments", "delete_product", { productId });
  const approval2: string = second.body.approvalId;
  ok(approval2 && approval2 !== approvalId, "a fresh request after rejection opens a new approval");

  const approved = await resolve(approval2, "approve");
  ok(approved.status === "approved", "owner approve resolves the approval");
  ok(approved.result?.deleted === true, "the gated handler ran on approval (deleted: true)");
  ok(!(await productExists(productId)), "product is now actually deleted");

  // ── 4. the ledger tells the whole story ───────────────────────────────────
  const events = await sql<{ event_type: string; payload: any }[]>`
    SELECT event_type, payload FROM ledger_events
    WHERE company_id = ${companyId} AND seq > ${seqBefore}
    ORDER BY seq`;
  const types = events.map((e) => e.event_type);
  ok(types.filter((t) => t === "approval_requested").length === 2, "two approval_requested events (reuse didn't double-log)");
  ok(
    events.some((e) => e.event_type === "approval_resolved" && e.payload.decision === "rejected") &&
      events.some((e) => e.event_type === "approval_resolved" && e.payload.decision === "approved"),
    "both resolutions on the ledger",
  );
  ok(
    events.some((e) => e.event_type === "tool_call" && e.payload.viaApproval === approval2),
    "the approved action's execution is audited (viaApproval)",
  );

  const verdict = await ledger.verify();
  ok(verdict.ok, `hash chain verifies (head seq ${(await ledger.head())?.seq})`);

  console.log("\nAPPROVAL DEMO PASSED — gated actions park for human review; approve executes, reject blocks, all on the ledger.");
  server.stop(true);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
