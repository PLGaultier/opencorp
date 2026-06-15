/**
 * Real-LLM end-to-end proof (Haiku via LiteLLM): a *real* model — not the
 * scripted policy — drives the new capabilities and we watch what it actually
 * does. Two parts:
 *   A. code-mcp: the worker writes a program, runs it in its sandbox, reports.
 *   B. approvals: the worker hits a gated action, gets approval_required and
 *      adapts; the owner then approves and the gateway executes it.
 *
 * Cheap by design: Haiku on every tier, hard step caps, two short tasks.
 * Assertions are structural (the model used the tools; the gate + approval
 * fired) — exact wording varies with the model.
 *
 *   docker compose --env-file .env -f infra/compose/docker-compose.dev.yml up -d postgres litellm
 *   LITELLM_URL=http://localhost:4000 bun apps/gateway/scripts/llm-e2e.ts
 */
import { createHmac, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { signToken } from "@opencorp/mcp-client";
import { runWorkerTask } from "@opencorp/agentd";
import { createGateway } from "../src/app";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const LITELLM_URL = process.env.LITELLM_URL ?? "http://localhost:4000";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function newCompany(autonomy: "supervised" | "full"): Promise<{ id: string; slug: string }> {
  const slug = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap) VALUES ('e2e','E2E','100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'Acme E2E', 'Ship small useful things.', 'active', ${autonomy}, ${`${slug}@opencorp.dev`}, ${`${slug}.localhost`})
    RETURNING id`;
  return { id: co!.id, slug };
}

async function main() {
  process.env.LITELLM_URL = LITELLM_URL; // ensure the worker loop goes real-LLM

  const probe = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "standard", max_tokens: 8, messages: [{ role: "user", content: "say hi" }] }),
  });
  ok(probe.ok, `LiteLLM reachable at ${LITELLM_URL} (Haiku routing works)`);

  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 120 });
  const gatewayUrl = `http://localhost:${server.port}`;
  const workspaces: string[] = [];

  const runTask = async (
    company: { id: string; slug: string },
    title: string,
    description: string,
    maxSteps: number,
  ) => {
    const taskId = randomUUID();
    await sql`INSERT INTO tasks (id, company_id, title, description, status)
              VALUES (${taskId}, ${company.id}, ${title}, ${description}, 'running')`;
    const token = signToken({ companyId: company.id, taskId, exp: Math.floor(Date.now() / 1000) + 1800 });
    const workspace = path.join(os.tmpdir(), `oc-e2e-${taskId.slice(0, 8)}`);
    workspaces.push(workspace);
    console.log(`\n▶ ${title}`);
    const result = await runWorkerTask({
      gatewayUrl,
      token,
      task: { id: taskId, title, description },
      company: { name: "Acme E2E", slug: company.slug, mission: "Ship small useful things." },
      budgets: { maxSteps, maxWallClockMs: 5 * 60_000 },
      workspace,
      onStep: (s) =>
        console.log(`   ${s.n}. ${s.tool ? `[${s.tool}] ` : ""}${s.thought.slice(0, 110)}`),
    }).catch((err) => ({ summary: `(threw: ${err instanceof Error ? err.message : err})`, steps: 0 }));
    console.log(`   ⤷ ${result.summary.slice(0, 200)}`);
    return taskId;
  };

  const toolsUsed = (companyId: string, since: number) =>
    sql<{ server: string; tool: string; outcome: string }[]>`
      SELECT payload->>'server' AS server, payload->>'tool' AS tool, payload->>'outcome' AS outcome
      FROM ledger_events WHERE company_id = ${companyId} AND event_type = 'tool_call' AND seq > ${since}`;

  // ── Part A: code-mcp with a real model ────────────────────────────────────
  console.log("\n══ Part A — code-mcp (real Haiku writes & runs software) ══");
  const a = await newCompany("full");
  const seqA = (await ledger.head())?.seq ?? 0;
  await runTask(
    a,
    "Build and run a Fibonacci script",
    "Use the code tools: write a Python file that prints the first 10 Fibonacci numbers, run it with `python3`, " +
      "confirm the output, then write a short docs document titled 'Fibonacci output' with the result. Then finish.",
    12,
  );
  const aTools = await toolsUsed(a.id, seqA);
  const aCode = aTools.filter((t) => t.server === "code");
  console.log(`   tools used: ${aTools.map((t) => `${t.server}.${t.tool}`).join(", ") || "none"}`);
  ok(aCode.some((t) => t.tool === "write_file"), "the model used code.write_file");
  ok(aCode.some((t) => t.tool === "exec"), "the model used code.exec to run its program in the sandbox");

  // ── Part B: the approval gate with a real model ───────────────────────────
  console.log("\n══ Part B — approval gate (real Haiku hits an irreversible action) ══");
  const b = await newCompany("supervised");
  // a product for it to try to delete (created deterministically, not by the LLM)
  const setupToken = signToken({ companyId: b.id, taskId: randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 });
  const createRes = await fetch(`${gatewayUrl}/tools/payments/create_product`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${setupToken}` },
    body: JSON.stringify({ name: "Legacy widget", priceCents: 900 }),
  });
  const productId = ((await createRes.json()) as { productId: string }).productId;
  const seqB = (await ledger.head())?.seq ?? 0;

  await runTask(
    b,
    "Retire a discontinued product",
    `The product with id ${productId} is discontinued. Remove it from the catalogue using payments.delete_product. ` +
      `If the tool says approval is required, acknowledge that a human must approve and then finish.`,
    6,
  );
  const [pending] = await sql<{ id: string; tool: string }[]>`
    SELECT id, tool FROM approvals WHERE company_id = ${b.id} AND status = 'pending'`;
  ok(pending?.tool === "delete_product", "the model's gated delete_product parked as a pending approval");
  ok(
    (await sql`SELECT 1 FROM products WHERE id = ${productId}`).length === 1,
    "the product still exists — the gate held (nothing executed)",
  );

  // owner approves → the gateway executes it
  const body = JSON.stringify({ decision: "approve", decidedBy: "owner-e2e" });
  const sig = createHmac("sha256", GATEWAY_SECRET).update(body).digest("hex");
  await fetch(`${gatewayUrl}/admin/approvals/${pending!.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sig },
    body,
  });
  ok((await sql`SELECT 1 FROM products WHERE id = ${productId}`).length === 0, "after owner approval the product is actually deleted");
  void seqB;

  const verdict = await ledger.verify();
  ok(verdict.ok, `the whole run is one verified hash chain (head seq ${(await ledger.head())?.seq})`);

  console.log("\nLLM E2E PASSED — a real model used code-mcp to build & run software, and correctly hit the human-in-the-loop gate.");
  server.stop(true);
  await Promise.all(workspaces.map((w) => rm(w, { recursive: true, force: true })));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
