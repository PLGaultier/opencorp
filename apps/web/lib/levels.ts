import type { ModelBundle, ModelLevel } from "./data";

/**
 * Display metadata for the CEO "brains" ladder (§10). The id + ordering mirror
 * the backend `model_level` enum and its tier shift; the cost multiplier and
 * per-task estimate are rough, for the Engine widget's "what will this spend?".
 */
export interface LevelMeta {
  id: ModelLevel;
  name: string;
  tagline: string;
  /** Backing model per provider bundle (OPE-6). Keyed so the card shows the
   *  right family — Anthropic or z.ai GLM — for the company's selected bundle. */
  model: Record<ModelBundle, string>;
  costMult: number;
  /** Typical real cost per task at this level, in cents (rough estimate). */
  perTaskCents: number;
}

export const LEVELS: LevelMeta[] = [
  { id: "intern", name: "Intern", tagline: "Cheapest — fast, frugal reasoning.", model: { anthropic: "Haiku 4.5", glm: "GLM-4.5-Air" }, costMult: 1, perTaskCents: 90 },
  { id: "grad", name: "Grad", tagline: "Balanced default.", model: { anthropic: "Sonnet 4.6", glm: "GLM-4.6" }, costMult: 3, perTaskCents: 200 },
  { id: "phd", name: "PhD", tagline: "Most capable — frontier model.", model: { anthropic: "Opus 4.8", glm: "GLM-4.7" }, costMult: 5, perTaskCents: 340 },
];

export const levelMeta = (id: ModelLevel): LevelMeta => LEVELS.find((l) => l.id === id) ?? LEVELS[1]!;

/** The backing-model label to show for a level under the given provider bundle. */
export const modelLabel = (l: LevelMeta, bundle: ModelBundle): string => l.model[bundle];
