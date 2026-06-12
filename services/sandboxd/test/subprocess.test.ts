import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SubprocessSandboxPool } from "../src/subprocess";

/**
 * Subprocess pool (§8): real OS-process isolation. These run the actual agentd
 * runtime as a child process against a fake MCP gateway, exercising the full
 * serialize-spec → stream-NDJSON-events seam — the same contract Firecracker
 * uses over vsock. The agent runs offline (LITELLM_URL="" → scripted policy) so
 * no API key is needed.
 */
const agentdMain = new URL("../../agentd/src/main.ts", import.meta.url).pathname;
const slowFixture = new URL("./fixtures/slow-agentd.ts", import.meta.url).pathname;

let gateway: ReturnType<typeof Bun.serve>;
let gatewayUrl: string;

beforeAll(() => {
  // Fake gateway: every tool call succeeds with an empty result — enough for the
  // scripted worker's read_mission → create_document path.
  gateway = Bun.serve({ port: 0, fetch: async () => Response.json({}) });
  gatewayUrl = `http://localhost:${gateway.port}`;
});

afterAll(() => gateway.stop(true));

function specFor(title: string) {
  return {
    gatewayUrl,
    token: "test-token",
    task: { id: "t1", title, description: "do the thing" },
    company: { name: "Acme", slug: "acme", mission: "make widgets" },
    env: { LITELLM_URL: "" }, // force offline scripted policy in the child
  };
}

describe("subprocess sandbox pool (§8, §5.3)", () => {
  test("runs agentd out-of-process, streaming steps and returning the result", async () => {
    const pool = new SubprocessSandboxPool({ entry: agentdMain });
    const sb = await pool.claim({ taskId: "t1", companyId: "c1" });
    const steps: number[] = [];
    const result = await sb.execAgent(specFor("Weekly status report"), (s) => steps.push(s.n));
    await sb.release();
    expect(result.steps).toBe(2);
    expect(result.summary).toContain("Weekly status report");
    expect(steps).toEqual([1, 2]);
    expect(pool.stats().inUse).toBe(0);
  });

  test("enforces the wall-clock budget by killing the process", async () => {
    const pool = new SubprocessSandboxPool({ entry: slowFixture });
    const sb = await pool.claim({ taskId: "t", companyId: "c", budgets: { maxWallClockMs: 100 } });
    const started = Date.now();
    await expect(sb.execAgent(specFor("anything"))).rejects.toThrow("wall_clock_budget_exceeded");
    expect(Date.now() - started).toBeLessThan(5_000); // killed, not waited out
    await sb.release();
  });

  test("one task per sandbox, and none after release (§5.3 no reuse)", async () => {
    const pool = new SubprocessSandboxPool({ entry: agentdMain });
    const sb = await pool.claim({ taskId: "t1", companyId: "c1" });
    await sb.execAgent(specFor("First report"));
    await expect(sb.execAgent(specFor("Second report"))).rejects.toThrow("sandbox_already_used");
    await sb.release();
    await expect(sb.execAgent(specFor("Third report"))).rejects.toThrow("sandbox_already_released");
  });

  test("run() escape hatch is rejected on an isolated sandbox", async () => {
    const pool = new SubprocessSandboxPool({ entry: agentdMain });
    const sb = await pool.claim({ taskId: "t", companyId: "c" });
    await expect(sb.run(async () => 1)).rejects.toThrow("subprocess_sandbox_requires_execAgent");
    await sb.release();
  });
});
