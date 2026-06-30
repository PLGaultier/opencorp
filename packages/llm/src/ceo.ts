import { createHash } from "node:crypto";
import { z } from "zod";
import { chat, type LlmConfig, type ChatOptions } from "./client";
import type { DepartmentReport } from "./departments";
import { renderLessonsBlock, type LessonTip } from "./lessons";
import { routeTier, deriveHeartbeatSignals, budgetFromContext, type RouteDecision } from "./router";
import { classifyChatSignals } from "./classify";

/**
 * Attach an OPE-7 routing decision to a generation's trace: the tier shows up in
 * the generation name and the full {taskKind, complexity, stakes, tier, reason}
 * lands in metadata, so per-task routing is auditable and tunable from traces.
 */
function routedTrace(
  trace: ChatOptions["trace"],
  route: RouteDecision,
  signals: object,
): ChatOptions["trace"] {
  if (!trace) return undefined;
  return {
    ...trace,
    name: `${trace.name ?? "chat"} [${route.tier}]`,
    metadata: { ...signals, tier: route.tier, reason: route.reason },
  };
}

/**
 * CEO planning brain (§5.2 steps 1–3) and chat (§1 feature 2). Pure LLM I/O:
 * context gathering and plan application live with the callers (workflow
 * activities / API), so this stays testable and reusable. Deterministic
 * fallbacks keep the whole pipeline runnable with no LLM endpoint, same as
 * extractCompanySpec and the scripted worker policy.
 */

export const CeoTask = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  priority: z.number().int().min(0).max(10).default(0),
});

export const CeoPlan = z.object({
  keep_doing: z.array(z.string()).default([]),
  stop_doing: z.array(z.string()).default([]),
  new_tasks: z.array(CeoTask).max(10).default([]),
  mission_patch: z.string().min(10).max(2000).nullable().default(null),
  user_brief: z.string().min(1).max(4000),
});
export type CeoPlan = z.infer<typeof CeoPlan>;

export const CeoChatReply = z.object({
  reply: z.string().min(1).max(8000),
  new_tasks: z.array(CeoTask).max(5).default([]),
});
export type CeoChatReply = z.infer<typeof CeoChatReply>;

/** Heartbeat context (§5.2 step 1) — everything the CEO sees, nothing hidden. */
export interface CeoContext {
  company: { name: string; mission: string };
  creditBalance: number;
  dailyTaskCap: number;
  queuedTasks: number;
  recentReports: { title: string; status: string; summary: string | null }[];
  revenueCents24h: number;
  unreadEmails: { from: string; subject: string }[];
  /** Gated actions waiting on the owner (§7.3) — the CEO can't approve them. */
  pendingApprovals?: { server: string; tool: string }[];
  /** Tools the owner recently rejected; the CEO should not keep re-proposing. */
  recentlyRejected?: string[];
  /**
   * Compounding tips sheet (company + conglomerate scope), already ranked by
   * score and hard-capped by the caller — the context window never sees the
   * whole corpus, only this slice.
   */
  lessons?: LessonTip[];
}

/** §5.4 — the prompt hash recorded in ledger events for reproducibility. */
export function promptHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
}

const contextBlock = (ctx: CeoContext): string =>
  [
    `Credit balance: ${ctx.creditBalance}`,
    `Daily task cap: ${ctx.dailyTaskCap} · tasks currently queued: ${ctx.queuedTasks}`,
    `Revenue last 24h: €${(ctx.revenueCents24h / 100).toFixed(2)}`,
    `Recent task reports:\n${
      ctx.recentReports.map((r) => `- [${r.status}] ${r.title}: ${r.summary ?? "no summary"}`).join("\n") || "- none yet"
    }`,
    `Unread inbox:\n${
      ctx.unreadEmails.map((e) => `- ${e.from}: ${e.subject}`).join("\n") || "- empty"
    }`,
    `Actions awaiting the owner's approval (you cannot approve these — flag them in the brief):\n${
      (ctx.pendingApprovals ?? []).map((a) => `- ${a.server}.${a.tool}`).join("\n") || "- none"
    }`,
    ...(ctx.recentlyRejected?.length
      ? [`Recently rejected by the owner (do not re-propose): ${ctx.recentlyRejected.join(", ")}`]
      : []),
    ...(ctx.lessons?.length ? [renderLessonsBlock(ctx.lessons, { max: 16 })] : []),
  ].join("\n");

