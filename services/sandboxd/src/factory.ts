import { LocalSandboxPool, type SandboxPool } from "./pool";
import { SubprocessSandboxPool } from "./subprocess";
import { E2bSandboxPool } from "./e2b";

/**
 * Select the execution-plane pool by config (§8). The agent loop is identical
 * across all three; only the isolation boundary changes:
 *   - local       in-process (dev/tests; no isolation)
 *   - subprocess  separate OS process (crash/memory isolation; local default)
 *   - e2b         one hosted microVM per task on e2b.dev — prod default; needs
 *                 E2B_API_KEY and publicly reachable gateway/LLM URLs
 * This is the seam the spec calls out: swap the isolation boundary without
 * touching the agent loop.
 */
export type SandboxKind = "local" | "subprocess" | "e2b";

export interface CreateSandboxPoolOptions {
  kind?: SandboxKind;
  capacity?: number;
}

export function createSandboxPool(opts: CreateSandboxPoolOptions = {}): SandboxPool {
  const kind = (opts.kind ?? process.env.SANDBOX_KIND ?? "local") as SandboxKind;
  const capacity = opts.capacity ?? Number(process.env.SANDBOX_CAPACITY ?? 64);

  // §8 — `local`/`subprocess` run agent-authored code without VM isolation: a
  // sandbox escape reaches the host's filesystem and private network. That's
  // fine for a trusted dev laptop, but a prod deploy that forgets
  // SANDBOX_KIND=e2b would silently run every company unsandboxed. Fail closed
  // in production unless the operator explicitly accepts the risk.
  const isolated = kind === "e2b";
  if (!isolated && process.env.NODE_ENV === "production" && process.env.ALLOW_UNSAFE_SANDBOX !== "1") {
    throw new Error(
      `refusing SANDBOX_KIND=${kind} in production: agent code would run without VM isolation. ` +
        `Set SANDBOX_KIND=e2b, or ALLOW_UNSAFE_SANDBOX=1 to override deliberately.`,
    );
  }
  // Make the active isolation boundary visible at boot — no silent fail-open.
  console.error(`[sandboxd] execution plane: SANDBOX_KIND=${kind}${isolated ? "" : " (no VM isolation)"}`);

  switch (kind) {
    case "local":
      return new LocalSandboxPool(capacity);
    case "subprocess":
      return new SubprocessSandboxPool({ capacity });
    case "e2b":
      // Only forward an explicit capacity: the pool's own default (16) stays
      // under E2B's Hobby-plan concurrency limit, unlike the generic 64.
      return new E2bSandboxPool({
        capacity: opts.capacity ?? (process.env.SANDBOX_CAPACITY ? capacity : undefined),
        templateId: process.env.E2B_TEMPLATE_ID,
      });
    default:
      throw new Error(`unknown SANDBOX_KIND: ${kind} (expected local|subprocess|e2b)`);
  }
}
