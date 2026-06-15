import type postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import { registry, type ToolContext } from "./tools";
import type { SecretStore } from "./secrets";
import { emailFor, listUnsubscribeHeader } from "./providers/email";

/**
 * Human-in-the-loop approvals (§7.3, §15). A gated tool call by an agent on a
 * company below autonomy_level=full doesn't execute and doesn't block — it parks
 * here as 'pending' and the agent moves on. An owner later approves (the gateway
 * then executes the very same handler, gateway-side, so no worker need be alive)
 * or rejects. Every transition is on the public ledger.
 */
export interface RequestApprovalInput {
  companyId: string;
  taskId: string | null;
  server: string;
  tool: string;
  args: unknown;
}

export async function requestApproval(
  sql: postgres.Sql,
  ledger: Ledger,
  input: RequestApprovalInput,
): Promise<{ approvalId: string; reused: boolean }> {
  // Reuse an open request for the identical action so a retrying agent doesn't
  // pile up duplicate approvals.
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM approvals
    WHERE company_id = ${input.companyId} AND status = 'pending'
      AND server = ${input.server} AND tool = ${input.tool}
      AND args = ${sql.json(input.args as never)}
    LIMIT 1`;
  if (existing) return { approvalId: existing.id, reused: true };

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO approvals (company_id, task_id, server, tool, args)
    VALUES (${input.companyId}, ${input.taskId}, ${input.server}, ${input.tool},
            ${sql.json(input.args as never)})
    RETURNING id`;
  const def = registry[input.server]?.[input.tool];
  await ledger.append({
    companyId: input.companyId,
    actor: input.taskId ? `worker:${input.taskId}` : "system",
    eventType: "approval_requested",
    payload: {
      approvalId: row!.id,
      server: input.server,
      tool: input.tool,
      args: def?.summarizeArgs ? def.summarizeArgs(input.args as never) : input.args,
    },
  });
  return { approvalId: row!.id, reused: false };
}

/**
 * Pull the owner in out-of-band (§7.3): email them the moment an action is
 * parked, from the company's own mailbox to their account email, via Stalwart.
 * Best effort and self-degrading — no owner email, no company mailbox, or no
 * mail server configured ⇒ a no-op (the in-app brief + dashboard still surface
 * it). Records an `approval_notified` ledger event when an email goes out.
 */
export async function notifyOwnerOfApproval(
  sql: postgres.Sql,
  ledger: Ledger,
  secrets: SecretStore,
  input: { companyId: string; approvalId: string; server: string; tool: string },
): Promise<{ notified: boolean; reason?: string }> {
  const [row] = await sql<
    { company_name: string; email_address: string | null; slug: string; owner_email: string | null }[]
  >`
    SELECT c.name AS company_name, c.email_address, c.slug, u.email AS owner_email
    FROM companies c
    JOIN conglomerates g ON g.id = c.conglomerate_id
    LEFT JOIN "user" u ON u.id = g.owner_user_id
    WHERE c.id = ${input.companyId}`;
  if (!row?.owner_email) return { notified: false, reason: "no_owner_email" };
  if (!row.email_address) return { notified: false, reason: "no_mailbox" };

  const provider = await emailFor(input.companyId, secrets, row.email_address);
  if (provider.kind !== "stalwart") return { notified: false, reason: "email_not_configured" };

  const dashUrl = `${(process.env.DASHBOARD_URL ?? "https://opencorp.app").replace(/\/$/, "")}/c/${row.slug}`;
  await provider.send({
    from: row.email_address,
    to: [row.owner_email],
    subject: `Approval needed — ${row.company_name} wants to run ${input.tool}`,
    text:
      `Your autonomous company ${row.company_name} wants to run an irreversible action:\n\n` +
      `    ${input.server}.${input.tool}\n\n` +
      `It is paused, awaiting your decision. Approve or reject it from the dashboard:\n${dashUrl}\n\n` +
      `If you do nothing, the request expires and is treated as rejected.\n\n— OpenCorp`,
    headers: listUnsubscribeHeader(row.email_address),
  });
  await ledger.append({
    companyId: input.companyId,
    actor: "system",
    eventType: "approval_notified",
    payload: { approvalId: input.approvalId, server: input.server, tool: input.tool, channel: "email" },
  });
  return { notified: true };
}

