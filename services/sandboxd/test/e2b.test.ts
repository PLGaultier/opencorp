import { describe, expect, test } from "bun:test";
import {
  E2bSandboxPool,
  type E2bCommandOptions,
  type E2bCreateOptions,
  type E2bHost,
  type E2bSandboxHandle,
} from "../src/e2b";
import type { WorkerSpec } from "@opencorp/agentd";

/**
 * E2B pool logic, exercised without an E2B account via an injected transport.
 * The data contract (spec file + bundle in, NDJSON event chunks out) is the
 * same one the subprocess pool tests for real against a live agentd.
 */
class FakeE2bSandbox implements E2bSandboxHandle {
  killed = false;
  files: { path: string; data: string }[] = [];
  command: { cmd: string; opts: E2bCommandOptions } | null = null;

  constructor(
    readonly id: string,
    /** Stdout chunks to emit — deliberately not aligned to line boundaries. */
    private chunks: string[],
    private exitCode = 0,
    private hangs = false,
  ) {}

  async writeFiles(files: { path: string; data: string }[]): Promise<void> {
    this.files.push(...files);
  }

  async runCommand(cmd: string, opts: E2bCommandOptions): Promise<{ exitCode: number }> {
    this.command = { cmd, opts };
    for (const chunk of this.chunks) opts.onStdout?.(chunk);
    if (this.hangs) {
      // Simulate a runaway worker: resolve only once the sandbox is killed.
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (this.killed) {
            clearInterval(poll);
            resolve();
          }
        }, 5);
      });
      throw new Error("sandbox terminated");
    }
    return { exitCode: this.exitCode };
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

class FakeE2bHost implements E2bHost {
  created: { sandbox: FakeE2bSandbox; opts: E2bCreateOptions }[] = [];
  private nextId = 0;

  constructor(
    private chunks: string[],
    private exitCode = 0,
    private hangs = false,
  ) {}

  async createSandbox(opts: E2bCreateOptions): Promise<E2bSandboxHandle> {
    const sandbox = new FakeE2bSandbox(`sb-${this.nextId++}`, this.chunks, this.exitCode, this.hangs);
    this.created.push({ sandbox, opts });
    return sandbox;
  }
}

const agentdMain = new URL("../../agentd/src/main.ts", import.meta.url).pathname;

function makePool(host: E2bHost) {
  return new E2bSandboxPool({ host, agentdEntry: agentdMain });
}

const spec: WorkerSpec = {
  gatewayUrl: "http://gateway.example.com",
  token: "tok",
  task: { id: "t1", title: "Ship it", description: "go" },
  company: { name: "Acme", slug: "acme", mission: "make widgets" },
};

const line = (event: unknown) => JSON.stringify(event) + "\n";

describe("e2b sandbox pool (§8)", () => {
  test("uploads spec + agentd bundle and runs with stdin redirected from the spec", async () => {
    const host = new FakeE2bHost([line({ type: "result", summary: "done", steps: 1 })]);
    const sb = await makePool(host).claim({ taskId: "t1", companyId: "c1" });
    const result = await sb.execAgent(spec);
    expect(result).toEqual({ summary: "done", steps: 1 });

    const fake = host.created[0]!.sandbox;
    const specFile = fake.files.find((f) => f.path === "/home/user/spec.json");
    expect(JSON.parse(specFile!.data)).toEqual(spec);
    const bundle = fake.files.find((f) => f.path === "/home/user/agentd.js");
    expect(bundle!.data).toContain("runWorkerRuntime"); // real bundled agentd
    expect(fake.command!.cmd).toBe("bun /home/user/agentd.js < /home/user/spec.json");
  });

  test("forwards step events even when NDJSON lines are split across chunks", async () => {
    const one = line({ type: "step", n: 1, thought: "thinking", tool: "org.read_mission" });
    const two = line({ type: "step", n: 2, thought: "writing" });
    const done = line({ type: "result", summary: "ok", steps: 2 });
    // Re-chunk the stream mid-line: transports owe us bytes, not lines.
    const raw = one + two + done;
    const chunks = [raw.slice(0, 17), raw.slice(17, 90), raw.slice(90)];

    const host = new FakeE2bHost(chunks);
    const sb = await makePool(host).claim({ taskId: "t", companyId: "c" });
    const steps: string[] = [];
    const result = await sb.execAgent(spec, (s) => steps.push(`${s.n}:${s.tool ?? ""}`));
    expect(result).toEqual({ summary: "ok", steps: 2 });
    expect(steps).toEqual(["1:org.read_mission", "2:"]);
  });

  test("a terminal error event rethrows in the host (so TaskRun refunds)", async () => {
    const host = new FakeE2bHost([line({ type: "error", message: "boom" })], 1);
    const sb = await makePool(host).claim({ taskId: "t", companyId: "c" });
    await expect(sb.execAgent(spec)).rejects.toThrow("boom");
    await sb.release();
  });

  test("kills the sandbox on release and never reuses it (§5.3)", async () => {
    const host = new FakeE2bHost([line({ type: "result", summary: "ok", steps: 1 })]);
    const pool = makePool(host);
    const sb = await pool.claim({ taskId: "t", companyId: "c" });
    await sb.execAgent(spec);
    await expect(sb.execAgent(spec)).rejects.toThrow("sandbox_already_used");
    await sb.release();
    expect(host.created[0]!.sandbox.killed).toBe(true);
    expect(pool.stats().inUse).toBe(0);
  });

  test("enforces the wall clock by killing the sandbox", async () => {
    const host = new FakeE2bHost([], 0, /* hangs */ true);
    const pool = makePool(host);
    const sb = await pool.claim({ taskId: "t", companyId: "c", budgets: { maxWallClockMs: 50 } });
    await expect(sb.execAgent(spec)).rejects.toThrow("wall_clock_budget_exceeded");
    expect(host.created[0]!.sandbox.killed).toBe(true);
    await sb.release();
  });

  test("rejects loopback gateway/LLM URLs — unreachable from E2B's cloud", async () => {
    const host = new FakeE2bHost([line({ type: "result", summary: "ok", steps: 1 })]);
    const sb = await makePool(host).claim({ taskId: "t", companyId: "c" });
    await expect(
      sb.execAgent({ ...spec, gatewayUrl: "http://localhost:3004" }),
    ).rejects.toThrow("e2b_requires_public_gateway_url");

    const sb2 = await makePool(host).claim({ taskId: "t", companyId: "c" });
    await expect(
      sb2.execAgent({ ...spec, env: { LITELLM_URL: "http://127.0.0.1:4000" } }),
    ).rejects.toThrow("e2b_requires_public_gateway_url");
  });

  test("tags the sandbox with task/company metadata and a bounded lifetime", async () => {
    const host = new FakeE2bHost([line({ type: "result", summary: "ok", steps: 1 })]);
    await makePool(host).claim({
      taskId: "task-42",
      companyId: "co-7",
      budgets: { maxWallClockMs: 120_000 },
    });
    const opts = host.created[0]!.opts;
    expect(opts.metadata).toEqual({ taskId: "task-42", companyId: "co-7" });
    expect(opts.timeoutMs).toBe(180_000); // wall + 60 s grace for E2B's reaper
    expect(opts.template).toBe("opencorp-agentd");
  });

  test("fails fast without an API key when no host is injected", () => {
    const saved = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      expect(() => new E2bSandboxPool({ agentdEntry: agentdMain })).toThrow("e2b_api_key_missing");
    } finally {
      if (saved !== undefined) process.env.E2B_API_KEY = saved;
    }
  });
});
