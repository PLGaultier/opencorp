import { randomUUID } from "node:crypto";
import { runWorkerTask, type WorkerSpec, type WorkerTaskResult } from "@opencorp/agentd";

/**
 * Sandbox pool (§8). The execution-plane seam: a worker claims an isolated
 * sandbox, runs its agent loop inside it via `execAgent`, and releases it
 * (sandboxes are never reused across tasks, §5.3). The interface is what the
 * rest of the platform depends on; the implementation is swappable:
 *   - LocalSandboxPool: runs the loop in-process (dev/tests; no isolation).
 *   - SubprocessSandboxPool: runs `agentd` as a separate OS process (real
 *     crash/memory isolation, killable; the local default).
 *   - E2bSandboxPool: one hosted microVM per task on e2b.dev (§8; prod).
 * Because the contract is just {claim → execAgent(spec) → release}, the agent
 * loop moves between them unchanged — the only difference is where the bytes of
 * the spec are delivered (function call, pipe, or vsock).
 */
export interface SandboxBudgets {
  maxSteps?: number;
  maxWallClockMs?: number;
}

export interface SandboxSpec {
  taskId: string;
  companyId: string;
  budgets?: SandboxBudgets;
}

/** Step callback shape, mirrored from the agent loop (§5.3 "every step streamed"). */
export type OnStep = (step: { n: number; thought: string; tool?: string }) => void;

export interface Sandbox {
  readonly id: string;
  /** Canonical entry point: run the worker agent from a serializable spec (§8). */
  execAgent(spec: WorkerSpec, onStep?: OnStep): Promise<WorkerTaskResult>;
  /** Low-level escape hatch (in-process pools only); enforces the wall-clock budget. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
}

export interface SandboxPool {
  readonly kind: string;
  claim(spec: SandboxSpec): Promise<Sandbox>;
  stats(): { kind: string; inUse: number; capacity: number };
}

/**
 * Concurrency ceiling shared by every pool. `capacity` models the §11.3
 * autoscaler target (keep pool ≥ max(2, 1.2 × concurrent tasks)); claims past
 * capacity queue rather than over-subscribe the host.
 */
export class CapacityGate {
  private inUse = 0;
  private waiters: (() => void)[] = [];
  constructor(private capacity: number) {}

  async acquire(): Promise<void> {
    if (this.inUse >= this.capacity) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inUse++;
  }

  release(): void {
    this.inUse--;
    this.waiters.shift()?.();
  }

  stats(kind: string) {
    return { kind, inUse: this.inUse, capacity: this.capacity };
  }
}

/** Enforce a hard wall-clock cap on a promise — by the host, never the prompt (§5.3). */
export async function withWallClock<T>(fn: () => Promise<T>, ms?: number): Promise<T> {
  if (!ms) return fn();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("wall_clock_budget_exceeded")), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

class LocalSandbox implements Sandbox {
  readonly id = `local-${randomUUID().slice(0, 8)}`;
  private released = false;
  constructor(
    private budgets: SandboxBudgets | undefined,
    private onRelease: () => void,
  ) {}

  async execAgent(spec: WorkerSpec, onStep?: OnStep): Promise<WorkerTaskResult> {
    // In-process: the loop runs in the host's own memory (no isolation). Used in
    // dev/tests; prod selects subprocess or e2b.
    return this.run(() =>
      runWorkerTask({
        gatewayUrl: spec.gatewayUrl,
        token: spec.token,
        task: spec.task,
        company: spec.company,
        budgets: spec.budgets,
        traceId: spec.traceId,
        onStep,
      }),
    );
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.released) throw new Error("sandbox_already_released");
    return withWallClock(fn, this.budgets?.maxWallClockMs);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.onRelease();
  }
}

export class LocalSandboxPool implements SandboxPool {
  readonly kind = "local";
  private gate: CapacityGate;

  constructor(capacity = 64) {
    this.gate = new CapacityGate(capacity);
  }

  async claim(spec: SandboxSpec): Promise<Sandbox> {
    await this.gate.acquire();
    return new LocalSandbox(spec.budgets, () => this.gate.release());
  }

  stats() {
    return this.gate.stats(this.kind);
  }
}
