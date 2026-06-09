import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import postgres from "postgres";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { startCreateCompany, startHeartbeat, startTaskRun, startWithdrawal } from "@opencorp/workflows";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const store = new PgStore(databaseUrl);
const ledger = new Ledger(store);
const sql = postgres(databaseUrl, { max: 5 });

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true, service: "opencorp-api" }));

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
  const tasks = await sql`
    SELECT title, status, priority FROM tasks
    WHERE company_id = ${row.id} AND status <> 'deleted'
    ORDER BY priority DESC, created_at DESC LIMIT 25`;
  return c.json({ company: toPnl(row), tasks });
});

// §6 — one prompt → company. Auth lands in a later milestone; conglomerateId
// is taken from the body for now.
app.post("/companies", async (c) => {
  const body = z
    .object({ conglomerateId: z.string().uuid(), prompt: z.string().min(10).max(2000) })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const result = await startCreateCompany(body.data);
  return c.json(result, 201);
});

// §5.2 — manual heartbeat / Run-now controls (dashboard actions, never LLM tools)
app.post("/companies/:id/heartbeat", async (c) =>
  c.json(await startHeartbeat(c.req.param("id"))),
);
app.post("/tasks/:id/run", async (c) => {
  try {
    return c.json(await startTaskRun(c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

// §10 — money-out. User-initiated (the §7.3 human approval); durable workflow.
app.post("/companies/:id/withdraw", async (c) => {
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

// §9.2 — live firehose via PG LISTEN/NOTIFY → SSE (no extra broker, §11.5)
const listenSql = postgres(databaseUrl, { max: 1 });
app.get("/api/live", (c) =>
  streamSSE(c, async (stream) => {
    const { unlisten } = await listenSql.listen("ledger_events", (payload) => {
      void stream.writeSSE({ event: "ledger", data: payload });
    });
    stream.onAbort(() => void unlisten());
    // keepalive comments so proxies don't drop the stream
    while (!stream.aborted) {
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      await stream.sleep(15_000);
    }
  }),
);

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
export default { port, fetch: app.fetch };
