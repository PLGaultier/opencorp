import { LocalSandboxPool, type SandboxPool } from "./pool";
import { SubprocessSandboxPool } from "./subprocess";
import { FirecrackerSandboxPool } from "./firecracker";

/**
 * Select the execution-plane pool by config (§8). The agent loop is identical
 * across all three; only the isolation boundary changes:
 *   - local       in-process (dev/tests; no isolation)
 *   - subprocess  separate OS process (real isolation, no KVM needed) — default in prod off bare metal
 *   - firecracker snapshot-restored microVMs (bare metal + KVM)
 * This is the seam the spec calls out: "swap for the Firecracker pool on bare
 * metal without touching the agent loop."
 */
export type SandboxKind = "local" | "subprocess" | "firecracker";

export interface CreateSandboxPoolOptions {
  kind?: SandboxKind;
  capacity?: number;
}

export function createSandboxPool(opts: CreateSandboxPoolOptions = {}): SandboxPool {
  const kind = (opts.kind ?? process.env.SANDBOX_KIND ?? "local") as SandboxKind;
  const capacity = opts.capacity ?? Number(process.env.SANDBOX_CAPACITY ?? 64);
  switch (kind) {
    case "local":
      return new LocalSandboxPool(capacity);
    case "subprocess":
      return new SubprocessSandboxPool({ capacity });
    case "firecracker":
      return new FirecrackerSandboxPool({ capacity });
    default:
      throw new Error(`unknown SANDBOX_KIND: ${kind} (expected local|subprocess|firecracker)`);
  }
}
