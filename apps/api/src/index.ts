import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import postgres from "postgres";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { startCreateCompany, startHeartbeat, startTaskRun } from "@opencorp/workflows";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const store = new PgStore(databaseUrl);
const ledger = new Ledger(store);

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true, service: "opencorp-api" }));

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