/** Department proposals rendered for the CEO synthesis prompt (§14 M5). */
const departmentsBlock = (reports: DepartmentReport[]): string =>
  reports
    .map(
      (r) =>
        `${r.department.toUpperCase()}: ${r.headline}\n` +
        (r.observations.map((o) => `  - ${o}`).join("\n") || "  - no observations") +
        (r.proposed_tasks.length
          ? `\n  Proposed tasks:\n${r.proposed_tasks.map((t) => `  - [p${t.priority}] ${t.title}: ${t.description.slice(0, 200)}`).join("\n")}`
          : "\n  Proposed tasks: none"),
    )
    .join("\n\n");

export async function planHeartbeat(
  cfg: LlmConfig | null,
  systemPrompt: string,
  ctx: CeoContext,
  trace?: ChatOptions["trace"],
  departmentReports: DepartmentReport[] = [],
): Promise<CeoPlan> {
  if (!cfg) return fallbackPlan(ctx, departmentReports);
  const user =
    `Today's heartbeat context:\n\n${contextBlock(ctx)}\n\n` +
    (departmentReports.length
      ? `Department proposals (you decide what actually gets queued — adopt, merge, reprioritize, or drop them):\n\n${departmentsBlock(departmentReports)}\n\n`
      : "") +
    `Respond with the planning JSON only.`;
  // OPE-7: route the strategic call by how messy/valuable this heartbeat is.
  const signals = deriveHeartbeatSignals(ctx);
  const route = routeTier(signals);
  let raw = await chat(cfg, {
    tier: route.tier,
    system: systemPrompt,
    user,
    jsonOnly: true,
    trace: routedTrace(trace, route, signals),
  });
  for (let attempt = 0; ; attempt++) {
    const parsed = CeoPlan.safeParse(tryJson(raw));
    if (parsed.success) return parsed.data;
    if (attempt >= 1) throw new Error(`ceo plan failed validation: ${parsed.error.message}`);
    // schema-repair retry (§5.4) — never below the tier that just failed (OPE-7).
    const repair = routeTier({ taskKind: "schema_repair_retry", baseTier: route.tier });
    raw = await chat(cfg, {
      tier: repair.tier,
      system: systemPrompt,
      user: `${user}\n\nYour previous output failed validation:\n${parsed.error.message}\nReturn corrected JSON only.`,
      jsonOnly: true,
      trace: routedTrace(trace, repair, { taskKind: "schema_repair_retry" }),
    });
  }
}

export async function ceoChat(
  cfg: LlmConfig | null,
  systemPrompt: string,
  ctx: CeoContext,
  history: { role: "user" | "ceo"; text: string }[],
  message: string,
  trace?: ChatOptions["trace"],
): Promise<CeoChatReply> {
  if (!cfg) return fallbackChat(ctx, message);
  const user = [
    `Company status:\n${contextBlock(ctx)}`,
    `Conversation so far:\n${history.map((h) => `${h.role}: ${h.text}`).join("\n") || "(none)"}`,
    `Owner says: ${message}`,
    `Respond ONLY with JSON: {"reply": string, "new_tasks": [{"title", "description", "priority"}]}.`,
  ].join("\n\n");
  // OPE-7: routine status chat runs cheap; a directive that queues work earns
  // standard/frontier. OPE-7b: classify intent with the mini model when enabled
  // (else deterministic), and cap the routed tier by the wallet's runway.
  const signals = await classifyChatSignals(cfg, message);
  const route = routeTier({ ...signals, budget: budgetFromContext(ctx) });
  let raw = await chat(cfg, {
    tier: route.tier,
    system: systemPrompt,
    user,
    jsonOnly: true,
    trace: routedTrace(trace, route, signals),
  });
  for (let attempt = 0; ; attempt++) {
    const parsed = CeoChatReply.safeParse(tryJson(raw));
    if (parsed.success) return parsed.data;
    if (attempt >= 1) throw new Error(`ceo chat failed validation: ${parsed.error.message}`);
    // schema-repair retry — never below the tier that just failed (OPE-7).
    const repair = routeTier({ taskKind: "schema_repair_retry", baseTier: route.tier });
    raw = await chat(cfg, {
      tier: repair.tier,
      system: systemPrompt,
      user: `${user}\n\nYour previous output failed validation:\n${parsed.error.message}\nReturn corrected JSON only.`,
      jsonOnly: true,
      trace: routedTrace(trace, repair, { taskKind: "schema_repair_retry" }),
    });
  }
}

