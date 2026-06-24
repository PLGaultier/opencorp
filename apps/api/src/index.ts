import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import postgres from "postgres";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { ceoChat, llmConfigFromEnv, publicTraceUrl, traceConfigFromEnv, tracerFromEnv } from "@opencorp/llm";
import { syncInboxFromEnv } from "@opencorp/stalwart";
import {
  applyCeoPlan,
  backfillHeartbeatSchedules,
  ceoCompany,
  describeHeartbeatSchedule,
  ensureHeartbeatSchedule,
  gatherCeoContext,
  loadCeoPrompt,
  pauseHeartbeatSchedule,
  resumeHeartbeatSchedule,
  startCreateCompany,
  startHeartbeat,
  startTaskRun,
  startWithdrawal,
} from "@opencorp/workflows";
import { PLANS, PgBillingStore, billingProviderFromEnv, runGrantCycle, subscribe } from "./billing";
import {
  auth,
  requireAuth,
  getSessionUser,
  userCanAccessCompany,
  userConglomerateIds,
  userIsMemberOfConglomerate,
} from "./auth";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const store = new PgStore(databaseUrl);
const ledger = new Ledger(store);
const sql = postgres(databaseUrl, { max: 5 });

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3004";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";

/** Call a platform-signed gateway admin route (same HMAC scheme as withdraw). */
async function gatewaySignedPost(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", GATEWAY_SECRET).update(raw).digest("hex");
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sig },
    body: raw,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const app = new Hono<{ Variables: { userId: string } }>();

// Public transparency API + dashboard are called from the browser on another
// origin (Next.js dev server, Vercel). Session cookies need credentials, so
// the origin is echoed back rather than wildcarded.
app.use("*", cors({ origin: (origin) => origin || "*", credentials: true }));

// §3 — Better Auth: sign-up/sign-in/sign-out/session under /api/auth/*
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/healthz", (c) => c.json({ ok: true, service: "opencorp-api" }));

// Who am I + which conglomerates I belong to (drives the dashboard).
app.get("/api/me", requireAuth, async (c) => {
  const userId = c.get("userId");
  const conglomerateIds = await userConglomerateIds(sql, userId);
  return c.json({ userId, conglomerateIds });
});

/** 403 unless the session user is a member of the company's conglomerate. */
const requireCompanyAccess: typeof requireAuth = async (c, next) => {
  const companyId = c.req.param("id");
  if (!companyId || !(await userCanAccessCompany(sql, c.get("userId"), companyId))) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
};

/**
 * Same as requireCompanyAccess but keyed on the :slug param — for the read-only
 * dashboard endpoints (tasks, agents, emails, payments, campaigns) that expose
 * operational detail. A logged-out visitor or a non-owner gets 403; only the
 * P&L summary and the public hash-chained ledger stay open to everyone (§4).
 */
const requireCompanyAccessBySlug: typeof requireAuth = async (c, next) => {
  const slug = c.req.param("slug") ?? "";
  const [co] = await sql<{ id: string }[]>`
    SELECT id FROM companies WHERE slug = ${slug}`;
  if (!co || !(await userCanAccessCompany(sql, c.get("userId"), co.id))) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
};

// §9.2/§9.4 — public company list with a real P&L: revenue in, real money spent
// (wallet debits at true API cost, §10 pillar 1), money withdrawn, current
// balance. Public companies only (is_public, §4).
const PNL_COLUMNS = sql`
  c.id, c.slug, c.name, c.mission, c.status, c.real_balance_cents,
  c.daily_task_cap, c.autonomy_level, c.model_level, c.is_public, c.ad_monthly_budget_cap_cents,
  COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.company_id = c.id), 0) AS revenue_cents,
  COALESCE((SELECT -SUM(delta) FROM credit_entries ce
            WHERE ce.company_id = c.id AND ce.reason IN ('task_charge','task_refund')), 0) AS spend_cents,
  COALESCE((SELECT SUM((payload->>'amountCents')::bigint) FROM ledger_events le
            WHERE le.company_id = c.id AND le.event_type = 'money_out'), 0) AS money_out_cents,
  COALESCE((SELECT count(*) FROM tasks t WHERE t.company_id = c.id AND t.status = 'done'), 0) AS tasks_done,
  COALESCE((SELECT count(*) FROM tasks t WHERE t.company_id = c.id AND t.status = 'queued'), 0) AS tasks_queued`;

interface PnlRow {
  id: string; slug: string; name: string; mission: string; status: string;
  real_balance_cents: string; revenue_cents: string; spend_cents: string;
  money_out_cents: string; tasks_done: string; tasks_queued: string;
  daily_task_cap: string; autonomy_level: string; model_level: string; is_public: boolean;
  ad_monthly_budget_cap_cents: string;
}
const toPnl = (r: PnlRow) => ({
  id: r.id, slug: r.slug, name: r.name, mission: r.mission, status: r.status,
  revenueCents: Number(r.revenue_cents),
  spendCents: Number(r.spend_cents),
  moneyOutCents: Number(r.money_out_cents),
  balanceCents: Number(r.real_balance_cents),
  tasksDone: Number(r.tasks_done),
  tasksQueued: Number(r.tasks_queued),
  dailyTaskCap: Number(r.daily_task_cap),
  autonomyLevel: r.autonomy_level,
  modelLevel: r.model_level,
  isPublic: r.is_public,
  adMonthlyBudgetCapCents: Number(r.ad_monthly_budget_cap_cents),
});

