import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import postgres from "postgres";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { ceoChat, llmConfigFromEnv, publicTraceUrl, traceConfigFromEnv, tracerFromEnv } from "@opencorp/llm";
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
  userCanAccessCompany,
  userConglomerateIds,
  userIsMemberOfConglomerate,
} from "./auth";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const store = new PgStore(databaseUrl);
const ledger = new Ledger(store);
const sql = postgres(databaseUrl, { max: 5 });

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

// §9.2/§9.4 — public company list with a real P&L: revenue in, credits spent,
// money withdrawn, current balance. Public companies only (is_public, §4).
const PNL_COLUMNS = sql`
  c.id, c.slug, c.name, c.mission, c.status, c.real_balance_cents,
  COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.company_id = c.id), 0) AS revenue_cents,
  COALESCE((SELECT -SUM(delta) FROM credit_entries ce
            WHERE ce.company_id = c.id AND ce.reason IN ('task_charge','task_refund')), 0) AS credits_spent,
  COALESCE((SELECT SUM((payload->>'amountCents')::bigint) FROM ledger_events le
            WHERE le.company_id = c.id AND le.event_type = 'money_out'), 0) AS money_out_cents,
  COALESCE((SELECT count(*) FROM tasks t WHERE t.company_id = c.id AND t.status = 'done'), 0) AS tasks_done,
  COALESCE((SELECT count(*) FROM tasks t WHERE t.company_id = c.id AND t.status = 'queued'), 0) AS tasks_queued`;

interface PnlRow {
  id: string; slug: string; name: string; mission: string; status: string;
  real_balance_cents: string; revenue_cents: string; credits_spent: string;
  money_out_cents: string; tasks_done: string; tasks_queued: string;
}
const toPnl = (r: PnlRow) => ({
  id: r.id, slug: r.slug, name: r.name, mission: r.mission, status: r.status,
  revenueCents: Number(r.revenue_cents),
  creditsSpent: Number(r.credits_spent),
  moneyOutCents: Number(r.money_out_cents),
  balanceCents: Number(r.real_balance_cents),
  tasksDone: Number(r.tasks_done),
  tasksQueued: Number(r.tasks_queued),
});

app.get("/api/companies", async (c) => {
  const rows = await sql<PnlRow[]>`
    SELECT ${PNL_COLUMNS} FROM companies c WHERE c.is_public = true
    ORDER BY c.created_at DESC LIMIT 100`;
  return c.json({ companies: rows.map(toPnl) });
});

app.get("/api/companies/:slug", async (c) => {
  const [row] = await sql<PnlRow[]>`
    SELECT ${PNL_COLUMNS} FROM companies c WHERE c.slug = ${c.req.param("slug")} AND c.is_public = true`;
  if (!row) return c.json({ error: "not_found" }, 404);
  const traceCfg = traceConfigFromEnv();
  const tasks = await sql<{ title: string; status: string; priority: number; trace_id: string | null }[]>`
    SELECT title, status, priority, trace_id FROM tasks
    WHERE company_id = ${row.id} AND status <> 'deleted'
    ORDER BY priority DESC, created_at DESC LIMIT 25`;
  return c.json({
    company: toPnl(row),
    // §9.2 — every task links to its full Langfuse public trace
    tasks: tasks.map((t) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      traceUrl: t.trace_id && traceCfg ? publicTraceUrl(traceCfg, t.trace_id) : null,
    })),
  });
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

// §10 — billing plans. Lago (when configured) mirrors subscriptions for
// invoicing; the credit ledger is always the source of truth.
const billingStore = new PgBillingStore(sql);
const billingProvider = billingProviderFromEnv();
const appendGrant = (payload: Record<string, unknown>) =>
  ledger.append({ companyId: null, actor: "system", eventType: "credit_change", payload });

app.get("/api/plans", (c) =>
  c.json({ plans: Object.values(PLANS), provider: billingProvider.kind }),
);

app.post("/conglomerates/:id/subscribe", requireAuth, async (c) => {
  const body = z
    .object({ plan: z.enum(["free", "builder", "pro"]) })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  if (!(await userIsMemberOfConglomerate(sql, c.get("userId"), c.req.param("id")))) {
    return c.json({ error: "forbidden" }, 403);
  }
  try {
    const sub = await subscribe(billingStore, billingProvider, appendGrant, c.req.param("id"), body.data.plan);
    return c.json({ subscription: sub });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

// Cron-invoked (idempotent): grant the new cycle's credits to recurring plans.
app.post("/billing/grant-cycle", async (c) =>
  c.json(await runGrantCycle(billingStore, appendGrant)),
);

// §9.2 — live firehose via PG LISTEN/NOTIFY → SSE (no extra broker, §11.5).
// `?company=<id>` filters server-side and enriches each frame with the full
// (redacted) event row, so the dashboard terminal can render real lines.
const listenSql = postgres(databaseUrl, { max: 1 });
app.get("/api/live", (c) => {
  const companyFilter = c.req.query("company") || null;
  return streamSSE(c, async (stream) => {
    const { unlisten } = await listenSql.listen("ledger_events", (payload) => {
      void (async () => {
        if (!companyFilter) {
          await stream.writeSSE({ event: "ledger", data: payload });
          return;
        }
        const thin = JSON.parse(payload) as { seq: number; companyId: string | null };
        if (thin.companyId !== companyFilter) return;
        const [row] = await sql<
          { seq: string; actor: string; event_type: string; payload: unknown; created_at: string }[]
        >`SELECT seq, actor, event_type, payload, created_at FROM ledger_events WHERE seq = ${thin.seq}`;
        if (!row) return;
        await stream.writeSSE({
          event: "ledger",
          data: JSON.stringify({
            seq: Number(row.seq),
            companyId: companyFilter,
            actor: row.actor,
            eventType: row.event_type,
            payload: row.payload,
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
