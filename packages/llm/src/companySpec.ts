import { z } from "zod";
import { chat, type LlmConfig } from "./client";

/** §6 step 1 — extract a company spec from the user's one prompt (mini tier). */

export const CompanySpec = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "lowercase alphanumeric + hyphens, 3-40 chars"),
  mission: z.string().min(10).max(2000),
  // Deprecated as the founding task source — week-1 work now comes from the
  // deterministic launchPlaybook() (§10, no LLM tokens). Optional so the founding
  // call can omit it; the offline fallback still fills it for back-compat/tests.
  initial_tasks: z
    .array(z.object({ title: z.string().min(1), description: z.string(), priority: z.number().int() }))
    .max(5)
    .optional(),
  landing_copy: z.object({
    headline: z.string().min(1).max(120),
    subheadline: z.string().max(300),
    cta: z.string().max(60),
    sections: z.array(z.object({ title: z.string(), body: z.string() })).max(4),
  }),
});
export type CompanySpec = z.infer<typeof CompanySpec>;

const SYSTEM = `You bootstrap new autonomous companies. Given a founder's one-sentence prompt,
respond ONLY with a JSON object matching:
{
  "name": string,                    // brandable company name
  "slug": string,                    // lowercase a-z0-9 and hyphens, 3-40 chars
  "mission": string,                 // 1-3 sentence mission
  "landing_copy": {
    "headline": string, "subheadline": string, "cta": string,
    "sections": [{"title": string, "body": string}]   // up to 4
  }
}`;

export async function extractCompanySpec(
  cfg: LlmConfig | null,
  prompt: string,
): Promise<CompanySpec> {
  if (!cfg) return fallbackSpec(prompt);
  let raw = await chat(cfg, { tier: "mini", system: SYSTEM, user: prompt, jsonOnly: true });
  for (let attempt = 0; ; attempt++) {
    const parsed = CompanySpec.safeParse(tryJson(raw));
    if (parsed.success) return parsed.data;
    if (attempt >= 1) throw new Error(`company spec failed validation: ${parsed.error.message}`);
    // schema-repair retry (§5.4)
    raw = await chat(cfg, {
      tier: "mini",
      system: SYSTEM,
      user: `${prompt}\n\nYour previous output failed validation:\n${parsed.error.message}\nReturn corrected JSON only.`,
      jsonOnly: true,
    });
  }
}

/**
 * Deterministic week-1 launch playbook (§6/§10). A new company's first tasks are
 * the same shape every time — sharpen the page, document the offer, line up first
 * outreach — so we seed them as a fixed, mission-parameterized checklist instead
 * of paying the founding LLM to reinvent them on every company. Each task obeys
 * the CEO sizing rules: one artifact, an explicit stopping condition, fits a
 * single ~25-tool-call worker run. The CEO's judgment takes over from the next
 * heartbeat, reacting to the real results these produce.
 */
export interface PlaybookTask {
  title: string;
  description: string;
  priority: number;
}

export function launchPlaybook(spec: Pick<CompanySpec, "name" | "mission">): PlaybookTask[] {
  const name = spec.name;
  const focus = spec.mission.slice(0, 140);
  return [
    {
      title: "Sharpen the landing page",
      description: `Tighten the published landing page for ${name}: a clearer headline, a one-line value prop tied to the mission ("${focus}"), and a visible price for the Starter offer. One page only — done when it is redeployed.`,
      priority: 2,
    },
    {
      title: "Write the FAQ page",
      description: `Write a one-page FAQ for ${name} covering what it does, who it is for, pricing, and how to buy. Save it as faq.md. No database, no extra pages — done when the file is saved.`,
      priority: 1,
    },
    {
      title: "Draft 3 outreach emails",
      description: `Write 3 short cold-outreach email drafts introducing ${name} to likely customers. Put all three in a single document, outreach-drafts.md — done when the file holds 3 drafts.`,
      priority: 1,
    },
    {
      title: "List 10 first prospects",
      description: `Research and list 10 specific prospects for ${name} (name or segment + one line on why they would buy). Save as prospects.md — done when the list has 10 entries.`,
      priority: 0,
    },
  ];
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.replace(/^```(?:json)?\n?|```$/g, "").trim());
  } catch {
    return null;
  }
}

/** Deterministic spec for dev/test when no LLM endpoint is configured. */
export function fallbackSpec(prompt: string): CompanySpec {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter(Boolean);
  const slugBase = words.slice(0, 3).join("-").slice(0, 40).replace(/^-+|-+$/g, "") || "company";
  const slug = slugBase.length >= 3 ? slugBase : `${slugBase}-co`.slice(0, 40);
  const name = words.slice(0, 3).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || "New Company";
  return {
    name,
    slug,
    mission: `Build and grow a business around: ${prompt}`.slice(0, 2000),
    initial_tasks: [
      { title: "Define the offer", description: `Turn "${prompt}" into one concrete sellable offer.`, priority: 2 },
      { title: "Improve the landing page", description: "Refine copy and structure of the landing page.", priority: 1 },
      { title: "Identify first 10 prospects", description: "Research who would buy this and why.", priority: 0 },
    ],
    landing_copy: {
      headline: name,
      subheadline: `An autonomous company working on: ${prompt}`.slice(0, 300),
      cta: "Get in touch",
      sections: [{ title: "What we do", body: prompt }],
    },
  };
}
