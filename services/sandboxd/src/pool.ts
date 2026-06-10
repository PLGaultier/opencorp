import { randomUUID } from "node:crypto";

/**
 * Sandbox pool (§8). The execution-plane seam: a worker claims an isolated
 * sandbox, runs its agent loop inside it, and releases it (sandboxes are never
 * reused across tasks, §5.3). The interface is what the rest of the platform
 * depends on; the implementation is swappable:
 *   - LocalSandboxPool: runs the loop in-process (M2/M3 + dev/tests).
 *   - FirecrackerPool (M4 bare-metal, Go sandboxd): snapshot-restored microVMs.
 *   - GvisorPool: runsc pods, weaker isolation, same API (§8 fallback).
 * Because the contract is just {claim → run → release}, the agent loop moves
 * between them unchanged.
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

export interface Sandbox {
  readonly id: string;
  /** Run work inside the sandbox; enforces the wall-clock budget. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
}

export interface SandboxPool {
  readonly kind: string;
  claim(spec: SandboxSpec): Promise<Sandbox>;
  stats(): { kind: string; inUse: number; capacity: number };
}

class LocalSandbox implements Sandbox {
  readonly id = `local-${randomUUID().slice(0, 8)}`;
  private released = false;
  constructor(
    private budgets: SandboxBudgets | undefined,
    private onRelease: () => void,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.released) throw new Error("sandbox_already_released");
    const wall = this.budgets?.maxWallClockMs;
    if (!wall) return fn();
    // Hard wall-clock cap enforced by the host, not the prompt (§5.3).
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("wall_clock_budget_exceeded")), wall);
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.onRelease();
  }
}

/**
 * In-process pool with a concurrency ceiling. `capacity` models the §11.3
 * autoscaler target (keep pool ≥ max(2, 1.2 × concurrent tasks)); claims past
 * capacity queue rather than over-subscribe the host.
 */
export class LocalSandboxPool implements SandboxPool {
  readonly kind = "local";
  private inUse = 0;
  private waiters: (() => void)[] = [];

  constructor(private capacity = 64) {}

  async claim(spec: SandboxSpec): Promise<Sandbox> {
    void spec;
    if (this.inUse >= this.capacity) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inUse++;
    return new LocalSandbox(spec.budgets, () => {
      this.inUse--;
      this.waiters.shift()?.();
    });
  }

  stats() {
    return { kind: this.kind, inUse: this.inUse, capacity: this.capacity };
  }
}
