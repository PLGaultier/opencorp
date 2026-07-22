import { createHmac } from "node:crypto";
import postgres from "postgres";
import { heartbeat } from "@temporalio/activity";
import { signToken } from "@opencorp/mcp-client";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { createSandboxPool } from "@opencorp/sandboxd";
import { syncInboxFromEnv } from "@opencorp/stalwart";
import {
  DEPARTMENT_KEYS,
  fallbackDepartment,
  fallbackPlan,
  llmConfigFromEnv,
  planDepartment,
  planHeartbeat,
  tierShiftForLevel,
  tracerFromEnv,
  type CeoPlan,
  type DepartmentReport,
} from "@opencorp/llm";
import {
  applyCeoPlan,
  ceoCompany,
  decayConglomerateLessons,
  distillAndStoreLessons,
  ensureDepartmentAgents,
  expireStaleApprovals,
  gatherCeoContext,
  gatherRewardSignal,
  loadCeoPrompt,
  loadDepartmentPrompt,
  promoteCompanyLessons,
  reinforceLessons,
  WORKER_MAX_STEPS,
} from "./ceo";
import { reinvestRevenue } from "./reinvest";

/** TaskRun + CompanyHeartbeat activities (§5.2, §5.3). */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3004";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
// Dashboard origin, so owner-facing briefs can deep-link to /credits (top-up).
// Mirrors the API's WEB_ORIGIN default.
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const DEPLOYD_URL = process.env.DEPLOYD_URL ?? "http://localhost:3002";

/**
 * Resolvable URL of a company's own published site — mirrors deployd's rule
 * (services/deployd/src/server.ts `siteUrl`): prod serves {slug}.{SITE_DOMAIN}
 * behind Caddy; locally there's no wildcard DNS, so deployd serves it path-based
 * at {DEPLOYD_URL}/sites/{slug}/. NB the stored `companies.subdomain` is the prod
 * form and 404s in dev, so we derive the env-correct URL here instead (B2). This
 * is injected into the worker so it edits its OWN landing page rather than
 * hunting the public web for it (B1).
 */
function companySiteUrl(slug: string): string {
  const domain = process.env.SITE_DOMAIN;
  if (domain) return `https://${slug}.${domain}/`;
  const base = (process.env.PUBLIC_SITE_URL ?? DEPLOYD_URL).replace(/\/$/, "");
  return `${base}/sites/${slug}/`;
}

const sql = postgres(DATABASE_URL, { max: 5 });
const ledger = new Ledger(new PgStore(DATABASE_URL));

// Execution-plane pool (§8), selected by SANDBOX_KIND: `local` (in-process,
// dev/tests), `subprocess` (separate OS process — real isolation, the local
// default), or `e2b` (one hosted microVM per task on e2b.dev — prod). The
// agent loop is identical across all three. One sandbox per task, never
// reused (§5.3).
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
  model_level: string;
  model_bundle: string;
}

