import postgres from "postgres";
import { signToken } from "@opencorp/mcp-client";
import { runWorkerTask } from "@opencorp/agentd";
import { Ledger, PgStore } from "@opencorp/ledgerd";

/** TaskRun + CompanyHeartbeat activities (§5.2, §5.3). */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3004";

const sql = postgres(DATABASE_URL, { max: 5 });
const ledger = new Ledger(new PgStore(DATABASE_URL));

export interface TaskRow {
  id: string;
  company_id: string;
  conglomerate_id: string;
  title: string;
  description: string;
  name: string;
  slug: string;
  mission: string;
}

async function taskRow(taskId: string): Promise<TaskRow> {
  const [t] = await sql<TaskRow[]>`
    SELECT t.id, t.company_id, c.conglomerate_id, t.title, t.description,
           c.name, c.slug, c.mission
    FROM tasks t JOIN companies c ON c.id = t.company_id
    WHERE t.id = ${taskId}`;
  if (!t) throw new Error(`task not found: ${taskId}`);
  return t;
}

export async function creditBalance(conglomerateId: string): Promise<number> {
  const [r] = await sql<{ balance: string }[]>`
    SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_entries
    WHERE conglomerate_id = ${conglomerateId}`;
  return Number(r!.balance);
}

/** Charge estimated credits up front; balance must stay non-negative (§4). */
export async function chargeTask(taskId: string, estimate = 1): Promise<void> {
  const t = await taskRow(taskId);
  const balance = await creditBalance(t.conglomerate_id);
  if (balance < estimate) throw new Error("insufficient_credits");
  await sql`
    INSERT INTO credit_entries (conglomerate_id, company_id, task_id, delta, reason)
    VALUES (${t.conglomerate_id}, ${t.company_id}, ${taskId}, ${-estimate}, 'task_charge')`;
  await ledger.append({
    companyId: t.company_id,
    actor: "system",
    eventType: "credit_change",
    payload: { taskId, delta: -estimate, reason: "task_charge" },
  });
}

/** Failed tasks are made whole: compensating entry for everything charged (§5.3). */
export async function refundTask(taskId: string): Promise<void> {
  const t = await taskRow(taskId);
  const [charged] = await sql<{ total: string }[]>`
    SELECT COALESCE(-SUM(delta), 0) AS total FROM credit_entries
    WHERE task_id = ${taskId} AND reason = 'task_charge'`;
  const [refunded] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(delta), 0) AS total FROM credit_entries
    WHERE task_id = ${taskId} AND reason = 'task_refund'`;
  const due = Number(charged!.total) - Number(refunded!.total);
  if (due <= 0) return; // idempotent under Temporal retries
  await sql`
    INSERT INTO credit_entries (conglomerate_id, company_id, task_id, delta, reason)
    VALUES (${t.conglomerate_id}, ${t.company_id}, ${taskId}, ${due}, 'task_refund')`;
  await ledger.append({
    companyId: t.company_id,
    actor: "system",
    eventType: "credit_change",
    payload: { taskId, delta: due, reason: "task_refund" },
  });
}

export async function setTaskState(
  taskId: string,
  status: "running" | "done" | "failed",
  fields?: { resultSummary?: string; error?: string },
): Promise<void> {
  await sql`
    UPDATE tasks SET status = ${status},
      result_summary = COALESCE(${fields?.resultSummary ?? null}, result_summary),
      error = COALESCE(${fields?.error ?? null}, error),
      started_at = CASE WHEN ${status} = 'running' THEN now() ELSE started_at END,
      finished_at = CASE WHEN ${status} IN ('done','failed') THEN now() ELSE finished_at END
    WHERE id = ${taskId}`;
  const t = await taskRow(taskId);
  await ledger.append({
    companyId: t.company_id,
    actor: "system",
    eventType: "task_state",
    payload: { taskId, title: t.title, status, ...fields },
  });
}

/** The agent loop runs in-process for M2; M4 moves it into a sandbox claim. */
export async function runWorker(taskId: string): Promise<{ summary: string; steps: number }> {
  const t = await taskRow(taskId);
  const token = signToken({
    companyId: t.company_id,
    taskId,
    exp: Math.floor(Date.now() / 1000) + 35 * 60,
  });
  return runWorkerTask({
    gatewayUrl: GATEWAY_URL,
    token,
    task: { id: t.id, title: t.title, description: t.description },
    company: { name: t.name, slug: t.slug, mission: t.mission },
    budgets: { maxSteps: 80, maxWallClockMs: 30 * 60_000 },
  });
}

// ── Heartbeat helpers ──────────────────────────────────────────────────────

export interface DispatchDecision {
  taskId: string | null;
  reason: string;
}

/** Pop the next dispatchable task under cap semantics (§5.2). */
export async function pickNextTask(companyId: string): Promise<DispatchDecision> {
  const [c] = await sql<
    { status: string; daily_task_cap: number; conglomerate_id: string; daily_credit_cap: string }[]
  >`SELECT c.status, c.daily_task_cap, c.conglomerate_id, g.daily_credit_cap
    FROM companies c JOIN conglomerates g ON g.id = c.conglomerate_id
    WHERE c.id = ${companyId}`;
  if (!c) return { taskId: null, reason: "company_not_found" };
  if (c.status !== "active") return { taskId: null, reason: "company_paused" };

  const [running] = await sql`
    SELECT 1 FROM tasks WHERE company_id = ${companyId} AND status = 'running'`;
  if (running) return { taskId: null, reason: "task_already_running" };

  const [startedToday] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM tasks
    WHERE company_id = ${companyId} AND started_at > now() - interval '24 hours'`;
  if (Number(startedToday!.n) >= c.daily_task_cap)
    return { taskId: null, reason: "daily_task_cap_reached" };

  const [spent] = await sql<{ n: string }[]>`
    SELECT COALESCE(-SUM(delta), 0) AS n FROM credit_entries
    WHERE conglomerate_id = ${c.conglomerate_id} AND reason = 'task_charge'
      AND created_at > now() - interval '24 hours'`;
  if (Number(spent!.n) >= Number(c.daily_credit_cap))
    return { taskId: null, reason: "daily_credit_cap_reached" };

  const [next] = await sql<{ id: string }[]>`
    SELECT id FROM tasks
    WHERE company_id = ${companyId} AND status = 'queued'
      AND (scheduled_for IS NULL OR scheduled_for <= now())
    ORDER BY priority DESC, created_at LIMIT 1`;
  return next ? { taskId: next.id, reason: "ok" } : { taskId: null, reason: "queue_empty" };
}

export async function postDailyBrief(companyId: string, brief: string): Promise<void> {
  await ledger.append({
    companyId,
    actor: "ceo",
    eventType: "daily_brief",
    payload: { brief },
  });
}