/**
 * Deterministic planner for dev/tests (no LLM endpoint): adopts department
 * proposals when present (deduped by title, capped at the daily task cap so
 * the C-suite can't outvote the throttle), otherwise keeps the queue fed with
 * one concrete follow-up when it runs dry — so heartbeats exercise the full
 * multi-agent pipeline offline.
 */
export function fallbackPlan(ctx: CeoContext, departmentReports: DepartmentReport[] = []): CeoPlan {
  const failed = ctx.recentReports.filter((r) => r.status === "failed");

  const proposed: z.infer<typeof CeoTask>[] = [];
  const seen = new Set<string>();
  for (const report of departmentReports) {
    for (const t of report.proposed_tasks) {
      if (seen.has(t.title)) continue;
      seen.add(t.title);
      proposed.push(t);
    }
  }
  proposed.sort((a, b) => b.priority - a.priority);

  const newTasks = proposed.length
    ? proposed.slice(0, Math.min(10, Math.max(1, ctx.dailyTaskCap)))
    : ctx.queuedTasks === 0
      ? [
          {
            title: "Review performance and plan next steps",
            description:
              `Mission: ${ctx.company.mission}\n` +
              `Revenue last 24h: €${(ctx.revenueCents24h / 100).toFixed(2)}. ` +
              `Recent: ${ctx.recentReports.map((r) => `${r.title} (${r.status})`).join(", ") || "nothing yet"}. ` +
              `Write a short plan document and update the site if needed.`,
            priority: 1,
          },
        ]
      : [];
  return {
    keep_doing: ctx.recentReports.filter((r) => r.status === "done").map((r) => r.title),
    stop_doing: failed.map((r) => r.title),
    new_tasks: newTasks,
    mission_patch: null,
    user_brief:
      `Balance ${ctx.creditBalance} credits · €${(ctx.revenueCents24h / 100).toFixed(2)} revenue last 24h · ` +
      `${ctx.queuedTasks + newTasks.length} task(s) queued · ${ctx.unreadEmails.length} unread email(s)` +
      ((ctx.pendingApprovals?.length ?? 0) ? ` · ⚠ ${ctx.pendingApprovals!.length} action(s) await your approval` : "") +
      (failed.length ? ` · ${failed.length} failed task(s) need attention` : "") +
      (departmentReports.length
        ? ` · Departments: ${departmentReports.map((r) => `${r.department.toUpperCase()} — ${r.headline}`).join(" / ")}`
        : "") +
      ` (Deterministic plan — no LLM configured.)`,
  };
}

/** Deterministic chat: status answer; "task: <title>" queues a task. */
export function fallbackChat(ctx: CeoContext, message: string): CeoChatReply {
  const directive = /^task:\s*(.+)/i.exec(message.trim());
  const newTasks = directive
    ? [{ title: directive[1]!.slice(0, 200), description: `Requested by the owner in chat: "${message}"`, priority: 1 }]
    : [];
  return {
    reply:
      (directive
        ? `Queued "${directive[1]}". `
        : "") +
      `Status: ${ctx.creditBalance} credits, €${(ctx.revenueCents24h / 100).toFixed(2)} revenue last 24h, ` +
      `${ctx.queuedTasks + newTasks.length} task(s) queued, ${ctx.unreadEmails.length} unread email(s). ` +
      `(Deterministic CEO — no LLM configured. Prefix a message with "task:" to queue work.)`,
    new_tasks: newTasks,
  };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.replace(/^```(?:json)?\n?|```$/g, "").trim());
  } catch {
    return null;
  }
}
