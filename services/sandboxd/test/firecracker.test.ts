import { describe, expect, test } from "bun:test";
import {
  FirecrackerSandboxPool,
  firecrackerSupported,
  type FirecrackerHost,
  type VmHandle,
} from "../src/firecracker";
import type { WorkerSpec } from "@opencorp/agentd";

/**
 * Firecracker pool logic, exercised off bare metal via an injected transport.
 * The real Linux/KVM path can't boot a VM here, but the pool's lifecycle —
 * spawn → stream events → destroy, one task per VM, never reused — is fully
 * covered. The data contract (spec in, NDJSON events out) is identical to the
 * subprocess pool, which is tested for real.
 */
class FakeVm implements VmHandle {
  destroyed = false;
  receivedSpec: WorkerSpec | null = null;
  constructor(
    readonly id: string,
    private lines: string[],
  ) {}
  async exec(spec: WorkerSpec, onLine: (line: string) => void): Promise<void> {
    this.receivedSpec = spec;
    for (const line of this.lines) onLine(line);
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

class FakeHost implements FirecrackerHost {
  spawned: FakeVm[] = [];
  constructor(private lines: string[]) {}
  async spawnVm(id: string): Promise<VmHandle> {
    const vm = new FakeVm(id, this.lines);
    this.spawned.push(vm);
    return vm;
  }
}

const spec: WorkerSpec = {
  gatewayUrl: "http://gateway",
  token: "tok",
  task: { id: "t1", title: "Ship it", description: "go" },
  company: { name: "Acme", slug: "acme", mission: "make widgets" },
};

describe("firecracker sandbox pool (§8)", () => {
  test("delivers the spec, forwards step events, returns the result", async () => {
    const host = new FakeHost([
      JSON.stringify({ type: "step", n: 1, thought: "thinking", tool: "org.read_mission" }),
      JSON.stringify({ type: "step", n: 2, thought: "writing" }),
      JSON.stringify({ type: "result", summary: "done", steps: 2 }),
    ]);
    const pool = new FirecrackerSandboxPool({ host, warmTarget: 0 });
    const sb = await pool.claim({ taskId: "t1", companyId: "c1" });
    const steps: string[] = [];
    const result = await sb.execAgent(spec, (s) => steps.push(`${s.n}:${s.tool ?? ""}`));
    expect(result).toEqual({ summary: "done", steps: 2 });
    expect(steps).toEqual(["1:org.read_mission", "2:"]);
    expect(host.spawned[0]!.receivedSpec).toEqual(spec);
  });

  test("destroys the microVM on release and never reuses it (§5.3)", async () => {
    const host = new FakeHost([JSON.stringify({ type: "result", summary: "ok", steps: 1 })]);
    const pool = new FirecrackerSandboxPool({ host, warmTarget: 0 });
    const sb = await pool.claim({ taskId: "t", companyId: "c" });
    await sb.execAgent(spec);
    await expect(sb.execAgent(spec)).rejects.toThrow("sandbox_already_used");
    await sb.release();
    expect(host.spawned[0]!.destroyed).toBe(true);
    expect(pool.stats().inUse).toBe(0);
  });

  test("a terminal error event rethrows in the host (so TaskRun refunds)", async () => {
    const host = new FakeHost([JSON.stringify({ type: "error", message: "boom" })]);
    const pool = new FirecrackerSandboxPool({ host, warmTarget: 0 });
    const sb = await pool.claim({ taskId: "t", companyId: "c" });
    await expect(sb.execAgent(spec)).rejects.toThrow("boom");
    await sb.release();
  });

  test("prewarm pre-boots VMs up to the warm target", async () => {
    const host = new FakeHost([JSON.stringify({ type: "result", summary: "ok", steps: 1 })]);
    const pool = new FirecrackerSandboxPool({ host, warmTarget: 3 });
    await pool.prewarm();
    expect(host.spawned.length).toBe(3);
  });

  test("refuses to construct on a host without KVM", () => {
    // On this dev machine (darwin) firecrackerSupported() is false, so the pool
    // must fail loudly rather than silently fake isolation.
    if (firecrackerSupported()) return; // skip on real bare metal
    expect(() => new FirecrackerSandboxPool()).toThrow("firecracker_unsupported_host");
  });
});
