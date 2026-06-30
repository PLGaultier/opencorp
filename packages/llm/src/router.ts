/**
 * Deterministic per-task model routing (OPE-7, Part 1).
 *
 * Instead of pinning a tier per call site, every CEO/department call asks
 * `routeTier()` which tier its work deserves, from an explicit, pure policy
 * keyed on **taskKind × complexity × stakes**. The default is cheap; we escalate
 * deliberately — expensive tokens go to decisions that move revenue (high
 * stakes) or are genuinely hard, while routine triage runs on the floor model.
 *
 * Composition (unchanged downstream): routeTier picks the *base* tier →
 * `levels.ts` `shiftTier` applies the per-company brains shift → OPE-6 bundle
 * resolution (`client.ts`) picks the provider family. This module only inserts
 * the first step, and is a pure function with no I/O so it's fully unit-testable.
 *
 * Out of scope (→ OPE-7b): a cheap-model classifier for ambiguous kinds, and the
 * budget/margin guardrail. The signal derivation here is purely deterministic.
 */
import type { ModelTier } from "./client";
import type { CeoContext } from "./ceo";
import { TIER_LADDER } from "./levels";

/**
 * What kind of call this is — the caller knows by construction (e.g. `ceoChat`
 * passes `owner_chat`, a schema-repair retry passes `schema_repair_retry`).
 * Extend as more paths are wired (email_triage/content_generation/code_task → OPE-7b).
 */
export type TaskKind =
  | "heartbeat_plan"
  | "heartbeat_noop"
  | "owner_chat"
  | "owner_chat_directive"
  | "department_synthesis"
  | "schema_repair_retry";

/** How much there is to reason about, derived from signals the caller already has. */
export type Complexity = "trivial" | "routine" | "hard";

/** Whether the output spends money, changes the mission, or emails a customer. */
export type Stakes = "low" | "high";

export interface RouteInput {
  taskKind: TaskKind;
  /** Defaults to `routine` when the caller can't tell. */
  complexity?: Complexity;
  /** Defaults to `low` when the caller can't tell. */
  stakes?: Stakes;
  /**
   * For `schema_repair_retry`: the tier of the call that failed. The retry never
   * routes below it — a cheaper model is less likely to fix the JSON.
   */
  baseTier?: ModelTier;
}

export interface RouteDecision {
  tier: ModelTier;
  /** Human-readable why, recorded on the trace so routing is auditable/tunable. */
  reason: string;
}

/** The generic ladder for kinds that route purely by how hard the work is. */
const BY_COMPLEXITY: Record<Complexity, ModelTier> = {
  trivial: "mini",
  routine: "standard",
  hard: "frontier",
};

const rank = (t: ModelTier): number => TIER_LADDER.indexOf(t);
/** The pricier of two tiers (used to enforce a floor). */
const maxTier = (a: ModelTier, b: ModelTier): ModelTier => (rank(a) >= rank(b) ? a : b);

/**
 * The policy table (OPE-7). Pure: `(taskKind, complexity, stakes) → base tier`.
 * This is the single place tier literals are allowed to live; call sites must
 * route through it. Tune the cells here, with tests, rather than at call sites.
 */
