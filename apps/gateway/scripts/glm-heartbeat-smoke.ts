/**
 * GLM end-to-end heartbeat (OPE-6 verification). Provisions a real company
 * "Cool Paris" on model_bundle='glm' + model_level='phd', then runs the full
 * pipeline against live z.ai: department sub-planners (glm-4.7), CEO synthesis
 * (glm-5.2), one real worker task (glm-5.2 via the phd +1 shift), and CEO chat.
 *
 *   LITELLM_URL=http://localhost:4000 bun apps/gateway/scripts/glm-heartbeat-smoke.ts
 *
 * Structural asserts only (a real model's plans vary). After it passes, grep
 * the litellm logs to confirm the actual z.ai models hit:
 *   docker compose -f infra/compose/docker-compose.mvp.yml logs litellm | grep -iE "zai/glm"
 */
import postgres from "postgres";
import { createGateway } from "../src/app";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const LITELLM_URL = process.env.LITELLM_URL ?? "http://localhost:4000";
const API_PORT = 3108;
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

async function main() {
  const root = new URL("../../..", import.meta.url).pathname;

  // sanity: the GLM tiers route before we spend anything else.
  const probe = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-frontier", max_tokens: 64, messages: [{ role: "user", content: "ping" }] }),
  });
  ok(probe.ok, `LiteLLM GLM routing works at ${LITELLM_URL} (glm-frontier → zai/glm-5.2)`);

  // ── provision: cost-guarded "Cool Paris", GLM bundle, phd brains ───────────
  const slug = `coolparis-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo-user', 'Cool Paris Holdings', '5000') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies
      (conglomerate_id, slug, name, mission, status, autonomy_level, daily_task_cap,
       model_level, model_bundle, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'Cool Paris',
            'A curated guide to cool, under-the-radar spots in Paris — cafés, bars, shops and walks — that turns readers into paying members.',
            'active', 'supervised', 1, 'phd', 'glm', ${`${slug}@opencorp.app`}, ${`${slug}.localhost`})
    RETURNING id`;
  // phd brains (tier shift +1): the worker runs on frontier=glm-5.2 too. Viable
  // now that worker steps disable hidden "thinking" (loop.ts) — glm-5.2 then runs
  // fast without burning the budget on reasoning, so it executes the real task.
  const companyId = co!.id;
  await sql`INSERT INTO agents (company_id, kind, name, role_prompt, model_tier)
            VALUES (${companyId}, 'ceo', 'CEO', 'prompts/ceo.md', 'frontier')`;
  // Fund it: planning gates on balance >= DEFAULT_TASK_ESTIMATE_CENTS (80¢);
  // GLM's real cost is a few cents and reconciles after. daily_task_cap=1 is
  // what keeps it to a single task, not the credit cap.
  await sql`INSERT INTO credit_entries (conglomerate_id, company_id, delta, reason)
            VALUES (${cg!.id}, ${companyId}, '5000', 'grant')`;
  console.log(`Provisioned Cool Paris ${slug} (${companyId}) — bundle=glm, brains=phd (CEO+worker on glm-5.2), 5000 credits, 1 task/day\n`);

  // ── real services, pointed at the live model ──────────────────────────────
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const gw = Bun.serve({ port: 0, fetch: app.fetch });
  // OPENCORP_AUTH_DISABLED: dev escape hatch so the script can POST /heartbeat
  // without a session (requireAuth then injects dev-user with access to all cos).
  const llmEnv = { LITELLM_URL, WORKER_MAX_STEPS: process.env.WORKER_MAX_STEPS ?? "12", OPENCORP_AUTH_DISABLED: "1" };
  spawn("worker", ["npx", "tsx", "src/worker.ts"], `${root}workflows`, {
    DATABASE_URL,
    GATEWAY_URL: `http://localhost:${gw.port}`,
    ...llmEnv,
  });
  spawn("api", ["bun", "src/index.ts"], `${root}apps/api`, { DATABASE_URL, PORT: String(API_PORT), ...llmEnv });
  const api = `http://localhost:${API_PORT}`;
  await waitHttp(`${api}/healthz`);
  await Bun.sleep(5_000);
  console.log(`API ${api}, Temporal worker up — GLM bundle via LiteLLM\n`);

  // ── heartbeat: departments → CEO synthesis → one real worker task ─────────
  console.log("Running heartbeat (real GLM, this takes a few minutes)...");
  void fetch(`${api}/companies/${companyId}/heartbeat`, { method: "POST" }).catch(() => {});
  const deadline = Date.now() + 12 * 60_000;
  for (;;) {
    const [done] = await sql`
      SELECT 1 FROM ledger_events
      WHERE company_id = ${companyId} AND event_type = 'daily_brief'`;
    if (done) break;
    if (Date.now() > deadline) throw new Error("timeout: heartbeat did not post a daily brief in 12 min");
    await Bun.sleep(3_000);
  }
  console.log("Heartbeat completed (daily_brief on the ledger)\n");

  const depts = await sql<{ actor: string; payload: { headline: string; proposedTasks: string[]; degradedToFallback?: string } }[]>`
    SELECT actor, payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'department_plan' ORDER BY seq`;
  for (const d of depts) {
    console.log(`  ${d.actor}: "${d.payload.headline}"`);
    for (const t of d.payload.proposedTasks) console.log(`    → proposed: ${t}`);
    if (d.payload.degradedToFallback) console.log(`    ⚠ degraded to fallback: ${d.payload.degradedToFallback}`);
  }
  ok(depts.length === 3, "all three departments planned");
  ok(
    depts.every((d) => !d.payload.degradedToFallback),
    "no department degraded to fallback — live GLM JSON passed schema validation",
  );

  const [plan] = await sql<{ payload: { createdTasks: string[] } }[]>`
    SELECT payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'ceo_plan' ORDER BY seq DESC LIMIT 1`;
  ok(plan, "CEO synthesis produced a valid plan (schema-validated JSON from glm-5.2)");
  console.log(`  CEO created tasks: ${plan!.payload.createdTasks?.join(" · ") || "(none)"}`);

  const [brief] = await sql<{ payload: { brief: string } }[]>`
    SELECT payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'daily_brief' ORDER BY seq DESC LIMIT 1`;
  ok(brief && brief.payload.brief.length > 0, "daily brief posted");
  console.log(`\n  Daily brief: ${brief!.payload.brief}\n`);

  const tasks = await sql<{ title: string; status: string; result_summary: string | null; error: string | null }[]>`
    SELECT title, status, result_summary, error FROM tasks WHERE company_id = ${companyId}`;
  for (const t of tasks) {
    console.log(`  Task [${t.status}] ${t.title}`);
    if (t.result_summary) console.log(`    result: ${t.result_summary.slice(0, 300)}`);
    if (t.error) console.log(`    error: ${t.error.slice(0, 300)}`);
  }
  const settled = tasks.filter((t) => t.status === "done" || t.status === "failed");
  if (settled.length >= 1) {
    ok(true, `dispatched task settled (${settled[0]!.status}) through the real worker ReAct loop on GLM`);
  } else {
    console.log("  (CEO queued no immediately-dispatchable work — valid plan, nothing to run)\n");
  }

  // ── real GLM cost was metered to the wallet ───────────────────────────────
  const [burn] = await sql<{ spent: string }[]>`
    SELECT COALESCE(-SUM(delta), 0) AS spent FROM credit_entries
    WHERE company_id = ${companyId} AND reason IN ('task_charge','task_refund')`;
  console.log(`  Wallet debit for the task: ${Number(burn!.spent)} cents (metered at GLM rates)\n`);

  // ── chat with the CEO (glm-5.2) ───────────────────────────────────────────
  console.log('Chatting with the CEO: "What is the single best growth move for Cool Paris this week?"');
  const chat = (await (
    await fetch(`${api}/companies/${companyId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What is the single best growth move for Cool Paris this week, and why?" }),
    })
  ).json()) as { reply: string };
  console.log(`\n  CEO: ${chat.reply}\n`);
  ok(chat.reply.length > 0 && !chat.reply.includes("no LLM configured"), "chat reply came from the live GLM model");

  // ── transparency holds ────────────────────────────────────────────────────
  const head = (await ledger.head())!.seq;
  const verdict = await ledger.verify(1, head);
  ok(verdict.ok, `hash chain verifies (head seq ${head})`);

  console.log("\nGLM heartbeat smoke test PASSED — Cool Paris ran end-to-end on z.ai GLM.");
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
