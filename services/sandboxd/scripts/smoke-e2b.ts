#!/usr/bin/env bun
/**
 * Live E2B smoke test (§8). Exercises the exact data path of E2bSandboxPool —
 * real agentd bundle uploaded to a real E2B sandbox, spec delivered via stdin
 * redirect, NDJSON events reassembled through LineBuffer + WorkerEventSink —
 * against a fake MCP gateway running *inside* the sandbox (so no public
 * gateway/tunnel is needed; agentd runs its offline scripted policy).
 *
 * Needs E2B_API_KEY. Uses the `base` template and installs Bun at runtime when
 * the `opencorp-agentd` template (infra/e2b) hasn't been built yet:
 *
 *   bun services/sandboxd/scripts/smoke-e2b.ts [template-id]
 */
import { Sandbox } from "e2b";
import { WorkerEventSink, LineBuffer } from "../src/events";

const template = process.argv[2] ?? "base";
const usesCustomTemplate = template !== "base";
const bun = usesCustomTemplate ? "bun" : "/home/user/.bun/bin/bun";

console.log(`[1/5] bundling agentd (Bun.build, same as the pool)…`);
const entry = new URL("../../agentd/src/main.ts", import.meta.url).pathname;
const build = await Bun.build({ entrypoints: [entry], target: "bun" });
if (!build.success || !build.outputs[0]) throw new Error(`bundle failed: ${build.logs.join("; ")}`);
const bundle = await build.outputs[0].text();
console.log(`      bundle: ${(bundle.length / 1024).toFixed(0)} kB`);

console.log(`[2/5] creating E2B sandbox (template: ${template})…`);
const t0 = Date.now();
const sandbox = await Sandbox.create(template, {
  timeoutMs: 300_000,
  metadata: { taskId: "smoke-task", companyId: "smoke-co" },
});
console.log(`      sandbox ${sandbox.sandboxId} up in ${Date.now() - t0} ms`);
const uname = await sandbox.commands.run("uname -a");
console.log(`      guest: ${uname.stdout.trim()}`);

try {
  if (!usesCustomTemplate) {
    console.log(`[3/5] base template has no Bun — installing at runtime (template skips this)…`);
    await sandbox.commands.run("curl -fsSL https://bun.sh/install | bash", { timeoutMs: 120_000 });
  } else {
    console.log(`[3/5] custom template — Bun pre-installed.`);
  }

  // Fake MCP gateway inside the sandbox: every tool call succeeds with {} —
  // enough for the scripted worker's read_mission → create_document path.
  const spec = {
    gatewayUrl: "http://127.0.0.1:3004", // loopback *inside* the sandbox
    token: "smoke-token",
    task: { id: "smoke-task", title: "Weekly status report", description: "do the thing" },
    company: { name: "Acme", slug: "acme", mission: "make widgets" },
    env: { LITELLM_URL: "" }, // force the offline scripted policy
  };
  console.log(`[4/5] uploading agentd bundle + spec + fake in-sandbox gateway…`);
  await sandbox.files.write([
    { path: "/home/user/agentd.js", data: bundle },
    { path: "/home/user/spec.json", data: JSON.stringify(spec) },
    {
      path: "/home/user/gateway.ts",
      data: `Bun.serve({ port: 3004, fetch: async () => Response.json({}) });`,
    },
  ]);
  await sandbox.commands.run(`${bun} /home/user/gateway.ts`, { background: true });
  await sandbox.commands.run(
    "for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:3004 && exit 0; sleep 0.25; done; exit 1",
    { timeoutMs: 15_000 },
  );

  console.log(`[5/5] running agentd with stdin redirected from the spec (the pool's exact command)…`);
  const sink = new WorkerEventSink((s) => console.log(`      step ${s.n}: ${s.thought}${s.tool ? ` [${s.tool}]` : ""}`));
  const lines = new LineBuffer((line) => sink.feed(line));
  let exitCode = 0;
  try {
    const res = await sandbox.commands.run(`${bun} /home/user/agentd.js < /home/user/spec.json`, {
      timeoutMs: 120_000,
      envs: spec.env,
      onStdout: (chunk) => lines.push(chunk),
    });
    exitCode = res.exitCode;
  } catch (err) {
    const code = (err as { exitCode?: number }).exitCode;
    if (typeof code !== "number") throw err;
    exitCode = code;
  }
  lines.flush();
  const result = sink.finish(`e2b sandbox ${sandbox.sandboxId} exited with code ${exitCode}`);

  if (!result.summary.includes(spec.task.title)) {
    throw new Error(`unexpected summary: ${result.summary}`);
  }
  console.log(`\nPASS — full pipeline OK: ${result.steps} steps, summary: "${result.summary}"`);
} finally {
  await sandbox.kill();
  console.log(`      sandbox ${sandbox.sandboxId} killed.`);
}