export type ApprovalDecision = "approve" | "reject";

export interface ResolveResult {
  approvalId: string;
  status: "approved" | "rejected" | "pending";
  alreadyResolved?: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Resolve a pending approval. Reject marks it and stops; approve runs the stored
 * tool handler gateway-side and records the result. Idempotent: resolving an
 * already-decided approval returns its current state without re-executing.
 */
export async function resolveApproval(
  sql: postgres.Sql,
  ledger: Ledger,
  buildCtx: (companyId: string, taskId: string) => ToolContext,
  input: { id: string; decision: ApprovalDecision; decidedBy?: string },
): Promise<ResolveResult | { error: "not_found" }> {
  const [a] = await sql<
    { id: string; company_id: string; task_id: string | null; server: string; tool: string; args: unknown; status: string }[]
  >`SELECT id, company_id, task_id, server, tool, args, status FROM approvals WHERE id = ${input.id}`;
  if (!a) return { error: "not_found" };
  if (a.status !== "pending") {
    return { approvalId: a.id, status: a.status as ResolveResult["status"], alreadyResolved: true };
  }

  if (input.decision === "reject") {
    await sql`UPDATE approvals SET status = 'rejected', decided_by = ${input.decidedBy ?? null}, decided_at = now() WHERE id = ${a.id}`;
    await ledger.append({
      companyId: a.company_id,
      actor: "user",
      eventType: "approval_resolved",
      payload: { approvalId: a.id, server: a.server, tool: a.tool, decision: "rejected" },
    });
    return { approvalId: a.id, status: "rejected" };
  }

  // approve → execute the stored action, gateway-side
  const def = registry[a.server]?.[a.tool];
  if (!def) {
    await sql`UPDATE approvals SET status = 'rejected', error = 'unknown_tool', decided_by = ${input.decidedBy ?? null}, decided_at = now() WHERE id = ${a.id}`;
    return { approvalId: a.id, status: "rejected", error: "unknown_tool" };
  }
  const parsed = def.schema.safeParse(a.args);
  if (!parsed.success) {
    await sql`UPDATE approvals SET status = 'rejected', error = 'invalid_args', decided_by = ${input.decidedBy ?? null}, decided_at = now() WHERE id = ${a.id}`;
    return { approvalId: a.id, status: "rejected", error: "invalid_args" };
  }

  const auditArgs = def.summarizeArgs ? def.summarizeArgs(parsed.data as never) : parsed.data;
  const ctx = buildCtx(a.company_id, a.task_id ?? "");
  try {
    const result = await def.handler(ctx, parsed.data as never);
    await sql`UPDATE approvals SET status = 'approved', result = ${sql.json((result ?? {}) as never)}, decided_by = ${input.decidedBy ?? null}, decided_at = now() WHERE id = ${a.id}`;
    await ledger.append({
      companyId: a.company_id,
      actor: "user",
      eventType: "approval_resolved",
      payload: { approvalId: a.id, server: a.server, tool: a.tool, decision: "approved" },
    });
    await ledger.append({
      companyId: a.company_id,
      actor: "user",
      eventType: "tool_call",
      payload: { server: a.server, tool: a.tool, args: auditArgs, outcome: "ok", viaApproval: a.id },
    });
    return { approvalId: a.id, status: "approved", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sql`UPDATE approvals SET status = 'approved', error = ${message}, decided_by = ${input.decidedBy ?? null}, decided_at = now() WHERE id = ${a.id}`;
    await ledger.append({
      companyId: a.company_id,
      actor: "user",
      eventType: "approval_resolved",
      payload: { approvalId: a.id, server: a.server, tool: a.tool, decision: "approved", error: message },
    });
    return { approvalId: a.id, status: "approved", error: message };
  }
}