export function routeTier(input: RouteInput): RouteDecision {
  const { taskKind } = input;
  const complexity = input.complexity ?? "routine";
  const stakes = input.stakes ?? "low";

  switch (taskKind) {
    case "schema_repair_retry": {
      // Hold the failed call's tier; never downshift (a cheaper model is less
      // likely to repair the JSON than the one that produced it).
      const tier = input.baseTier ?? "frontier";
      return { tier, reason: `schema repair holds the failed call's tier (${tier})` };
    }

    case "heartbeat_noop":
      // Empty queue, nothing happened — the floor model writes the "nothing to do"
      // brief. Cheapest tier regardless of the other signals.
      return { tier: "mini", reason: "no-op heartbeat → floor tier (mini)" };

    case "owner_chat": {
      // Routine status chat is cheap; only a high-stakes answer warrants standard.
      const tier: ModelTier = stakes === "high" ? "standard" : "mini";
      return { tier, reason: `owner chat (${stakes} stakes) → ${tier}` };
    }

    case "owner_chat_directive": {
      // The owner is directing work (queues tasks / spends credits) — never the
      // floor model; a genuinely hard directive earns frontier.
      const tier: ModelTier = complexity === "hard" ? "frontier" : "standard";
      return { tier, reason: `owner directive (${complexity}) → ${tier}` };
    }

    case "department_synthesis": {
      // Sub-planners feed the CEO, who makes the call — keep them cheap. Escalate
      // to standard only when the slice is hard or high-stakes; never above
      // standard (frontier is reserved for the CEO's synthesis).
      const tier: ModelTier = complexity === "hard" || stakes === "high" ? "standard" : "mini";
      return { tier, reason: `department synthesis (${complexity}/${stakes}) → ${tier}` };
    }

    case "heartbeat_plan": {
      // The strategic call. Full ladder by complexity; high stakes is never
      // decided on the floor model.
      let tier = BY_COMPLEXITY[complexity];
      if (stakes === "high") tier = maxTier(tier, "standard");
      return { tier, reason: `heartbeat plan (${complexity}/${stakes}) → ${tier}` };
    }
  }
}

// ── Deterministic signal derivation (the caller's context → complexity/stakes) ──
// Kept here, not at the call sites, so it's testable in one place (per the
// ticket's open question). No LLM call — purely the numbers already in context.

/** True when there is real activity to reason about (failures, inbox, approvals). */
function hasMess(ctx: CeoContext): boolean {
  const failed = ctx.recentReports.filter((r) => r.status === "failed").length;
  return failed > 0 || ctx.unreadEmails.length > 0 || (ctx.pendingApprovals?.length ?? 0) > 0;
}

/** Complexity from context: hard when there's a mess or a deep queue. */
function contextComplexity(ctx: CeoContext): Complexity {
  const failed = ctx.recentReports.filter((r) => r.status === "failed").length;
  if (failed > 0 || (ctx.pendingApprovals?.length ?? 0) > 0 || ctx.unreadEmails.length >= 3 || ctx.queuedTasks >= 5) {
    return "hard";
  }
  if (ctx.unreadEmails.length > 0 || ctx.queuedTasks > 0) return "routine";
  return "trivial";
}

/** Stakes from context: high when the plan will move money or touch customers. */
function contextStakes(ctx: CeoContext): Stakes {
  return ctx.revenueCents24h > 0 || hasMess(ctx) ? "high" : "low";
}

/**
 * Heartbeat routing signals. A heartbeat with nothing queued, no failures, no
 * inbox, no approvals, and no revenue is a no-op (cheapest); anything else is a
 * real plan whose tier scales with how messy/valuable the situation is.
 */
export function deriveHeartbeatSignals(ctx: CeoContext): {
  taskKind: Extract<TaskKind, "heartbeat_plan" | "heartbeat_noop">;
  complexity: Complexity;
  stakes: Stakes;
} {
  const quiet = ctx.queuedTasks === 0 && ctx.revenueCents24h === 0 && !hasMess(ctx);
  return {
    taskKind: quiet ? "heartbeat_noop" : "heartbeat_plan",
    complexity: contextComplexity(ctx),
    stakes: contextStakes(ctx),
  };
}

/** Department sub-planner signals (same context read, kind pinned to synthesis). */
export function deriveDepartmentSignals(ctx: CeoContext): { complexity: Complexity; stakes: Stakes } {
  return { complexity: contextComplexity(ctx), stakes: contextStakes(ctx) };
}

/**
 * Owner-chat signals. Part 1 is deterministic: an explicit `task:` directive (the
 * same prefix the deterministic fallback honors) is a high-stakes directive that
 * queues work; everything else is plain chat. Natural-language directive
 * detection needs the cheap-model classifier — that's OPE-7b.
 */
export function deriveChatSignals(message: string): {
  taskKind: Extract<TaskKind, "owner_chat" | "owner_chat_directive">;
  complexity: Complexity;
  stakes: Stakes;
} {
  const isDirective = /^\s*task:\s*\S/i.test(message);
  return isDirective
    ? { taskKind: "owner_chat_directive", complexity: "routine", stakes: "high" }
    : { taskKind: "owner_chat", complexity: "routine", stakes: "low" };
}
