/**
 * code-mcp exit test (§7.1): a worker writes, runs, and commits real software
 * inside its sandbox — every code call authorized + audited at the gateway,
 * executed in the sandbox. Drives the real pipeline against the live dev DB:
 *
 *   docker compose -f infra/compose/docker-compose.dev.yml up -d postgres
 *   bun apps/gateway/scripts/code-demo.ts
 *
 * Runs the worker through the subprocess pool (real OS-process isolation, the
 * same serialize-spec/stream-events seam E2B uses) with the scripted policy, so
 * no LLM or E2B account is needed.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { signToken } from "@opencorp/mcp-client";
import { SubprocessSandboxPool } from "@opencorp/sandboxd";
import { createGateway } from "../src/app";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ── company + credits ─────────────────────────────────────────────────────
  const slug = `codeco-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo', 'Code Demo', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'Scriptworks', 'Ship small useful tools.', 'active', ${`${slug}@opencorp.dev`}, ${`${slug}.localhost`})
    RETURNING id`;
  const companyId = co!.id;

  // ── gateway (in-process) + a worker in a real subprocess sandbox ──────────
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
  const gatewayUrl = `http://localhost:${server.port}`;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, company_id, title, description, status)
            VALUES (${taskId}, ${companyId}, 'Write and run a build script', 'Automate the build.', 'running')`;
  const token = signToken({ companyId, taskId, exp: Math.floor(Date.now() / 1000) + 600 });

  const pool = new SubprocessSandboxPool();
  const sandbox = await pool.claim({ taskId, companyId });
  const steps: string[] = [];
  const result = await sandbox.execAgent(
    {
      gatewayUrl,
      token,
      task: { id: taskId, title: "Write and run a build script", description: "Automate the build." },
      company: { name: "Scriptworks", slug, mission: "Ship small useful tools." },
      env: { LITELLM_URL: "" }, // scripted policy (offline)
    },
    (s) => s.tool && steps.push(s.tool),
  );
  await sandbox.release();
  console.log(`Worker: ${result.summary}`);

  ok(steps.includes("code.write_file"), "worker used code.write_file");
  ok(steps.includes("code.exec"), "worker used code.exec");
  ok(steps.includes("code.git_commit_push"), "worker used code.git_commit_push");
  ok(/15/.test(result.summary), "exec ran in the sandbox (seq 1..5 summed to 15)");

  // ── the gateway audited every code call on the ledger ─────────────────────
  const events = await sql<{ payload: any }[]>`
    SELECT payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'tool_call' AND seq > ${seqBefore}
      AND payload->>'server' = 'code'
    ORDER BY seq`;
  const tools = events.map((e) => e.payload.tool);
  ok(tools.includes("exec") && tools.includes("write_file") && tools.includes("git_commit_push"),
    "code.exec/write_file/git_commit_push all audited on the ledger");

  const writeEvt = events.find((e) => e.payload.tool === "write_file")!;
  ok(writeEvt.payload.args.content === undefined && typeof writeEvt.payload.args.bytes === "number",
    "write_file audit records {path, bytes} — file content stays off the ledger (§9.3)");
  ok(events.every((e) => e.payload.outcome === "ok"), "every audited code call authorized ok");

  const verdict = await ledger.verify();
  ok(verdict.ok, `hash chain verifies (head seq ${(await ledger.head())?.seq})`);

  console.log("\nCODE DEMO PASSED — worker built, ran, and committed software in its sandbox; every call on the ledger.");
  server.stop(true);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
