/**
 * CEO "brains" levels (§10) — a playful ladder the owner sets per company that
 * decides which model bundle powers the agents. It's implemented as a *shift*
 * along the tier ladder [mini → standard → frontier], so a smarter level bumps
 * every agent call up a tier (more capable model, more real cost) and a cheaper
 * level bumps it down. Cost metering (pricing.ts) then reflects the true spend.
 */
import type { ModelTier } from "./client";

export type ModelLevel = "intern" | "grad" | "phd";

/** Tier ladder, cheap → capable. The shift indexes into this. */
export const TIER_LADDER: ModelTier[] = ["mini", "standard", "frontier"];

/** How far each level shifts every requested tier along the ladder. */
const LEVEL_SHIFT: Record<ModelLevel, number> = {
  intern: -1, // pinches pennies — everything one tier cheaper
  grad: 0, // the default the agents were tuned on
  phd: +1, // galaxy brain — everything one tier pricier
};

export const MODEL_LEVELS: readonly ModelLevel[] = ["intern", "grad", "phd"];

export function isModelLevel(v: unknown): v is ModelLevel {
  return typeof v === "string" && (MODEL_LEVELS as readonly string[]).includes(v);
}

/** Tier shift for a level; unknown/missing falls back to the default (grad). */
export function tierShiftForLevel(level: string | null | undefined): number {
  return isModelLevel(level) ? LEVEL_SHIFT[level] : 0;
}

/** Apply a shift to a requested tier, clamped to the ends of the ladder. */
export function shiftTier(tier: ModelTier, shift: number): ModelTier {
  const idx = TIER_LADDER.indexOf(tier);
  const next = Math.max(0, Math.min(TIER_LADDER.length - 1, idx + shift));
  return TIER_LADDER[next]!;
}
