/**
 * Cron heartbeat live exit test (§1 feature 5, §5.2, §16): companies run
 * autonomously on a Temporal Schedule — no human, no API call, the clock
 * fires the same CompanyHeartbeat the dashboard button does.
 *
 *   1. provision a company (credits, empty queue) + spawn the real Temporal
 *      worker and API
 *   2. create its heartbeat schedule on a 15 s interval (test override of the
 *      daily cron) and assert ensure() is idempotent
 *   3. WAIT — a heartbeat fires by itself: departments plan, CEO adopts, a
 *      task runs, a daily brief lands on the ledger
 *   4. pause via the API (owner control) → the clock stops
 *   5. resume → the clock restarts
 *   6. backfill: a second, schedule-less company gets its clock from
 *      POST /admin/schedules/backfill
 *   7. chain verifies; schedules deleted (cleanup)
 *
 * Run with the dev stack (postgres + temporal) up:
 *   bun apps/gateway/scripts/cron-demo.ts
 */
import postgres from "postgres";
import {
  deleteHeartbeatSchedule,
  describeHeartbeatSchedule,
  ensureHeartbeatSchedule,
} from "@opencorp/workflows";
import { createGateway } from "../src/app";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const API_PORT = 3106;
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const procs: ReturnType<typeof Bun.spawn>[] = [];
function spawn(label: string, cmd: string[], cwd: string, env: Record<string, string>) {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
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
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await Bun.sleep(300);
  }
}

const briefCount = async (companyId: string) =>
  Number(
    (
      await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM ledger_events
        WHERE company_id = ${companyId} AND event_type = 'daily_brief'`
    )[0]!.n,
  );

async function waitForBriefs(companyId: string, atLeast: number, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await briefCount(companyId);
    if (n >= atLeast) return n;
    if (Date.now() > deadline) throw new Error(`timeout: ${n}/${atLeast} daily briefs`);
    await Bun.sleep(1_000);
  }
}

async function provision(name: string): Promise<string> {
  const slug = `cron-${name}-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo-user', 'Cron Demo Conglomerate', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, ${`Cron ${name}`}, 'Sell handmade ceramic mugs online.',
            'active', 'supervised', ${`${slug}@opencorp.app`}, ${`${slug}.localhost`})
    RETURNING id`;
  await sql`INSERT INTO agents (company_id, kind, name, role_prompt, model_tier)
            VALUES (${co!.id}, 'ceo', 'CEO', 'prompts/ceo.md', 'frontier')`;
  await sql`INSERT INTO credit_entries (conglomerate_id, company_id, delta, reason)
            VALUES (${cg!.id}, ${co!.id}, '100', 'grant')`;
  return co!.id;
}

async function main() {
  const root = new URL("../../..", import.meta.url).pathname;

  // ── 1. provision + real services ───────────────────────────────────────────
  const companyId = await provision("alpha");
  console.log(`Provisioned company ${companyId} — empty task queue, no schedule`);

  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const gw = Bun.serve({ port: 0, fetch: app.fetch });
  spawn("worker", ["npx", "tsx", "src/worker.ts"], `${root}workflows`, {
    DATABASE_URL,
    GATEWAY_URL: `http://localhost:${gw.port}`,
  });
  spawn("api", ["bun", "src/index.ts"], `${root}apps/api`, { DATABASE_URL, PORT: String(API_PORT) });
  const api = `http://localhost:${API_PORT}`;
  await waitHttp(`${api}/healthz`);
  await Bun.sleep(5_000); // worker poller registration
  console.log(`API ${api}, Temporal worker up`);

  try {
    // ── 2. the clock: 15 s interval (test override of the daily cron) ────────
    const first = await ensureHeartbeatSchedule(companyId, { intervalMs: 15_000 });
    ok(first.created, "heartbeat schedule created");
    const again = await ensureHeartbeatSchedule(companyId, { intervalMs: 15_000 });
    ok(!again.created, "ensure is idempotent — existing schedule untouched");

    // ── 3. autonomy: a heartbeat fires with ZERO human/API involvement ───────
    console.log("Waiting for the schedule to fire on its own...");
    await waitForBriefs(companyId, 1);
    ok(true, "heartbeat fired autonomously — daily brief on the ledger, nobody called the API");

    const [task] = await sql`
      SELECT 1 FROM tasks WHERE company_id = ${companyId}
        AND title = 'Draft and run a customer outreach campaign' AND status = 'done'`;
    ok(task, "the autonomous run dispatched a department-proposed task to done");

    const info = await describeHeartbeatSchedule(companyId);
    ok(info && !info.paused && info.recentRuns >= 1, "schedule describes: running, ≥1 recent action");

    // ── 4. pause is an owner control (§5.2) — the clock stops ────────────────
    const paused = await (await fetch(`${api}/companies/${companyId}/pause`, { method: "POST" })).json();
    ok((paused as { status: string }).status === "paused", "API pause: company paused + schedule paused");
    await Bun.sleep(2_000); // let any in-flight heartbeat land its brief
    const frozen = await briefCount(companyId);
    await Bun.sleep(35_000); // > 2 intervals
    ok((await briefCount(companyId)) === frozen, "no heartbeats while paused (35 s ≈ 2+ intervals)");
    const pausedInfo = await describeHeartbeatSchedule(companyId);
    ok(pausedInfo?.paused === true, "schedule reports paused");

    // ── 5. resume — the clock restarts ───────────────────────────────────────
    const resumed = await (await fetch(`${api}/companies/${companyId}/resume`, { method: "POST" })).json();
    ok((resumed as { status: string }).status === "active", "API resume: company active + schedule unpaused");
    await waitForBriefs(companyId, frozen + 1);
    ok(true, "heartbeats resumed after unpause");

    // ── 6. backfill gives pre-scheduling companies their clock ───────────────
    const companyB = await provision("beta");
    ok((await describeHeartbeatSchedule(companyB)) === null, "second company starts schedule-less");
    const backfill = await (await fetch(`${api}/admin/schedules/backfill`, { method: "POST" })).json();
    ok((backfill as { scheduled: number }).scheduled >= 1, "backfill scheduled the schedule-less company");
    ok((await describeHeartbeatSchedule(companyB)) !== null, "second company now has its daily clock");

    // ── 7. every event of the autonomous era is on the verified chain ────────
    const events = await sql<{ event_type: string; actor: string }[]>`
      SELECT event_type, actor FROM ledger_events
      WHERE company_id = ${companyId} AND event_type IN ('heartbeat_scheduled', 'company_status')`;
    ok(
      events.some((e) => e.event_type === "company_status" && e.actor === "user"),
      "pause/resume are user-actor ledger events",
    );
    const head = (await ledger.head())!.seq;
    const verdict = await ledger.verify(1, head);
    ok(verdict.ok, `hash chain verifies (head seq ${head})`);

    console.log("\nCron heartbeat exit test PASSED");
  } finally {
    // cleanup: neither the 15 s test schedules nor the backfilled daily ones
    // may keep firing for throwaway dev companies after the test
    const all = await sql<{ id: string }[]>`SELECT id FROM companies`;
    for (const co of all) await deleteHeartbeatSchedule(co.id).catch(() => {});
  }
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
