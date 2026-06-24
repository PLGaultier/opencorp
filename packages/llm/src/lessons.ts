import { z } from "zod";
import { chat, type LlmConfig, type ChatOptions } from "./client";

/**
 * Compounding agent memory — the "lessons" / tips sheet (company + conglomerate
 * scope). Pure LLM I/O like ceo.ts: the distiller turns what changed since the
 * last heartbeat into a few short, reward-grounded tips; storage, scoring, and
 * the deterministic reward reinforcer live with the callers (workflow
 * activities / gateway). A deterministic fallback keeps the pipeline runnable
 * with no LLM endpoint.
 *
 * Context-window discipline: only a hard-capped, score-ranked slice is ever
 * rendered into a prompt (see {@link renderLessonsBlock}); the full corpus stays
 * in Postgres behind the `memory` MCP tool.
 */

/** Department-aligned buckets so each sub-planner gets only its slice. */
export const LESSON_CATEGORIES = [
  "marketing",
  "outreach",
  "pricing",
  "product",
  "ops",
  "finance",
  "general",
] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

/** Which lesson categories each department cares about (digest filtering). */
export const DEPARTMENT_CATEGORIES: Record<string, LessonCategory[]> = {
  cmo: ["marketing", "outreach", "pricing", "general"],
  cto: ["product", "ops", "general"],
  cfo: ["finance", "pricing", "general"],
};

/** One tip as stored/loaded for the digest. */
export interface LessonTip {
  text: string;
  category: string;
  scope: "company" | "conglomerate";
}

export const LessonCandidate = z.object({
  text: z.string().min(8).max(280),
  category: z.enum(LESSON_CATEGORIES).default("general"),
});
export type LessonCandidate = z.infer<typeof LessonCandidate>;

export const DistilledLessons = z.object({
  lessons: z.array(LessonCandidate).max(3).default([]),
});

/** What the distiller reflects over — the deltas since the last heartbeat. */
export interface ReflectionInput {
  company: { name: string; mission: string };
  recentReports: { title: string; status: string; summary: string | null }[];
  revenueCents24h: number;
  salesCount: number;
  repliesReceived: number;
  /** Existing tip texts (company + conglomerate) so the distiller doesn't dupe. */
  existingLessons: string[];
}

const SYSTEM = `You are the reflection step of an autonomous company. Given what changed since the
last review, distil at most THREE short, durable lessons that would make future decisions better.

A good lesson is:
- imperative and concrete ("Lead cold outreach with the price, not the feature list"), not a status update;
- grounded in the evidence you were given (a sale, a reply, a failure) — never speculation;
- reusable next week, not specific to one task id;
- NOT a near-duplicate of an existing lesson you were shown.

Pick a category for each: marketing, outreach, pricing, product, ops, finance, general.
If nothing durable was learned this cycle, return an empty list — do not invent filler.

Respond ONLY with JSON: {"lessons": [{"text": string, "category": string}]}`;

const reflectionBlock = (input: ReflectionInput): string =>
  [
    `Company: ${input.company.name} — mission: ${input.company.mission}`,
    `Sales in the last 24h: ${input.salesCount} (€${(input.revenueCents24h / 100).toFixed(2)}).`,
    `Inbound replies received: ${input.repliesReceived}.`,
    `Recent task outcomes:\n${
      input.recentReports.map((r) => `- [${r.status}] ${r.title}: ${r.summary ?? "no summary"}`).join("\n") ||
      "- none yet"
    }`,
    `Existing lessons (do NOT repeat these):\n${
      input.existingLessons.map((l) => `- ${l}`).join("\n") || "- none yet"
    }`,
  ].join("\n");

export async function distillLessons(
  cfg: LlmConfig | null,
  input: ReflectionInput,
  trace?: ChatOptions["trace"],
): Promise<LessonCandidate[]> {
  if (!cfg) return fallbackLessons(input);
  const user = `${reflectionBlock(input)}\n\nReturn the lessons JSON only.`;
  let raw = await chat(cfg, { tier: "mini", system: SYSTEM, user, jsonOnly: true, trace });
  for (let attempt = 0; ; attempt++) {
    const parsed = DistilledLessons.safeParse(tryJson(raw));
    if (parsed.success) return dedupe(parsed.data.lessons, input.existingLessons);
    if (attempt >= 1) return []; // a flaky reflection must never break the heartbeat
    raw = await chat(cfg, {
      tier: "mini",
      system: SYSTEM,
      user: `${user}\n\nYour previous output failed validation:\n${parsed.error.message}\nReturn corrected JSON only.`,
      jsonOnly: true,
      trace,
    });
  }
}

/**
 * Deterministic distiller for dev/tests (no LLM endpoint): mine the recent task
 * outcomes — a failure teaches "change approach", and a done task that coincided
 * with a sale teaches "repeat that play". Capped at two so the offline pipeline
 * still exercises lesson creation without flooding the sheet.
 */
export function fallbackLessons(input: ReflectionInput): LessonCandidate[] {
  const out: LessonCandidate[] = [];
  const failed = input.recentReports.find((r) => r.status === "failed");
  if (failed) {
    out.push({
      text: `"${failed.title}" failed (${failed.summary ?? "no detail"}) — change the approach before retrying it.`.slice(0, 280),
      category: guessCategory(failed.title),
    });
  }
  if (input.salesCount > 0) {
    const done = input.recentReports.find((r) => r.status === "done");
    out.push({
      text: done
        ? `Revenue arrived around "${done.title}" — repeat that play and double down on what drove it.`.slice(0, 280)
        : `A sale landed in the last 24h — identify the channel that drove it and lean into it.`,
      category: done ? guessCategory(done.title) : "marketing",
    });
  }
  return dedupe(out, input.existingLessons).slice(0, 2);
}

/**
 * Render the bounded tips block injected into a planning prompt. Hard-capped and
 * optionally category-filtered (so a department sees only its slice), keeping
 * the token cost fixed no matter how large the corpus grows.
 */
export function renderLessonsBlock(
  tips: LessonTip[],
  opts?: { categories?: string[]; max?: number },
): string {
  let list = tips;
  if (opts?.categories) list = list.filter((t) => opts.categories!.includes(t.category));
  list = list.slice(0, opts?.max ?? 12);
  if (!list.length) return "";
  return (
    "Lessons learned so far (ranked by past payoff — apply them, don't re-derive them):\n" +
    list.map((t) => `- [${t.scope === "conglomerate" ? "shared" : t.category}] ${t.text}`).join("\n")
  );
}

function guessCategory(title: string): LessonCategory {
  const t = title.toLowerCase();
  if (/email|outreach|prospect|cold|reply|inbox/.test(t)) return "outreach";
  if (/price|pricing|plan|offer|discount/.test(t)) return "pricing";
  if (/deploy|site|page|landing|product|feature|build|code/.test(t)) return "product";
  if (/ad|campaign|market|seo|content|conversion/.test(t)) return "marketing";
  if (/revenue|cost|budget|runway|credit|finance/.test(t)) return "finance";
  return "general";
}

/** Drop candidates that duplicate (case-insensitive) an existing tip or each other. */
function dedupe(candidates: LessonCandidate[], existing: string[]): LessonCandidate[] {
  const seen = new Set(existing.map((e) => e.trim().toLowerCase()));
  const out: LessonCandidate[] = [];
  for (const c of candidates) {
    const key = c.text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.replace(/^```(?:json)?\n?|```$/g, "").trim());
  } catch {
    return null;
  }
}
