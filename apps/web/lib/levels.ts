import type { ModelLevel } from "./data";

/**
 * Display metadata for the CEO "brains" ladder (§10). The id + ordering mirror
 * the backend `model_level` enum and its tier shift; the cost multiplier and
 * per-task estimate are rough, for the Engine widget's "what will this spend?".
 */
export interface LevelMeta {
  id: ModelLevel;
  name: string;
  tagline: string;
  model: string;
  costMult: number;
  /** Typical real cost per task at this level, in cents (rough estimate). */
  perTaskCents: number;
}

export const LEVELS: LevelMeta[] = [
  { id: "intern", name: "Intern", tagline: "Cheapest — fast, frugal reasoning.", model: "Haiku 4.5", costMult: 1, perTaskCents: 90 },
  { id: "grad", name: "Grad", tagline: "Balanced default.", model: "Sonnet 4.6", costMult: 3, perTaskCents: 200 },
  { id: "phd", name: "PhD", tagline: "Most capable — frontier model.", model: "Opus 4.8", costMult: 5, perTaskCents: 340 },
];

export const levelMeta = (id: ModelLevel): LevelMeta => LEVELS.find((l) => l.id === id) ?? LEVELS[1]!;
