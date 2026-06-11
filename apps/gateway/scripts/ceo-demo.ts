/**
 * CEO loop live exit test (§5.2 + §1 feature 2 + §14 M5 departments): the full
 * autonomous cycle through the REAL stack — API route → Temporal workflow →
 * department sub-planners (CMO/CTO/CFO) → CEO synthesis → task creation →
 * serialized dispatch → worker in sandbox pool → daily brief — plus the chat
 * surface, with every step on the hash chain.
 *
 *   1. provision a company with an EMPTY task queue (the C-suite must plan work)
 *   2. spawn the real Temporal worker (tsx) and the real API (bun)
 *   3. POST /companies/:id/heartbeat → departments propose, CEO adopts the
 *      CMO's outreach task, dispatches it
 *   4. POST /companies/:id/chat "task: ..." → CEO queues owner-requested work
 *   5. second heartbeat dispatches the chat-created task
 *   6. assert department_plan / ceo_plan / ceo_chat / daily_brief events;
 *      department agent rows exist; chain verifies.
 *
 * Run with the dev stack (postgres + temporal) up:
 *   bun apps/gateway/scripts/ceo-demo.ts
 */
import postgres from "postgres";
import { createGateway } from "../src/app";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const API_PORT = 3105;
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const procs: ReturnType<typeof Bun.spawn>[] = [];
function spawn(label: string, cmd: string[], cwd: string, env: Record<string, string>) {
  const p = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(p);
  void (async () => {
    for await (const chunk of p.stdout) process.stdout.write(`  [${label}] ${new TextDecoder().decode(chunk)}`);
  })();
  return p;
}

async function waitHttp(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await Bun.sleep(300);
  }
}

async function main() {
  const root = new URL("../../..", import.meta.url).pathname;

  // ── 1. provision: company with credits and NO tasks ───────────────────────
  const slug = `ceodemo-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo-user', 'CEO Demo Conglomerate', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'Mug Works', 'Sell handmade ceramic mugs online.',
            'active', 'supervised', ${`${slug}@opencorp.app`}, ${`${slug}.localhost`})
    RETURNING id`;
  const companyId = co!.id;
  await sql`INSERT INTO agents (company_id, kind, name, role_prompt, model_tier)
            VALUES (${companyId}, 'ceo', 'CEO', 'prompts/ceo.md', 'frontier')`;
  await sql`INSERT INTO credit_entries (conglomerate_id, company_id, delta, reason)
            VALUES (${cg!.id}, ${companyId}, '100', 'grant')`;
  console.log(`Provisioned ${slug} (${companyId}) — empty task queue`);

  // ── 2. real services: in-process gateway, Temporal worker (tsx), API (bun) ─
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const gw = Bun.serve({ port: 0, fetch: app.fetch });
  const gatewayUrl = `http://localhost:${gw.port}`;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  spawn("worker", ["npx", "tsx", "src/worker.ts"], `${root}workflows`, {
    DATABASE_URL,
    GATEWAY_URL: gatewayUrl,
  });
  spawn("api", ["bun", "src/index.ts"], `${root}apps/api`, {
    DATABASE_URL,
    PORT: String(API_PORT),
  });
  const api = `http://localhost:${API_PORT}`;
  await waitHttp(`${api}/healthz`);
  await Bun.sleep(5_000); // worker poller registration
  console.log(`Gateway ${gatewayUrl}, API ${api}, Temporal worker up`);

  // ── 3. heartbeat #1: CEO must plan work into the empty queue and run it ───
  const hb1 = await (await fetch(`${api}/companies/${companyId}/heartbeat`, { method: "POST" })).json() as { dispatched: number; stoppedBecause: string };
  console.log(`Heartbeat #1: ${JSON.stringify(hb1)}`);
  ok(hb1.dispatched >= 1, "heartbeat dispatched the CEO-created task");

  const deptEvents = await sql<{ actor: string; payload: { headline: string; promptHash: string } }[]>`
    SELECT actor, payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'department_plan' ORDER BY seq`;
  ok(
    new Set(deptEvents.map((e) => e.actor)).size === 3,
    "CMO, CTO, and CFO each published a department_plan event (§14 M5)",
  );
  ok(
    deptEvents.every((e) => /^[0-9a-f]{16}$/.test(e.payload.promptHash)),
    "every department event records its prompt hash (§5.4)",
  );

  const deptAgents = await sql`
    SELECT 1 FROM agents WHERE company_id = ${companyId} AND kind = 'department'`;
  ok(deptAgents.length === 3, "department agent rows provisioned idempotently");

  const [planEv] = await sql<
    { payload: { createdTasks: string[]; promptHash: string; departments: Record<string, { proposed: number }> } }[]
  >`
    SELECT payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'ceo_plan' ORDER BY seq DESC LIMIT 1`;
  ok(planEv && planEv.payload.createdTasks.length >= 1, "ceo_plan event with created tasks on the ledger");
  ok(/^[0-9a-f]{16}$/.test(planEv!.payload.promptHash), "plan event records the prompt hash (§5.4)");
  ok(
    planEv!.payload.departments?.cmo?.proposed >= 1,
    "ceo_plan records the department proposals it synthesized over",
  );

  const [doneTask] = await sql`
    SELECT 1 FROM tasks WHERE company_id = ${companyId} AND status = 'done'
      AND title = 'Draft and run a customer outreach campaign'`;
  ok(doneTask, "CMO-proposed, CEO-adopted task ran to done through TaskRun");

  const [brief] = await sql<{ payload: { brief: string } }[]>`
    SELECT payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'daily_brief' ORDER BY seq DESC LIMIT 1`;
  ok(brief?.payload.brief.includes("Dispatched 1 task(s)"), "daily brief posted with dispatch summary");

  // ── 4. chat: owner asks for status, then directs work ─────────────────────
  const chat1 = await (await fetch(`${api}/companies/${companyId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "How are we doing?" }),
  })).json() as { reply: string; createdTasks: string[] };
  console.log(`CEO: ${chat1.reply}`);
  ok(chat1.reply.length > 0 && chat1.createdTasks.length === 0, "status chat answers without queueing work");

  const chat2 = await (await fetch(`${api}/companies/${companyId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "task: write a pricing page" }),
  })).json() as { reply: string; createdTasks: string[] };
  ok(chat2.createdTasks.includes("write a pricing page"), "chat directive queued a task");

  const chatEvents = await sql`
    SELECT 1 FROM ledger_events WHERE company_id = ${companyId} AND event_type = 'ceo_chat'`;
  ok(chatEvents.length === 2, "both chat turns are public ledger events");

  // ── 5. heartbeat #2 dispatches the chat-created task ──────────────────────
  const hb2 = await (await fetch(`${api}/companies/${companyId}/heartbeat`, { method: "POST" })).json() as { dispatched: number };
  ok(hb2.dispatched >= 1, "second heartbeat dispatched the owner-requested task");
  const [pricingDone] = await sql`
    SELECT 1 FROM tasks WHERE company_id = ${companyId} AND title = 'write a pricing page' AND status = 'done'`;
  ok(pricingDone, "owner-requested task completed");

  // ── 6. the chain still verifies across everything that just happened ──────
  const head = (await ledger.head())!.seq;
  const verdict = await ledger.verify(1, head);
  ok(verdict.ok, `hash chain verifies (${head - seqBefore} new events, head seq ${head})`);

  console.log("\nCEO loop exit test PASSED");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of procs) p.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
