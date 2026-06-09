/**
 * M4 exit criterion (§11, §14): 100 concurrent tasks. The spec's performance
 * thesis is "one task per company, but unbounded cross-company parallelism —
 * throughput scales with sandbox nodes, not the control plane." This drives N
 * companies running a task at once through the real gateway (tools + ledger),
 * then proves the hash chain still verifies and the redaction audit is clean
 * under concurrent append load.
 *
 *   bun apps/gateway/scripts/m4-loadtest.ts [N=100]
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createGateway } from "../src/app";
import { signToken } from "@opencorp/mcp-client";
import { runWorkerTask } from "@opencorp/agentd";
import { auditChain, PgStore } from "@opencorp/ledgerd";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const N = Number(process.argv[2] ?? 100);
const sql = postgres(DATABASE_URL, { max: 20 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const tag = Date.now().toString(36);
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name) VALUES ('demo', 'M4 Load') RETURNING id`;

  // bulk-provision N companies
  const rows = Array.from({ length: N }, (_, i) => ({
    conglomerate_id: cg!.id,
    slug: `load-${tag}-${i}`,
    name: `Load Co ${i}`,
    mission: `Company ${i} exists to exercise concurrent task execution.`,
  }));
  const companies = await sql<{ id: string; slug: string; name: string; mission: string }[]>`
    INSERT INTO companies ${sql(rows, "conglomerate_id", "slug", "name", "mission")}
    RETURNING id, slug, name, mission`;
  console.log(`Provisioned ${companies.length} companies`);

  // One dev gateway absorbs the whole burst; prod spreads it across replicas
  // behind PgBouncer. Size the pool to the concurrency we're driving.
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL, poolMax: Math.min(N, 80) });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const gatewayUrl = `http://localhost:${server.port}`;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  // fire all tasks concurrently (one per company — the §5.3 serialization unit)
  const t0 = performance.now();
  const results = await Promise.allSettled(
    companies.map((co) => {
      const taskId = randomUUID();
      const token = signToken({ companyId: co.id, taskId, exp: Math.floor(Date.now() / 1000) + 600 });
      return runWorkerTask({
        gatewayUrl,
        token,
        task: { id: taskId, title: `Write the weekly status report ${taskId.slice(0, 8)}`, description: "Summarize progress." },
        company: { name: co.name, slug: co.slug, mission: co.mission },
      });
    }),
  );
  const elapsedMs = performance.now() - t0;

  const done = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - done;
  const reasons = new Map<string, number>();
  for (const r of results)
    if (r.status === "rejected") {
      const m = (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 80);
      reasons.set(m, (reasons.get(m) ?? 0) + 1);
    }
  if (failed) for (const [m, n] of reasons) console.log(`    ✗ ${n}× ${m}`);
  const firstErr = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (firstErr) console.log("    first error stack:\n", (firstErr.reason as Error)?.stack);
  ok(done === N, `all ${N} tasks completed (${failed} failed)`);
  console.log(`  → ${(N / (elapsedMs / 1000)).toFixed(1)} tasks/sec, ${elapsedMs.toFixed(0)} ms wall for ${N} concurrent`);

  const seqAfter = (await ledger.head())?.seq ?? 0;
  console.log(`  → ${seqAfter - seqBefore} ledger events appended under concurrency`);

  // integrity under concurrent appends
  const verify = await ledger.verify(1);
  ok(verify.ok, `hash chain verifies end-to-end (${verify.checked} events)`);
  const store = new PgStore(DATABASE_URL);
  const audit = await auditChain(store, seqBefore + 1, seqAfter);
  await store.close();
  ok(audit.violations.length === 0, `redaction audit clean over the new ${audit.scanned} events`);

  server.stop();
  await sql.end();
  console.log(`\nM4 load test PASSED — ${N} concurrent tasks, chain intact.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