app.get("/api/companies", async (c) => {
  const rows = await sql<PnlRow[]>`
    SELECT ${PNL_COLUMNS} FROM companies c WHERE c.is_public = true
    ORDER BY c.created_at DESC LIMIT 100`;
  return c.json({ companies: rows.map(toPnl) });
});

// The signed-in owner's own companies (public or private), across every
// conglomerate they belong to — drives the personal dashboard. Registered
// before /api/companies/:slug so the static "mine" path wins.
app.get("/api/companies/mine", requireAuth, async (c) => {
  const congIds = await userConglomerateIds(sql, c.get("userId"));
  if (congIds.length === 0) return c.json({ companies: [] });
  const rows = await sql<PnlRow[]>`
    SELECT ${PNL_COLUMNS} FROM companies c
    WHERE c.conglomerate_id = ANY(${congIds})
    ORDER BY c.created_at DESC LIMIT 100`;
  return c.json({ companies: rows.map(toPnl) });
});

app.get("/api/companies/:slug", async (c) => {
  const [row] = await sql<PnlRow[]>`
    SELECT ${PNL_COLUMNS} FROM companies c WHERE c.slug = ${c.req.param("slug")} AND c.is_public = true`;
  if (!row) return c.json({ error: "not_found" }, 404);
  // Public summary = P&L stats only (incl. aggregate task counts from
  // PNL_COLUMNS). Task *titles* are operational detail, served owner-only by
  // /api/companies/:slug/tasks; they are deliberately omitted here.
  return c.json({ company: toPnl(row), tasks: [] });
});

// Does the current session own this company? Drives the dashboard's owner-only
// panels. Never 401s — a logged-out visitor just gets { owner: false }.
app.get("/api/companies/:slug/access", async (c) => {
  const user = await getSessionUser(c.req.raw);
  if (!user) return c.json({ owner: false });
  const [co] = await sql<{ id: string }[]>`
    SELECT id FROM companies WHERE slug = ${c.req.param("slug")}`;
  if (!co) return c.json({ owner: false });
  return c.json({ owner: await userCanAccessCompany(sql, user.id, co.id) });
});

// §9.2 — per-company event history (full redacted payloads) powering the
// dashboard terminal. Public companies only.
app.get("/api/companies/:slug/events", async (c) => {
  const [co] = await sql<{ id: string }[]>`
    SELECT id FROM companies WHERE slug = ${c.req.param("slug")} AND is_public = true`;
  if (!co) return c.json({ error: "not_found" }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 1000);
  const rows = await sql<
    { seq: string; actor: string; event_type: string; payload: unknown; created_at: string }[]
  >`SELECT seq, actor, event_type, payload, created_at FROM ledger_events
    WHERE company_id = ${co.id} ORDER BY seq DESC LIMIT ${limit}`;
  return c.json({
    companyId: co.id,
    events: rows.reverse().map((r) => ({
      seq: Number(r.seq),
      actor: r.actor,
      eventType: r.event_type,
      payload: r.payload,
      createdAt: r.created_at,
    })),
  });
});

// Full task fields for the task management UI (public companies only, like
// the events endpoint). The PnL task list above stays slim for the dashboard.
const TASK_COLUMNS = sql`
  id, title, description, status, priority, result_summary, error,
  credits_estimated, credits_charged, trace_id, created_at, started_at, finished_at`;

interface TaskRow {
  id: string; title: string; description: string; status: string; priority: number;
  result_summary: string | null; error: string | null;
  credits_estimated: string | null; credits_charged: string | null;
  trace_id: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}
const toTask = (t: TaskRow, traceCfg: ReturnType<typeof traceConfigFromEnv>) => ({
  id: t.id,
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  resultSummary: t.result_summary,
  error: t.error,
  creditsEstimated: t.credits_estimated ? Number(t.credits_estimated) : null,
  creditsCharged: t.credits_charged ? Number(t.credits_charged) : null,
  traceUrl: t.trace_id && traceCfg ? publicTraceUrl(traceCfg, t.trace_id) : null,
  createdAt: t.created_at,
  startedAt: t.started_at,
  finishedAt: t.finished_at,
});

const publicCompanyId = async (slug: string) => {
  const [co] = await sql<{ id: string }[]>`
    SELECT id FROM companies WHERE slug = ${slug} AND is_public = true`;
  return co?.id ?? null;
};

app.get("/api/companies/:slug/tasks", requireAuth, requireCompanyAccessBySlug, async (c) => {
  const companyId = await publicCompanyId(c.req.param("slug"));
  if (!companyId) return c.json({ error: "not_found" }, 404);
  const traceCfg = traceConfigFromEnv();
  const rows = await sql<TaskRow[]>`
    SELECT ${TASK_COLUMNS} FROM tasks
    WHERE company_id = ${companyId} AND status <> 'deleted'
    ORDER BY priority DESC, created_at DESC LIMIT 100`;
  return c.json({ companyId, tasks: rows.map((t) => toTask(t, traceCfg)) });
});

app.get("/api/companies/:slug/tasks/:taskId", requireAuth, requireCompanyAccessBySlug, async (c) => {
  const companyId = await publicCompanyId(c.req.param("slug"));
  if (!companyId) return c.json({ error: "not_found" }, 404);
  const [row] = await sql<TaskRow[]>`
    SELECT ${TASK_COLUMNS} FROM tasks
    WHERE id = ${c.req.param("taskId")} AND company_id = ${companyId} AND status <> 'deleted'`;
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ companyId, task: toTask(row, traceConfigFromEnv()) });
});

