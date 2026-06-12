import postgres from "postgres";
import { heartbeat } from "@temporalio/activity";
import { signToken } from "@opencorp/mcp-client";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { createSandboxPool } from "@opencorp/sandboxd";
import { syncInboxFromEnv } from "@opencorp/stalwart";
import {
  DEPARTMENT_KEYS,
  fallbackDepartment,
  llmConfigFromEnv,
  planDepartment,
  planHeartbeat,
  tracerFromEnv,
  type DepartmentReport,
} from "@opencorp/llm";
import {
  applyCeoPlan,
  ceoCompany,
  ensureDepartmentAgents,
  gatherCeoContext,
  loadCeoPrompt,
  loadDepartmentPrompt,
} from "./ceo";

/** TaskRun + CompanyHeartbeat activities (§5.2, §5.3). */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3004";

const sql = postgres(DATABASE_URL, { max: 5 });
const ledger = new Ledger(new PgStore(DATABASE_URL));

// Execution-plane pool (§8), selected by SANDBOX_KIND: `local` (in-process,
// dev/tests), `subprocess` (separate OS process — real isolation, the prod
// default off bare metal), or `firecracker` (snapshot-restored microVMs on
// KVM). The agent loop is identical across all three. One sandbox per task,
// never reused (§5.3).
const sandboxes = createSandboxPool();

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

/** Claim a sandbox, run the agent loop inside it, release it (§8, §5.3). */
export async function runWorker(taskId: string): Promise<{ summary: string; steps: number }> {
  const t = await taskRow(taskId);
  const token = signToken({
    companyId: t.company_id,
    taskId,
    exp: Math.floor(Date.now() / 1000) + 35 * 60,
  });
  // §5.3 hard budgets; WORKER_MAX_STEPS lets cost-sensitive runs (real-LLM
  // smoke tests) cap the loop below the default without touching the contract
  const budgets = {
    maxSteps: Number(process.env.WORKER_MAX_STEPS ?? 80),
    maxWallClockMs: 30 * 60_000,
  };
  // §9.2: the Langfuse trace id is the task id — recorded up front so the
  // public page links to the trace even for failed/timed-out tasks.
  await sql`UPDATE tasks SET trace_id = ${taskId} WHERE id = ${taskId}`;
  const sandbox = await sandboxes.claim({ taskId, companyId: t.company_id, budgets });
  try {
    return await sandbox.execAgent(
      {
        gatewayUrl: GATEWAY_URL,
        token,
        task: { id: t.id, title: t.title, description: t.description },
        company: { name: t.name, slug: t.slug, mission: t.mission },
        budgets,
        traceId: taskId,
      },
      // §5.3 "every step streamed": step events come back from the sandbox
      // (in-process, pipe, or vsock) and on this side become a Temporal
      // heartbeat (long LLM tasks must outlive the 2-min heartbeatTimeout) and a
      // ledger event — the dashboard terminal renders the worker thinking.
      (step) => {
        try {
          heartbeat(step.n);
        } catch {
          /* outside an activity context (direct invocation in tests) */
        }
        void ledger
          .append({
            companyId: t.company_id,
            actor: `worker:${taskId}`,
            eventType: "worker_step",
            payload: { n: step.n, thought: step.thought, ...(step.tool ? { tool: step.tool } : {}) },
          })
          .catch(() => {});
      },
    );
  } finally {
    await sandbox.release();
  }
}

// ── Heartbeat helpers ──────────────────────────────────────────────────────

/**
 * §5.2 steps 1–3 + §14 M5 departments: gather context → CMO/CTO/CFO
 * sub-planners propose in parallel (each on the ledger) → frontier-tier CEO
 * synthesis (deterministic fallback offline) → create tasks / patch mission,
 * all on the ledger. Idempotent under Temporal retries: task creation dedupes
 * by open title, plan events are advisory. Planning is free — C-suite thinking
 * never charges credits.
 */
export async function runCeoPlanning(companyId: string): Promise<{ userBrief: string }> {
  const company = await ceoCompany(sql, companyId);
  // §5.2 step 1: pull fresh inbound mail into the mirror before gathering the
  // unread-inbox digest. Best effort — a mail-server hiccup never blocks the
  // heartbeat (the digest then reads the existing mirror).
  await syncInboxFromEnv(sql, ledger, companyId).catch(() => {});
  const ctx = await gatherCeoContext(sql, company);
  const { system, hash } = loadCeoPrompt(company);

  const cfg = llmConfigFromEnv();
  const tracer = tracerFromEnv();
  const day = new Date().toISOString().slice(0, 10);

  // Department fan-out. A department LLM failure degrades to its deterministic
  // fallback — one flaky sub-planner must never block the heartbeat.
  await ensureDepartmentAgents(sql, companyId);
  const reports: DepartmentReport[] = await Promise.all(
    DEPARTMENT_KEYS.map(async (dept) => {
      const prompt = loadDepartmentPrompt(dept, company);
      let report: DepartmentReport;
      let degraded: string | undefined;
      try {
        report = await planDepartment(
          cfg,
          prompt.system,
          dept,
          ctx,
          tracer ? { tracer, traceId: `dept-${dept}-${companyId}-${day}`, name: `${dept}-plan` } : undefined,
        );
      } catch (err) {
        degraded = err instanceof Error ? err.message : String(err);
        report = fallbackDepartment(dept, ctx);
      }
      await ledger.append({
        companyId,
        actor: `dept:${dept}`,
        eventType: "department_plan",
        payload: {
          headline: report.headline,
          observations: report.observations,
          proposedTasks: report.proposed_tasks.map((t) => t.title),
          promptHash: prompt.hash,
          ...(degraded ? { degradedToFallback: degraded } : {}),
        },
      });
      return report;
    }),
  );

  const traceId = `ceo-${companyId}-${day}`;
  const plan = await planHeartbeat(
    cfg,
    system,
    ctx,
    tracer ? { tracer, traceId, name: "heartbeat-plan" } : undefined,
    reports,
  );
  await tracer?.flush();

  const applied = await applyCeoPlan(sql, ledger, company, plan, {
    promptHash: hash,
    source: "heartbeat",
  });
  await ledger.append({
    companyId,
    actor: "ceo",
    eventType: "ceo_plan",
    payload: {
      keepDoing: plan.keep_doing,
      stopDoing: plan.stop_doing,
      createdTasks: applied.createdTasks,
      missionUpdated: applied.missionUpdated,
      promptHash: hash,
      departments: Object.fromEntries(
        reports.map((r) => [r.department, { headline: r.headline, proposed: r.proposed_tasks.length }]),
      ),
      ...(tracer?.publicUrl(traceId) ? { traceUrl: tracer.publicUrl(traceId) } : {}),
    },
  });
  return { userBrief: plan.user_brief };
}

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
