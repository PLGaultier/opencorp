import { randomUUID } from "node:crypto";
import type { WorkerSpec, WorkerTaskResult } from "@opencorp/agentd";
import { CapacityGate, type OnStep, type Sandbox, type SandboxPool, type SandboxSpec } from "./pool";
import { WorkerEventSink, pumpLines } from "./events";

/**
 * Subprocess sandbox pool (§8). Runs the `agentd` worker as a separate OS
 * process: a crash, infinite loop, or memory blowup in AI-written code is
 * contained to that process and forcibly killable — none of which is true of the
 * in-process LocalSandboxPool. This is the default isolation for local runs,
 * and the exact same transport shape (write spec → read NDJSON) that the E2B
 * pool uses against the hosted-sandbox API, so the agent loop is byte-for-byte
 * unchanged across the two.
 */
export interface SubprocessPoolOptions {
  capacity?: number;
  /**
   * Path to the agentd entry (its `main.ts`). Defaults to the resolved
   * `@opencorp/agentd/main`, overridable via AGENTD_ENTRY for packaged builds.
   */
  entry?: string;
  /** Runtime used to execute the entry; `bun` by default. */
  runtime?: string;
}

export function resolveAgentdEntry(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.AGENTD_ENTRY) return process.env.AGENTD_ENTRY;
  try {
    return Bun.resolveSync("@opencorp/agentd/main", process.cwd());
  } catch {
    // Fallback for in-repo execution when the workspace export isn't resolvable.
    return new URL("../../agentd/src/main.ts", import.meta.url).pathname;
  }
}

class SubprocessSandbox implements Sandbox {
  readonly id = `subproc-${randomUUID().slice(0, 8)}`;
  private released = false;
  private used = false;
  private child: ReturnType<typeof Bun.spawn> | null = null;

  constructor(
    private budgets: SandboxSpec["budgets"],
    private runtime: string,
    private entry: string,
    private onRelease: () => void,
  ) {}

  async execAgent(spec: WorkerSpec, onStep?: OnStep): Promise<WorkerTaskResult> {
    if (this.released) throw new Error("sandbox_already_released");
    if (this.used) throw new Error("sandbox_already_used"); // one task per sandbox (§5.3)
    this.used = true;

    const child = Bun.spawn({
      cmd: [this.runtime, this.entry],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      // The sandbox gets a curated env (LLM endpoint, etc.); the scoped MCP token
      // travels in the spec. Real secrets would be injected via Infisical (§8).
      env: { ...process.env, ...spec.env },
    });
    this.child = child;

    // Deliver the spec, then close stdin so the runtime starts.
    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();

    // Hard wall-clock cap, enforced by killing the process — never the prompt (§5.3).
    const wall = this.budgets?.maxWallClockMs ?? spec.budgets?.maxWallClockMs;
    let timedOut = false;
    const timer = wall
      ? setTimeout(() => {
          timedOut = true;
          child.kill(9);
        }, wall)
      : null;

    const sink = new WorkerEventSink(onStep);
    try {
      await pumpLines(child.stdout as ReadableStream<Uint8Array>, (line) => sink.feed(line));
      const code = await child.exited;
      if (timedOut) throw new Error("wall_clock_budget_exceeded");
      return sink.finish(`agentd exited with code ${code}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async run<T>(): Promise<T> {
    // The closure escape hatch only makes sense in-process; an isolated sandbox
    // cannot receive a host closure across the process boundary.
    throw new Error("subprocess_sandbox_requires_execAgent");
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.child?.kill(9); // ensure no orphaned worker survives the task
    this.onRelease();
  }
}

export class SubprocessSandboxPool implements SandboxPool {
  readonly kind = "subprocess";
  private gate: CapacityGate;
  private runtime: string;
  private entry: string;

  constructor(opts: SubprocessPoolOptions = {}) {
    this.gate = new CapacityGate(opts.capacity ?? 64);
    this.runtime = opts.runtime ?? "bun";
    this.entry = resolveAgentdEntry(opts.entry);
  }

  async claim(spec: SandboxSpec): Promise<Sandbox> {
    await this.gate.acquire();
    return new SubprocessSandbox(spec.budgets, this.runtime, this.entry, () => this.gate.release());
  }

  stats() {
    return this.gate.stats(this.kind);
  }
}