// §16/M5 — the org chart: CEO + department agents (CMO/CTO/CFO) + workers,
// with their recent department plans straight from the ledger.
app.get("/api/companies/:slug/agents", requireAuth, requireCompanyAccessBySlug, async (c) => {
  const companyId = await publicCompanyId(c.req.param("slug"));
  if (!companyId) return c.json({ error: "not_found" }, 404);
  const agents = await sql<
    { id: string; kind: string; name: string; role_prompt: string; model_tier: string; created_at: string }[]
  >`SELECT id, kind, name, role_prompt, model_tier, created_at FROM agents
    WHERE company_id = ${companyId}
    ORDER BY CASE kind WHEN 'ceo' THEN 0 WHEN 'department' THEN 1 ELSE 2 END, created_at`;
  const plans = await sql<
    { seq: string; actor: string; payload: unknown; created_at: string }[]
  >`SELECT seq, actor, payload, created_at FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'department_plan'
    ORDER BY seq DESC LIMIT 20`;
  return c.json({
    companyId,
    agents: agents.map((a) => ({
      id: a.id, kind: a.kind, name: a.name, rolePrompt: a.role_prompt,
      modelTier: a.model_tier, createdAt: a.created_at,
    })),
    departmentPlans: plans.map((p) => ({
      seq: Number(p.seq), actor: p.actor, payload: p.payload, createdAt: p.created_at,
    })),
  });
});

// §6 — one prompt → company, in the session user's conglomerate. A user with
// several conglomerates may pick one explicitly; it must be theirs.
app.post("/companies", requireAuth, async (c) => {
  const body = z
    .object({ conglomerateId: z.string().uuid().optional(), prompt: z.string().min(10).max(2000) })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const mine = await userConglomerateIds(sql, c.get("userId"));
  const conglomerateId = body.data.conglomerateId ?? mine[0];
  if (!conglomerateId || !mine.includes(conglomerateId)) {
    return c.json({ error: "forbidden", detail: "not a member of that conglomerate" }, 403);
  }
  const result = await startCreateCompany({ conglomerateId, prompt: body.data.prompt });
  return c.json(result, 201);
});

// Owner settings (dashboard-only — the CEO can only patch the mission via
// org.update_mission; caps, autonomy and visibility stay human-controlled).
app.patch("/companies/:id", requireAuth, requireCompanyAccess, async (c) => {
  const body = z
    .object({
      name: z.string().min(1).max(120).optional(),
      mission: z.string().min(10).max(2000).optional(),
      dailyTaskCap: z.number().int().min(1).max(50).optional(),
      autonomyLevel: z.enum(["supervised", "bounded", "full"]).optional(),
      // §10 — the CEO "brains" level (which model bundle powers the agents).
      modelLevel: z.enum(["intern", "grad", "phd"]).optional(),
      isPublic: z.boolean().optional(),
      // §14 — owner's monthly ad-spend ceiling (cents). 0 disables ads.
      adMonthlyBudgetCapCents: z.number().int().min(0).max(1_000_000_00).optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "empty patch" })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const companyId = c.req.param("id");
  const p = body.data;
  const [row] = await sql<
    { id: string; name: string; mission: string; daily_task_cap: number; autonomy_level: string; model_level: string; is_public: boolean; ad_monthly_budget_cap_cents: string }[]
  >`
    UPDATE companies SET
      name = COALESCE(${p.name ?? null}, name),
      mission = COALESCE(${p.mission ?? null}, mission),
      daily_task_cap = COALESCE(${p.dailyTaskCap ?? null}, daily_task_cap),
      autonomy_level = COALESCE(${p.autonomyLevel ?? null}, autonomy_level),
      model_level = COALESCE(${p.modelLevel ?? null}, model_level),
      is_public = COALESCE(${p.isPublic ?? null}, is_public),
      ad_monthly_budget_cap_cents = COALESCE(${p.adMonthlyBudgetCapCents ?? null}, ad_monthly_budget_cap_cents)
    WHERE id = ${companyId}
    RETURNING id, name, mission, daily_task_cap, autonomy_level, model_level, is_public, ad_monthly_budget_cap_cents`;
  if (!row) return c.json({ error: "not_found" }, 404);
  await ledger.append({ companyId, actor: "user", eventType: "company_settings", payload: p });
  return c.json({
    id: row.id, name: row.name, mission: row.mission,
    dailyTaskCap: row.daily_task_cap, autonomyLevel: row.autonomy_level, modelLevel: row.model_level, isPublic: row.is_public,
    adMonthlyBudgetCapCents: Number(row.ad_monthly_budget_cap_cents),
  });
});

