import type { ModelLevel } from "./data";

/**
 * Display metadata for the CEO "brains" ladder (§10). The id + ordering mirror
 * the backend `model_level` enum and its tier shift; the cost multiplier and
 * per-task estimate are rough, for the Engine widget's "what will this spend?".
 */
export interface LevelMeta {
  id: ModelLevel;
  emoji: string;
  name: string;
  tagline: string;
  model: string;
  costMult: number;
  /** Typical real cost per task at this level, in cents (rough estimate). */
  perTaskCents: number;
}

export const LEVELS: LevelMeta[] = [
  { id: "intern", emoji: "🐣", name: "Intern", tagline: "Eager and cheap — pinches every credit.", model: "Haiku-grade", costMult: 0.6, perTaskCents: 90 },
  { id: "grad", emoji: "🎓", name: "Grad", tagline: "Balanced default — solid everyday reasoning.", model: "Sonnet-grade", costMult: 1, perTaskCents: 150 },
  { id: "phd", emoji: "🧠", name: "PhD", tagline: "Galaxy brain — frontier model, burns credits.", model: "Opus-grade", costMult: 2, perTaskCents: 320 },
];

export const levelMeta = (id: ModelLevel): LevelMeta => LEVELS.find((l) => l.id === id) ?? LEVELS[1]!;