async function taskRow(taskId: string): Promise<TaskRow> {
  const [t] = await sql<TaskRow[]>`
    SELECT t.id, t.company_id, c.conglomerate_id, t.title, t.description,
           c.name, c.slug, c.mission, c.model_level, c.model_bundle
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

// §10 pillar 1 — the wallet is real money (cents). We hold a generous estimate
// up front (gates on balance so a task can't start unfunded), then reconcile to
// the real metered API cost on success. ~80¢ comfortably covers a Haiku task and
// most others; over-runs self-correct at reconcile.
export const DEFAULT_TASK_ESTIMATE_CENTS = Number(process.env.TASK_COST_ESTIMATE_CENTS ?? 80);

/** Hold the estimated cost (cents) up front; balance must stay non-negative (§4). */
export async function chargeTask(
  taskId: string,
  estimateCents = DEFAULT_TASK_ESTIMATE_CENTS,
): Promise<void> {
  const t = await taskRow(taskId);
  const balance = await creditBalance(t.conglomerate_id);
  if (balance < estimateCents) throw new Error("insufficient_credits");
  await sql`
    INSERT INTO credit_entries (conglomerate_id, company_id, task_id, delta, reason)
    VALUES (${t.conglomerate_id}, ${t.company_id}, ${taskId}, ${-estimateCents}, 'task_charge')`;
  await ledger.append({
    companyId: t.company_id,
    actor: "system",
    eventType: "credit_change",
    payload: { taskId, delta: -estimateCents, reason: "task_charge", estimate: true },
  });
}

/**
 * Reconcile the up-front hold to the real metered API cost (§10 pillar 1).
 * Posts the difference so the task's net charge equals the actual cost, records
 * the cost on the public ledger, and is idempotent under Temporal retries.
 */
export async function reconcileTask(taskId: string, costMicroCents = 0): Promise<void> {
  const t = await taskRow(taskId);
  // idempotent: a reconcile marker already exists → done.
  const [already] = await sql`
    SELECT 1 FROM credit_entries WHERE task_id = ${taskId} AND meta->>'kind' = 'reconcile'`;
  if (already) return;

  const actualCents = Math.max(0, Math.round(costMicroCents / 1000));
  const [charged] = await sql<{ total: string }[]>`
    SELECT COALESCE(-SUM(delta), 0) AS total FROM credit_entries
    WHERE task_id = ${taskId} AND reason = 'task_charge'`;
  const estimateCents = Number(charged!.total);
  const adjustment = estimateCents - actualCents; // >0 give back, <0 extra charge
  const reason = adjustment >= 0 ? "task_refund" : "task_charge";
  // Always insert a marker row (delta may be 0) so retries are no-ops.
  await sql`
    INSERT INTO credit_entries (conglomerate_id, company_id, task_id, delta, reason, meta)
    VALUES (${t.conglomerate_id}, ${t.company_id}, ${taskId}, ${adjustment}, ${reason},
            ${sql.json({ kind: "reconcile", actualCents })})`;
  if (adjustment !== 0) {
    await ledger.append({
      companyId: t.company_id,
      actor: "system",
      eventType: "credit_change",
      payload: { taskId, delta: adjustment, reason, kind: "reconcile" },
    });
  }
  // Transparency: the real API cost of this task, on the public ledger.
  await ledger.append({
    companyId: t.company_id,
    actor: "system",
    eventType: "llm_cost",
    payload: { taskId, costCents: actualCents, costMicroCents },
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
export async function runWorker(
  taskId: string,
): Promise<{ summary: string; steps: number; costMicroCents?: number }> {
  const t = await taskRow(taskId);
  const token = signToken({
    companyId: t.company_id,
    taskId,
    exp: Math.floor(Date.now() / 1000) + 35 * 60,
  });
  // §5.3 hard budgets; WORKER_MAX_STEPS lets cost-sensitive runs (real-LLM
  // smoke tests) cap the loop below the default without touching the contract
  const budgets = {
    maxSteps: WORKER_MAX_STEPS,
    maxWallClockMs: 30 * 60_000,
  };
  // §9.2: the Langfuse trace id is the task id — recorded up front so the
  // public page links to the trace even for failed/timed-out tasks.
  await sql`UPDATE tasks SET trace_id = ${taskId} WHERE id = ${taskId}`;
  const sandbox = await sandboxes.claim({ taskId, companyId: t.company_id, budgets });
  // Send a keepalive heartbeat every 60 s so Temporal doesn't kill the activity
  // during multi-minute LLM calls (the per-step heartbeat alone isn't enough —
  // it only fires after the LLM responds, not during the API call).
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const startKeepAlive = () => {
    clearInterval(keepAlive);
    keepAlive = setInterval(() => {
      try {
        heartbeat("thinking");
      } catch {
        /* outside an activity context */
      }
    }, 60_000);
  };
  startKeepAlive();
  try {
    return await sandbox.execAgent(
      {
        gatewayUrl: GATEWAY_URL,
        token,
        task: { id: t.id, title: t.title, description: t.description },
        company: { name: t.name, slug: t.slug, mission: t.mission, siteUrl: companySiteUrl(t.slug) },
        budgets,
        traceId: taskId,
        tierShift: tierShiftForLevel(t.model_level),
        bundle: t.model_bundle === "glm" ? "glm" : "anthropic",
      },
      // §5.3 "every step streamed": step events come back from the sandbox
      // (in-process, pipe, or vsock) and on this side become a Temporal
      // heartbeat and a ledger event — the dashboard terminal renders the
      // worker thinking. Reset the keepalive timer each step so we don't
      // double-fire during quiet periods right after a tool call.
      (step) => {
        startKeepAlive();
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
    clearInterval(keepAlive);
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
  // §7.3: clear approvals the owner never acted on, so the queue the CEO sees is
  // live and the loop isn't waiting on dead requests.
  await expireStaleApprovals(sql, ledger).catch(() => {});
  const ctx = await gatherCeoContext(sql, company);
  const { system, hash } = loadCeoPrompt(company);

  // §10 cost: a freshly-founded company already has the deterministic launch
  // playbook queued and no task has reported back yet — there's nothing for the
  // C-suite to react to, so skip the paid planning fan-out (3 dept + 1 CEO call)
  // until the first results land. The heartbeat still dispatches the queued work.
  if (ctx.recentReports.length === 0 && ctx.queuedTasks > 0) {
    await ledger.append({
      companyId,
      actor: "ceo",
      eventType: "ceo_plan",
      payload: { skipped: "awaiting_first_results", queuedTasks: ctx.queuedTasks, promptHash: hash },
    });
    return {
      userBrief: `Launch playbook underway — ${ctx.queuedTasks} task(s) queued. I'll plan the next moves once the first results come back.`,
    };
  }

  // §10 self-financing (FINANCING_PLAN.md Phase 2): before deciding whether we
  // can afford to plan, let a company that has earned revenue refill its shared
  // credit wallet (1:1) when it's running low. This closes the loop — a selling
  // company refinances itself instead of freezing the moment its grant is spent.
  // Best-effort: a reinvest hiccup must never break the heartbeat.
  const reinvested = await reinvestRevenue(sql, ledger, company.conglomerateId).catch(
    () => ({ movedCents: 0, sources: [] }),
  );

  // §10 cost guard: a conglomerate that can't fund even one task (balance below a
  // single task's up-front hold) gains nothing from the paid planning fan-out —
  // applyCeoPlan wouldn't queue anything anyway. But the C-suite + distiller LLM
  // calls are NOT credit-charged, so without this they'd keep burning the platform
  // API key every heartbeat for a frozen company (the main multi-tenant exposure).
  // Skip the whole fan-out and tell the owner to top up. (Runs after the reinvest
  // above, so a company that just refinanced itself reads the topped-up balance.)
  const planningFunds = await creditBalance(company.conglomerateId);
  if (planningFunds < DEFAULT_TASK_ESTIMATE_CENTS) {
    await ledger.append({
      companyId,
      actor: "ceo",
      eventType: "ceo_plan",
      payload: { skipped: "insufficient_credits", balance: planningFunds, promptHash: hash },
    });
    return {
      userBrief: `Out of credits (balance ${planningFunds}) — autonomous planning is paused to avoid spend. Top up at ${WEB_ORIGIN}/credits to resume work.`,
    };
  }
  if (reinvested.movedCents > 0) {
    await ledger.append({
      companyId,
      actor: "ceo",
      eventType: "ceo_plan",
      payload: { reinvestedCents: reinvested.movedCents, balance: planningFunds, promptHash: hash, note: "self_financed" },
    });
  }

  // OPE-6: the CEO/department/reward calls run on the company's provider bundle.
  const baseCfg = llmConfigFromEnv();
  const cfg = baseCfg ? { ...baseCfg, bundle: company.modelBundle } : null;
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
  // Same contract as the department planners above: a model failure degrades to
  // the deterministic plan instead of killing the heartbeat. Without this an
  // unparseable reply lost the entire day — prod queued no work at all on
  // 2026-07-19, 07-21 (partial) and 07-22. The reason lands on the ledger event
  // so a persistently failing model can't hide behind a plausible-looking plan.
  let planDegraded: string | null = null;
  let plan: CeoPlan;
  try {
    plan = await planHeartbeat(
      cfg,
      system,
      ctx,
      tracer ? { tracer, traceId, name: "heartbeat-plan" } : undefined,
      reports,
    );
  } catch (err) {
    planDegraded = err instanceof Error ? err.message : String(err);
    plan = fallbackPlan(ctx, reports);
  }
  await tracer?.flush();

  // Don't queue new tasks the wallet can't fund a single task's estimate of —
  // they'd fail on charge and the next heartbeat would re-queue them, spiraling.
  const balance = await creditBalance(company.conglomerateId);
  const applied =
    balance >= DEFAULT_TASK_ESTIMATE_CENTS
      ? await applyCeoPlan(sql, ledger, company, plan, { promptHash: hash, source: "heartbeat" })
      : { createdTasks: [], missionUpdated: false };
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
      // Present only when the CEO model failed and the deterministic planner
      // stood in — surfaced so a silently-degrading model is auditable.
      ...(planDegraded ? { degradedToFallback: planDegraded } : {}),
      departments: Object.fromEntries(
        reports.map((r) => [r.department, { headline: r.headline, proposed: r.proposed_tasks.length }]),
      ),
      ...(tracer?.publicUrl(traceId) ? { traceUrl: tracer.publicUrl(traceId) } : {}),
    },
  });
  // Compounding memory (§lessons): score the existing tips against this cycle's
  // rewards, then distil any new ones from what changed. Best-effort — a learning
  // hiccup must never break the heartbeat that just produced a valid plan.
  try {
    const reward = await gatherRewardSignal(sql, company);
    await reinforceLessons(sql, company, reward);
    const learned = await distillAndStoreLessons(
      sql,
      ledger,
      company,
      ctx,
      reward,
      cfg,
      tracer ? { tracer, traceId: `lessons-${companyId}-${day}`, name: "distill-lessons" } : undefined,
    );
    if (learned.length) await tracer?.flush();
    // Lift any lessons that have proven themselves up to the shared sheet so the
    // conglomerate's other companies inherit them (idempotent — only acts on
    // newly-qualified lessons), then age the shared sheet so it self-prunes
    // (time-proportional, so N companies hitting it can't over-decay).
    await promoteCompanyLessons(sql, ledger, company);
    await decayConglomerateLessons(sql, ledger, company.conglomerateId);
  } catch (err) {
    await ledger.append({
      companyId,
      actor: "ceo",
      eventType: "lessons_distilled",
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Guarantee the owner is told about pending approvals even when the LLM brief
  // omitted them — the human-in-the-loop only works if the human is pulled in.
  const pending = ctx.pendingApprovals?.length ?? 0;
  const userBrief =
    pending && !/await/i.test(plan.user_brief)
      ? `${plan.user_brief} · ⚠ ${pending} action(s) await your approval`
      : plan.user_brief;
  return { userBrief };
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

  // Both caps reset at UTC midnight (calendar day), not on a rolling 24h
  // window. The heartbeat fires at a fixed UTC time each day (HEARTBEAT_CRON,
  // default 07:00 UTC), so a rolling window puts the boundary right where
  // yesterday's tasks started — they'd still count, tripping the cap early and
  // making a company dispatch every *other* day instead of daily. Anchoring to
  // UTC midnight (Temporal crons are UTC too) makes "3/day" mean the calendar day.
  const [startedToday] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM tasks
    WHERE company_id = ${companyId}
      AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  if (Number(startedToday!.n) >= c.daily_task_cap)
    return { taskId: null, reason: "daily_task_cap_reached" };

  const [spent] = await sql<{ n: string }[]>`
    SELECT COALESCE(-SUM(delta), 0) AS n FROM credit_entries
    WHERE conglomerate_id = ${c.conglomerate_id} AND reason = 'task_charge'
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  if (Number(spent!.n) >= Number(c.daily_credit_cap))
    return { taskId: null, reason: "daily_credit_cap_reached" };

  // Out of runway: stop cleanly rather than dispatch a task that fails on charge.
  if ((await creditBalance(c.conglomerate_id)) < DEFAULT_TASK_ESTIMATE_CENTS)
    return { taskId: null, reason: "insufficient_funds" };

  // Effective priority ages up by 1 per day waited (capped at +10), so nothing
  // can starve regardless of what priority the CEO assigned. Straight
  // `priority DESC` let a steady drip of higher-priority work bury older tasks
  // indefinitely: in prod a p0 task queued 2026-07-13 first ran 2026-07-22, and
  // the CEO meanwhile re-planned it into 5 near-duplicate tasks.
  const [next] = await sql<{ id: string }[]>`
    SELECT id FROM tasks
    WHERE company_id = ${companyId} AND status = 'queued'
      AND (scheduled_for IS NULL OR scheduled_for <= now())
    ORDER BY priority + LEAST(FLOOR(EXTRACT(EPOCH FROM now() - created_at) / 86400), 10) DESC,
             created_at
    LIMIT 1`;
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

/**
 * Ad-spend sync (§14): a thin signed call to the gateway, which mirrors each
 * active campaign's spend into the ledger and auto-pauses at the monthly cap.
 * Run each heartbeat so the CEO sees fresh spend and the cap is enforced even
 * between worker tasks. Idempotent in the gateway, so retries are safe.
 */
export async function syncAdSpend(
  companyId: string,
): Promise<{ autoPaused: number; reallocated: number; monthToDateCents: number }> {
  const signedPost = async (path: string) => {
    const raw = JSON.stringify({ companyId });
    const sig = createHmac("sha256", GATEWAY_SECRET).update(raw).digest("hex");
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencorp-sig": sig },
      body: raw,
    });
    if (res.status >= 500) throw new Error(`gateway ${path} ${res.status}`);
    return (await res.json().catch(() => ({}))) as Record<string, number | undefined>;
  };
  // Mirror spend + enforce the cap first, then reallocate on fresh numbers.
  const sync = await signedPost("/admin/ads/sync");
  const opt = await signedPost("/admin/ads/optimize");
  return {
    autoPaused: sync.autoPaused ?? 0,
    reallocated: opt.reallocated ?? 0,
    monthToDateCents: sync.monthToDateCents ?? 0,
  };
}