// Owner task creation — same shape and 'queued' status as the CEO's
// org.create_task tool, but attributed to the user on the ledger.
app.post("/companies/:id/tasks", requireAuth, requireCompanyAccess, async (c) => {
  const body = z
    .object({
      title: z.string().min(1).max(200),
      description: z.string().max(5000).default(""),
      priority: z.number().int().default(0),
    })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const companyId = c.req.param("id");
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO tasks (company_id, title, description, status, priority)
    VALUES (${companyId}, ${body.data.title}, ${body.data.description}, 'queued', ${body.data.priority})
    RETURNING id`;
  await ledger.append({
    companyId,
    actor: "user",
    eventType: "task_state",
    payload: { taskId: t!.id, title: body.data.title, status: "queued", source: "owner" },
  });
  return c.json({ taskId: t!.id }, 201);
});

// Owner task edits — mirrors org.update_task: running/done tasks are locked.
app.patch("/tasks/:id", requireAuth, async (c) => {
  const body = z
    .object({
      title: z.string().min(1).max(200).optional(),
      status: z.enum(["pending", "queued", "deleted"]).optional(),
      priority: z.number().int().optional(),
      description: z.string().max(5000).optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "empty patch" })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const taskId = c.req.param("id");
  const [task] = await sql<{ company_id: string; status: string }[]>`
    SELECT company_id, status FROM tasks WHERE id = ${taskId}`;
  if (!task) return c.json({ error: "not_found" }, 404);
  if (!(await userCanAccessCompany(sql, c.get("userId"), task.company_id))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const p = body.data;
  const [row] = await sql<{ id: string; title: string; status: string; priority: number; description: string }[]>`
    UPDATE tasks SET
      title = COALESCE(${p.title ?? null}, title),
      status = COALESCE(${p.status ?? null}, status),
      priority = COALESCE(${p.priority ?? null}, priority),
      description = COALESCE(${p.description ?? null}, description)
    WHERE id = ${taskId} AND status NOT IN ('running', 'done')
    RETURNING id, title, status, priority, description`;
  if (!row) return c.json({ error: "task_locked", detail: `task is ${task.status}` }, 409);
  await ledger.append({
    companyId: task.company_id,
    actor: "user",
    eventType: "task_state",
    payload: { taskId, ...p, source: "owner" },
  });
  return c.json({
    id: row.id, title: row.title, status: row.status,
    priority: row.priority, description: row.description,
  });
});

// §5.2 — manual heartbeat / Run-now controls (dashboard actions, never LLM tools)
app.post("/companies/:id/heartbeat", requireAuth, requireCompanyAccess, async (c) =>
  c.json(await startHeartbeat(c.req.param("id"))),
);

// §1 feature 5 / §5.2 — the autonomous clock: per-company Temporal cron
// schedule. Pause/resume are owner controls; the CEO cannot reach them.
app.get("/companies/:id/schedule", requireAuth, requireCompanyAccess, async (c) => {
  const info = await describeHeartbeatSchedule(c.req.param("id"));
  return info ? c.json(info) : c.json({ error: "not_scheduled" }, 404);
});

app.post("/companies/:id/schedule", requireAuth, requireCompanyAccess, async (c) => {
  const companyId = c.req.param("id");
  const [co] = await sql<{ id: string }[]>`SELECT id FROM companies WHERE id = ${companyId}`;
  if (!co) return c.json({ error: "not_found" }, 404);
  const { scheduleId, created } = await ensureHeartbeatSchedule(companyId);
  if (created) {
    await ledger.append({
      companyId,
      actor: "user",
      eventType: "heartbeat_scheduled",
      payload: { scheduleId, cron: process.env.HEARTBEAT_CRON ?? "0 7 * * *" },
    });
  }
  return c.json({ scheduleId, created });
});

app.post("/companies/:id/pause", requireAuth, requireCompanyAccess, async (c) => {
  const companyId = c.req.param("id");
  const [co] = await sql<{ id: string }[]>`
    UPDATE companies SET status = 'paused' WHERE id = ${companyId} RETURNING id`;
  if (!co) return c.json({ error: "not_found" }, 404);
  try {
    await pauseHeartbeatSchedule(companyId);
  } catch {
    // pre-schedule company: status alone stops dispatch (pickNextTask)
  }
  await ledger.append({
    companyId,
    actor: "user",
    eventType: "company_status",
    payload: { status: "paused" },
  });
  return c.json({ status: "paused" });
});

app.post("/companies/:id/resume", requireAuth, requireCompanyAccess, async (c) => {
  const companyId = c.req.param("id");
  const [co] = await sql<{ id: string }[]>`
    UPDATE companies SET status = 'active' WHERE id = ${companyId} RETURNING id`;
  if (!co) return c.json({ error: "not_found" }, 404);
  try {
    await resumeHeartbeatSchedule(companyId);
  } catch {
    /* no schedule yet — POST /companies/:id/schedule creates one */
  }
  await ledger.append({
    companyId,
    actor: "user",
    eventType: "company_status",
    payload: { status: "active" },
  });
  return c.json({ status: "active" });
});

// One-time migration: give every pre-scheduling company its daily clock.
app.post("/admin/schedules/backfill", requireAuth, async (c) => {
  const results = await backfillHeartbeatSchedules(sql);
  for (const r of results.filter((r) => r.created)) {
    await ledger.append({
      companyId: r.companyId,
      actor: "system",
      eventType: "heartbeat_scheduled",
      payload: { scheduleId: `heartbeat-schedule:${r.companyId}`, cron: process.env.HEARTBEAT_CRON ?? "0 7 * * *", backfill: true },
    });
  }
  return c.json({ scheduled: results.filter((r) => r.created).length, total: results.length });
});
app.post("/tasks/:id/run", requireAuth, async (c) => {
  const [task] = await sql<{ company_id: string }[]>`
    SELECT company_id FROM tasks WHERE id = ${c.req.param("id")}`;
  if (!task) return c.json({ error: "not_found" }, 404);
  if (!(await userCanAccessCompany(sql, c.get("userId"), task.company_id))) {
    return c.json({ error: "forbidden" }, 403);
  }
  try {
    return c.json(await startTaskRun(c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

// §1 feature 2 — chat with the CEO. Free (never charges credits); the CEO can
// queue tasks and patch the mission, never pause the company or change caps.
// The conversation itself is a ledger event — transparency includes the boss.
app.post("/companies/:id/chat", requireAuth, requireCompanyAccess, async (c) => {
  const body = z
    .object({ message: z.string().min(1).max(8000) })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const companyId = c.req.param("id");

  let company;
  try {
    company = await ceoCompany(sql, companyId);
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
  const ctx = await gatherCeoContext(sql, company);
  const { system, hash } = loadCeoPrompt(company);

  // history = prior ceo_chat ledger events (no hidden memory, §5.4)
  const prior = await sql<{ payload: { message: string; reply: string } }[]>`
    SELECT payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'ceo_chat'
    ORDER BY seq DESC LIMIT 10`;
  const history = prior
    .reverse()
    .flatMap((r) => [
      { role: "user" as const, text: r.payload.message },
      { role: "ceo" as const, text: r.payload.reply },
    ]);

  const tracer = tracerFromEnv();
  const traceId = `ceo-chat-${companyId}-${Date.now()}`;
  const reply = await ceoChat(
    llmConfigFromEnv(),
    system,
    ctx,
    history,
    body.data.message,
    tracer ? { tracer, traceId, name: "ceo-chat" } : undefined,
  );
  await tracer?.flush();

  const applied = await applyCeoPlan(
    sql,
    ledger,
    company,
    { new_tasks: reply.new_tasks, mission_patch: null },
    { promptHash: hash, source: "chat" },
  );
  await ledger.append({
    companyId,
    actor: "ceo",
    eventType: "ceo_chat",
    payload: {
      message: body.data.message,
      reply: reply.reply,
      createdTasks: applied.createdTasks,
      promptHash: hash,
    },
  });
  return c.json({ reply: reply.reply, createdTasks: applied.createdTasks });
});

// §8 — products the CEO created (public catalogue) and payment history.
// Local payment links are deterministic: {checkoutBase}/pay/{slug}/{productId},
// served by the gateway (which owns recordPayment). Must match the gateway's
// own default so a link minted here resolves there.
const checkoutBase =
  process.env.CHECKOUT_BASE_URL ?? "http://localhost:3004/checkout";

app.get("/api/companies/:slug/products", async (c) => {
  const slug = c.req.param("slug");
  const companyId = await publicCompanyId(slug);
  if (!companyId) return c.json({ error: "not_found" }, 404);
  const rows = await sql<
    { id: string; name: string; price_cents: string; currency: string; payment_link: string | null }[]
  >`SELECT id, name, price_cents, currency, payment_link FROM products WHERE company_id = ${companyId} ORDER BY name`;
  return c.json({
    companyId,
    products: rows.map((p) => ({
      id: p.id,
      name: p.name,
      priceCents: Number(p.price_cents),
      currency: p.currency,
      // Real Stripe link when present, else the deterministic local one.
      paymentLink: p.payment_link ?? `${checkoutBase}/pay/${slug}/${p.id}`,
    })),
  });
});

app.get("/api/companies/:slug/payments", requireAuth, requireCompanyAccessBySlug, async (c) => {
  const companyId = await publicCompanyId(c.req.param("slug"));
  if (!companyId) return c.json({ error: "not_found" }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const rows = await sql<
    { id: string; product_id: string | null; product_name: string | null; amount_cents: string; currency: string; fee_cents: string; net_cents: string; created_at: string }[]
  >`SELECT pay.id, pay.product_id, pr.name AS product_name,
      pay.amount_cents, pay.currency, pay.fee_cents, pay.net_cents, pay.created_at
    FROM payments pay LEFT JOIN products pr ON pr.id = pay.product_id
    WHERE pay.company_id = ${companyId}
    ORDER BY pay.created_at DESC LIMIT ${limit}`;
  const gross = rows.reduce((s, r) => s + Number(r.amount_cents), 0);
  const fees  = rows.reduce((s, r) => s + Number(r.fee_cents), 0);
  const net   = rows.reduce((s, r) => s + Number(r.net_cents), 0);
  return c.json({
    companyId,
    summary: { grossCents: gross, feesCents: fees, netCents: net, count: rows.length },
    payments: rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name,
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      feeCents: Number(r.fee_cents),
      netCents: Number(r.net_cents),
      createdAt: r.created_at,
    })),
  });
});

// §14 — ad campaigns with this-month spend, attributed revenue and ROAS. The
// same numbers the autonomous optimizer acts on, exposed for transparency.
app.get("/api/companies/:slug/campaigns", requireAuth, requireCompanyAccessBySlug, async (c) => {
  const companyId = await publicCompanyId(c.req.param("slug"));
  if (!companyId) return c.json({ error: "not_found" }, 404);
  const rows = await sql<
    { id: string; name: string; objective: string; status: string; budget_cents: string; budget_type: string; spend_cents: string; revenue_cents: string }[]
  >`
    SELECT ac.id, ac.name, ac.objective, ac.status, ac.budget_cents, ac.budget_type,
      COALESCE((SELECT SUM(spend_cents) FROM ad_spend s
                WHERE s.campaign_id = ac.id AND s.day >= to_char(date_trunc('month', now()), 'YYYY-MM-DD')), 0) AS spend_cents,
      COALESCE((SELECT SUM(amount_cents) FROM payments p
                WHERE p.campaign_id = ac.id AND p.created_at >= date_trunc('month', now())), 0) AS revenue_cents
    FROM ad_campaigns ac WHERE ac.company_id = ${companyId}
    ORDER BY ac.created_at DESC LIMIT 100`;
  return c.json({
    companyId,
    campaigns: rows.map((r) => {
      const spendCents = Number(r.spend_cents);
      const revenueCents = Number(r.revenue_cents);
      return {
        id: r.id, name: r.name, objective: r.objective, status: r.status,
        budgetCents: Number(r.budget_cents), budgetType: r.budget_type,
        spendCents, revenueCents,
        roas: spendCents > 0 ? Math.round((revenueCents / spendCents) * 100) / 100 : null,
      };
    }),
  });
});

// §1 feature 3 — the company's real email inbox (Stalwart JMAP). Public read
// mirrors the tasks/agents transparency: the ledger shows what the AI sent,
// the inbox shows what came back. Owner can mark emails read from the UI.
app.get("/api/companies/:slug/emails", requireAuth, requireCompanyAccessBySlug, async (c) => {
  const companyId = await publicCompanyId(c.req.param("slug"));
  if (!companyId) return c.json({ error: "not_found" }, 404);
  // Best-effort: pull any new replies from Stalwart into the mirror before
  // reading, so the dashboard inbox is live (no-op when mail is unconfigured or
  // the company isn't on the platform domain). Never blocks the read on failure.
  await syncInboxFromEnv(sql, ledger, companyId).catch(() => {});
  const direction = c.req.query("direction");
  const rows = await sql<
    { id: string; direction: string; from_addr: string; to_addrs: string[]; subject: string; read: boolean; created_at: string }[]
  >`SELECT id, direction, from_addr, to_addrs, subject, read, created_at
    FROM emails WHERE company_id = ${companyId}
    ${direction === "in" || direction === "out" ? sql`AND direction = ${direction}` : sql``}
    ORDER BY created_at DESC LIMIT 50`;
  return c.json({
    companyId,
    emails: rows.map((e) => ({
      id: e.id, direction: e.direction, fromAddr: e.from_addr,
      toAddrs: e.to_addrs, subject: e.subject, read: e.read, createdAt: e.created_at,
    })),
  });
});

app.get("/api/companies/:slug/emails/:emailId", requireAuth, requireCompanyAccessBySlug, async (c) => {
  const companyId = await publicCompanyId(c.req.param("slug"));
  if (!companyId) return c.json({ error: "not_found" }, 404);
  const [row] = await sql<
    { id: string; direction: string; from_addr: string; to_addrs: string[]; subject: string; body_text: string | null; body_html: string | null; read: boolean; created_at: string }[]
  >`SELECT id, direction, from_addr, to_addrs, subject, body_text, body_html, read, created_at
    FROM emails WHERE id = ${c.req.param("emailId")} AND company_id = ${companyId}`;
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({
    companyId,
    email: {
      id: row.id, direction: row.direction, fromAddr: row.from_addr,
      toAddrs: row.to_addrs, subject: row.subject,
      bodyText: row.body_text, bodyHtml: row.body_html,
      read: row.read, createdAt: row.created_at,
    },
  });
});

app.post("/companies/:id/emails/:emailId/read", requireAuth, requireCompanyAccess, async (c) => {
  const [row] = await sql<{ id: string }[]>`
    UPDATE emails SET read = true
    WHERE id = ${c.req.param("emailId")} AND company_id = ${c.req.param("id")}
    RETURNING id`;
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ updated: true });
});

// §10 — money-out. User-initiated (the §7.3 human approval); durable workflow.
app.post("/companies/:id/withdraw", requireAuth, requireCompanyAccess, async (c) => {
  const body = z
    .object({ amountCents: z.number().int().positive(), currency: z.string().length(3).optional() })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  try {
    return c.json(await startWithdrawal({ companyId: c.req.param("id"), ...body.data }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

// §7.3 — pending/recent approvals for owner review (human-in-the-loop).
app.get("/companies/:id/approvals", requireAuth, requireCompanyAccess, async (c) => {
  const status = c.req.query("status");
  const rows = await sql<
    { id: string; server: string; tool: string; args: unknown; status: string; decided_by: string | null; error: string | null; created_at: string; decided_at: string | null }[]
  >`SELECT id, server, tool, args, status, decided_by, error, created_at, decided_at
    FROM approvals WHERE company_id = ${c.req.param("id")}
    ${status ? sql`AND status = ${status}` : sql``}
    ORDER BY created_at DESC LIMIT 100`;
  return c.json({
    approvals: rows.map((r) => ({
      id: r.id,
      server: r.server,
      tool: r.tool,
      args: r.args,
      status: r.status,
      decidedBy: r.decided_by,
      error: r.error,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    })),
  });
});

// §7.3 — approve/reject a gated action; the gateway executes it on approval.
app.post("/companies/:id/approvals/:approvalId", requireAuth, requireCompanyAccess, async (c) => {
  const body = z.object({ decision: z.enum(["approve", "reject"]) }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const approvalId = c.req.param("approvalId");
  const [a] = await sql<{ id: string }[]>`
    SELECT id FROM approvals WHERE id = ${approvalId} AND company_id = ${c.req.param("id")}`;
  if (!a) return c.json({ error: "not_found" }, 404);
  const { status, body: out } = await gatewaySignedPost(`/admin/approvals/${approvalId}/resolve`, {
    decision: body.data.decision,
    decidedBy: c.get("userId"),
  });
  return c.json(out, status as 200);
});

// Credit dashboard — balance, breakdown by reason, recent entries, current plan.
app.get("/api/conglomerates/:id/credits", requireAuth, async (c) => {
  const conglomerateId = c.req.param("id");
  if (!(await userIsMemberOfConglomerate(sql, c.get("userId"), conglomerateId))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const [balance] = await sql<{ balance: string }[]>`
    SELECT COALESCE(SUM(delta), 0) AS balance
    FROM credit_entries WHERE conglomerate_id = ${conglomerateId}`;
  const breakdown = await sql<{ reason: string; total: string }[]>`
    SELECT reason, COALESCE(SUM(delta), 0) AS total
    FROM credit_entries WHERE conglomerate_id = ${conglomerateId}
    GROUP BY reason`;
  const entries = await sql<
    { id: string; delta: string; reason: string; company_id: string | null; company_name: string | null; task_id: string | null; created_at: string }[]
  >`SELECT ce.id, ce.delta, ce.reason, ce.company_id, co.name AS company_name, ce.task_id, ce.created_at
    FROM credit_entries ce LEFT JOIN companies co ON co.id = ce.company_id
    WHERE ce.conglomerate_id = ${conglomerateId}
    ORDER BY ce.created_at DESC LIMIT 100`;
  const [sub] = await sql<{ plan: string; status: string; current_period_start: Date | null }[]>`
    SELECT plan, status, current_period_start FROM subscriptions
    WHERE conglomerate_id = ${conglomerateId} AND status = 'active' LIMIT 1`;
  // Stripe Connect status: one connected account per conglomerate (§10). We
  // only need whether it's linked to label the dashboard button; live KYC
  // status comes back when the owner runs onboarding.
  const [cg] = await sql<{ stripe_connect_account_id: string | null }[]>`
    SELECT stripe_connect_account_id FROM conglomerates WHERE id = ${conglomerateId}`;
  // §10 pillar 1 — runway: net real spend over the last 7 days → cents/day → days left.
  const [burn] = await sql<{ total: string }[]>`
    SELECT COALESCE(-SUM(delta), 0) AS total FROM credit_entries
    WHERE conglomerate_id = ${conglomerateId}
      AND reason IN ('task_charge', 'task_refund')
      AND created_at > now() - interval '7 days'`;
  const balanceCents = Number(balance?.balance ?? 0);
  const burnCentsPerDay = Math.max(0, Number(burn?.total ?? 0)) / 7;
  const runwayDays = burnCentsPerDay > 0 ? balanceCents / burnCentsPerDay : null;
  return c.json({
    conglomerateId,
    balance: balanceCents,
    burnCentsPerDay,
    runwayDays,
    breakdown: Object.fromEntries(breakdown.map((r) => [r.reason, Number(r.total)])),
    connectAccountId: cg?.stripe_connect_account_id ?? null,
    subscription: sub
      ? { plan: sub.plan, status: sub.status, currentPeriodStart: sub.current_period_start }
      : null,
    entries: entries.map((e) => ({
      id: e.id,
      delta: Number(e.delta),
      reason: e.reason,
      companyId: e.company_id,
      companyName: e.company_name,
      taskId: e.task_id,
      createdAt: e.created_at,
    })),
  });
});

// §10 — Stripe Connect onboarding. One connected account per conglomerate (per
// owner): the owner clicks "Connect your bank" and we hand back a one-time
// Stripe onboarding URL to redirect to. Browser can't sign the gateway HMAC, so
// the API authenticates the owner and forwards a platform-signed request.
app.post("/api/conglomerates/:id/connect/onboard", requireAuth, async (c) => {
  const conglomerateId = c.req.param("id");
  if (!(await userIsMemberOfConglomerate(sql, c.get("userId"), conglomerateId))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = z
    .object({ returnUrl: z.string().url(), refreshUrl: z.string().url().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const { status, body: out } = await gatewaySignedPost("/admin/connect/onboard", {
    conglomerateId,
    returnUrl: body.data.returnUrl,
    refreshUrl: body.data.refreshUrl ?? body.data.returnUrl,
  });
  return c.json(out, status as 200);
});

// §10 — billing plans. Lago (when configured) mirrors subscriptions for
// invoicing; the credit ledger is always the source of truth.
const billingStore = new PgBillingStore(sql);
const billingProvider = billingProviderFromEnv();
const appendGrant = (payload: Record<string, unknown>) =>
  ledger.append({ companyId: null, actor: "system", eventType: "credit_change", payload });

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

app.get("/api/plans", (c) =>
  c.json({ plans: Object.values(PLANS), provider: billingProvider.kind }),
);

app.post("/conglomerates/:id/subscribe", requireAuth, async (c) => {
  const body = z
    .object({ plan: z.enum(["free", "builder", "pro"]), returnUrl: z.string().url().optional() })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const conglomerateId = c.req.param("id");
  if (!(await userIsMemberOfConglomerate(sql, c.get("userId"), conglomerateId))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const plan = PLANS[body.data.plan];
  const returnUrl = body.data.returnUrl ?? `${WEB_ORIGIN}/credits`;
  try {
    // Paid plan + platform Stripe key → redirect to Checkout; the grant lands on
    // the webhook. Free plan, or local mode → grant the allowance immediately.
    if (plan.priceCents > 0) {
      const { body: out } = await gatewaySignedPost("/admin/billing/checkout", {
        kind: "subscription",
        conglomerateId,
        amountCents: plan.priceCents,
        allowanceCents: plan.credits,
        plan: plan.id,
        label: `${plan.name} plan`,
        successUrl: returnUrl,
        cancelUrl: returnUrl,
      });
      if (out.mode === "stripe" && typeof out.url === "string" && out.url) {
        return c.json({ checkoutUrl: out.url });
      }
    }
    const sub = await subscribe(billingStore, billingProvider, appendGrant, conglomerateId, body.data.plan);
    return c.json({ subscription: sub });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

// §10 pillar 1, Stage 2 — one-off wallet top-up. Returns a checkout URL (Stripe
// Checkout when configured, else a local checkout page); the wallet is credited
// on completion (webhook / local POST).
app.post("/api/conglomerates/:id/topup", requireAuth, async (c) => {
  const body = z
    .object({ amountCents: z.number().int().positive().max(100000), returnUrl: z.string().url().optional() })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const conglomerateId = c.req.param("id");
  if (!(await userIsMemberOfConglomerate(sql, c.get("userId"), conglomerateId))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const returnUrl = body.data.returnUrl ?? `${WEB_ORIGIN}/credits`;
  const { body: out } = await gatewaySignedPost("/admin/billing/checkout", {
    kind: "topup",
    conglomerateId,
    amountCents: body.data.amountCents,
    label: "Wallet top-up",
    successUrl: returnUrl,
    cancelUrl: returnUrl,
  });
  return c.json({ mode: out.mode ?? "local", url: out.url ?? "" });
});

// Cron-invoked (idempotent): grant the new cycle's credits to recurring plans.
app.post("/billing/grant-cycle", async (c) =>
  c.json(await runGrantCycle(billingStore, appendGrant)),
);

// §9.2 — live firehose via PG LISTEN/NOTIFY → SSE (no extra broker, §11.5).
// Every frame is enriched with the full (redacted) event row — actor, payload
// and hash — so the public /live firehose renders real lines, not placeholders,
// identically to the snapshot. `?company=<id>` filters that stream server-side.
const listenSql = postgres(databaseUrl, { max: 1 });
app.get("/api/live", (c) => {
  const companyFilter = c.req.query("company") || null;
  return streamSSE(c, async (stream) => {
    const { unlisten } = await listenSql.listen("ledger_events", (payload) => {
      void (async () => {
        const thin = JSON.parse(payload) as { seq: number; companyId: string | null };
        if (companyFilter && thin.companyId !== companyFilter) return;
        const [row] = await sql<
          {
            seq: string;
            company_id: string | null;
            actor: string;
            event_type: string;
            payload: unknown;
            hash: Uint8Array;
            created_at: string;
          }[]
        >`SELECT seq, company_id, actor, event_type, payload, hash, created_at
            FROM ledger_events WHERE seq = ${thin.seq}`;
        if (!row) return;
        await stream.writeSSE({
          event: "ledger",
          data: JSON.stringify({
            seq: Number(row.seq),
            companyId: row.company_id,
            actor: row.actor,
            eventType: row.event_type,
            payload: row.payload,
            hash: Buffer.from(row.hash).toString("hex"),
            createdAt: row.created_at,
          }),
        });
      })().catch(() => {});
    });
    stream.onAbort(() => void unlisten());
    // keepalive comments so proxies don't drop the stream
    while (!stream.aborted) {
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      await stream.sleep(15_000);
    }
  });
});

// §9.2 — paginated raw events + verification endpoint
app.get("/api/ledger", async (c) => {
  const from = Number(c.req.query("from") ?? 1);
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
  const events = [];
  for await (const ev of store.range(from, from + limit - 1)) {
    events.push({
      seq: ev.seq,
      companyId: ev.companyId,
      actor: ev.actor,
      eventType: ev.eventType,
      payload: ev.payload,
      prevHash: Buffer.from(ev.prevHash).toString("hex"),
      hash: Buffer.from(ev.hash).toString("hex"),
      createdAt: ev.createdAt,
    });
  }
  return c.json({ events, next: events.length === limit ? from + limit : null });
});

app.get("/api/ledger/verify", async (c) => {
  const from = Number(c.req.query("from") ?? 1);
  const to = c.req.query("to") ? Number(c.req.query("to")) : undefined;
  return c.json(await ledger.verify(from, to));
});

app.get("/api/ledger/head", async (c) => {
  const h = await ledger.head();
  return c.json(
    h ? { seq: h.seq, hash: Buffer.from(h.hash).toString("hex"), createdAt: h.createdAt } : null,
  );
});

const port = Number(process.env.PORT ?? 3001);
console.log(`opencorp-api listening on :${port}`);
// idleTimeout: heartbeat/withdraw block on Temporal workflow completion, which
// with a real LLM takes minutes — Bun's 10 s default resets the socket (255 s
// is Bun's maximum).
export default { port, fetch: app.fetch, idleTimeout: 255 };
