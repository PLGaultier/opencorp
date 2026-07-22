import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import {
  DEPARTMENTS,
  distillLessons,
  embedMaybe,
  promptHash,
  toVectorLiteral,
  type CeoContext,
  type CeoPlan,
  type DepartmentKey,
  type LlmConfig,
  type ModelBundle,
} from "@opencorp/llm";

/**
 * CEO loop plumbing (§5.2): context gathering and plan application, shared by
 * the CompanyHeartbeat activity and the API chat route. Takes sql/ledger as
 * arguments so each caller uses its own pool.
 */

export interface CeoCompany {
  id: string;
  name: string;
  slug: string;
  mission: string;
  dailyTaskCap: number;
  conglomerateId: string;
  ceoAgentId: string | null;
  /** Provider family for this company's agents (OPE-6). */
  modelBundle: ModelBundle;
}

const PROMPT_PATH = fileURLToPath(new URL("../../prompts/ceo.md", import.meta.url));

/**
 * Per-task tool-call budget (§5.3), the single source of truth shared by the
 * worker (taskActivities builds `budgets.maxSteps` from this) and the CEO prompt
 * (`{{max_steps}}`), so the planner sizes tasks against the budget workers
 * actually get instead of a hardcoded number that can drift.
 */
export const WORKER_MAX_STEPS = Number(process.env.WORKER_MAX_STEPS ?? 80);

function renderPrompt(path: string, company: { name: string; mission: string }): {
  system: string;
  hash: string;
} {
  const template = readFileSync(path, "utf8");
  const system = template
    .replaceAll("{{company_name}}", company.name)
    .replaceAll("{{mission}}", company.mission)
    .replaceAll("{{max_steps}}", String(WORKER_MAX_STEPS));
  return { system, hash: promptHash(system) };
}

/** §5.4 — prompts are versioned files; the hash lands in every ledger event. */
export function loadCeoPrompt(company: { name: string; mission: string }): {
  system: string;
  hash: string;
} {
  return renderPrompt(PROMPT_PATH, company);
}

export function loadDepartmentPrompt(
  dept: DepartmentKey,
  company: { name: string; mission: string },
): { system: string; hash: string } {
  return renderPrompt(
    fileURLToPath(new URL(`../../prompts/dept_${dept}.md`, import.meta.url)),
    company,
  );
}

/**
 * §14 M5 — persistent department agents (CMO/CTO/CFO). Idempotent so existing
 * companies grow a C-suite on their next heartbeat and Temporal retries are
 * safe.
 */
export async function ensureDepartmentAgents(sql: Sql, companyId: string): Promise<void> {
  for (const [dept, def] of Object.entries(DEPARTMENTS)) {
    await sql`
      INSERT INTO agents (company_id, kind, name, role_prompt, model_tier)
      SELECT ${companyId}, 'department', ${def.title}, ${`prompts/dept_${dept}.md`}, 'standard'
      WHERE NOT EXISTS (
        SELECT 1 FROM agents WHERE company_id = ${companyId} AND kind = 'department' AND name = ${def.title}
      )`;
  }
}

export async function ceoCompany(sql: Sql, companyId: string): Promise<CeoCompany> {
  const [c] = await sql<
    { id: string; name: string; slug: string; mission: string; daily_task_cap: number; conglomerate_id: string; ceo_agent_id: string | null; model_bundle: string }[]
  >`SELECT c.id, c.name, c.slug, c.mission, c.daily_task_cap, c.conglomerate_id, c.model_bundle,
           (SELECT id FROM agents WHERE company_id = c.id AND kind = 'ceo' LIMIT 1) AS ceo_agent_id
    FROM companies c WHERE c.id = ${companyId}`;
  if (!c) throw new Error(`company not found: ${companyId}`);
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    mission: c.mission,
    dailyTaskCap: c.daily_task_cap,
    conglomerateId: c.conglomerate_id,
    ceoAgentId: c.ceo_agent_id,
    modelBundle: c.model_bundle === "glm" ? "glm" : "anthropic",
  };
}

/** §5.2 step 1 — mission, last reports, revenue delta, inbox digest, balance, caps. */
export async function gatherCeoContext(sql: Sql, company: CeoCompany): Promise<CeoContext> {
  const [reports, [balance], [revenue], emails, [queued], pending, rejected, lessons] = await Promise.all([
    sql<{ title: string; status: string; summary: string | null }[]>`
      SELECT title, status, COALESCE(result_summary, error) AS summary FROM tasks
      WHERE company_id = ${company.id} AND status IN ('done', 'failed')
      ORDER BY finished_at DESC NULLS LAST LIMIT 5`,
    sql<{ n: string }[]>`
      SELECT COALESCE(SUM(delta), 0) AS n FROM credit_entries
      WHERE conglomerate_id = ${company.conglomerateId}`,
    sql<{ n: string }[]>`
      SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments
      WHERE company_id = ${company.id} AND created_at > now() - interval '24 hours'`,
    sql<{ from_addr: string; subject: string }[]>`
      SELECT from_addr, subject FROM emails
      WHERE company_id = ${company.id} AND direction = 'in' AND read = false
      ORDER BY created_at DESC LIMIT 5`,
    sql<{ n: string }[]>`
      SELECT count(*) AS n FROM tasks WHERE company_id = ${company.id} AND status = 'queued'`,
    sql<{ server: string; tool: string }[]>`
      SELECT server, tool FROM approvals
      WHERE company_id = ${company.id} AND status = 'pending'
      ORDER BY created_at LIMIT 10`,
    // owner rejections only (decided_by set) — expired ones aren't a signal
    sql<{ tool: string }[]>`
      SELECT DISTINCT tool FROM approvals
      WHERE company_id = ${company.id} AND status = 'rejected'
        AND decided_by IS NOT NULL AND decided_at > now() - interval '48 hours'
      LIMIT 10`,
    // Compounding tips sheet: this company's own lessons + the conglomerate's
    // shared ones, best score first. Capped here; the renderer caps again per
    // consumer, so the prompt cost stays fixed regardless of corpus size.
    sql<{ text: string; category: string; scope: "company" | "conglomerate" }[]>`
      SELECT text, category, scope FROM lessons
      WHERE status = 'active' AND conglomerate_id = ${company.conglomerateId}
        AND (scope = 'conglomerate' OR company_id = ${company.id})
      ORDER BY score DESC, last_reinforced_at DESC NULLS LAST
      LIMIT 24`,
  ]);
  return {
    company: { name: company.name, mission: company.mission },
    creditBalance: Number(balance!.n),
    dailyTaskCap: company.dailyTaskCap,
    queuedTasks: Number(queued!.n),
    recentReports: reports,
    revenueCents24h: Number(revenue!.n),
    unreadEmails: emails.map((e) => ({ from: e.from_addr, subject: e.subject })),
    pendingApprovals: pending.map((a) => ({ server: a.server, tool: a.tool })),
    recentlyRejected: rejected.map((r) => r.tool),
    lessons: lessons.map((l) => ({ text: l.text, category: l.category, scope: l.scope })),
  };
}

/**
 * Auto-expire approvals that have sat pending too long (§7.3). Keeps the queue
 * from accumulating forever and stops the autonomous loop from waiting on an
 * owner who never responds — an expired request is recorded as a system
 * rejection on the ledger. Run once per heartbeat.
 */
export async function expireStaleApprovals(
  sql: Sql,
  ledger: Ledger,
  ttlHours = Number(process.env.APPROVAL_TTL_HOURS ?? 168),
): Promise<number> {
  const stale = await sql<{ id: string; company_id: string; server: string; tool: string }[]>`
    UPDATE approvals SET status = 'rejected', error = 'expired', decided_at = now()
    WHERE status = 'pending' AND created_at < now() - make_interval(hours => ${ttlHours})
    RETURNING id, company_id, server, tool`;
  for (const a of stale) {
    await ledger.append({
      companyId: a.company_id,
      actor: "system",
      eventType: "approval_resolved",
      payload: { approvalId: a.id, server: a.server, tool: a.tool, decision: "rejected", reason: "expired" },
    });
  }
  return stale.length;
}

/** Content words of a title, lowercased — filler dropped so it doesn't pad overlap. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "to", "of", "in", "on", "at", "with",
  "create", "add", "make", "set", "up", "new",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/**
 * True when two task titles describe the same work. Exact-title matching let the
 * CEO re-queue the same job under a reworded title every heartbeat — prod ended
 * up with 5 near-duplicate Stripe-product tasks ("Create Stripe Basic product
 * €29" vs "Create Stripe Basic Plan Product (€29/mo)"). Dice coefficient over
 * content words at 0.6 catches rewordings while keeping genuinely different work
 * apart ("Write the FAQ page" vs "Link FAQ to Navigation" scores well below).
 */
export function isNearDuplicateTitle(a: string, b: string, threshold = 0.6): boolean {
  if (!a.trim() || !b.trim()) return false;
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const [ta, tb] = [titleTokens(a), titleTokens(b)];
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return (2 * shared) / (ta.size + tb.size) >= threshold;
}

/**
 * §5.2 step 3 — create the plan's tasks (deduped against open tasks, so Temporal
 * retries don't double-queue and a reworded re-plan doesn't pile up duplicates)
 * and apply the mission patch. Returns what actually changed, for the ledger.
 */
export async function applyCeoPlan(
  sql: Sql,
  ledger: Ledger,
  company: CeoCompany,
  plan: Pick<CeoPlan, "new_tasks" | "mission_patch">,
  meta: { promptHash: string; source: "heartbeat" | "chat" },
): Promise<{ createdTasks: string[]; missionUpdated: boolean }> {
  const createdTasks: string[] = [];
  // Dedup against everything still open, including what this plan just queued,
  // so one plan can't propose the same work twice.
  const open = (
    await sql<{ title: string }[]>`
      SELECT title FROM tasks WHERE company_id = ${company.id}
        AND status IN ('pending', 'queued', 'running')`
  ).map((r) => r.title);
  for (const t of plan.new_tasks) {
    if (open.some((title) => isNearDuplicateTitle(title, t.title))) continue;
    await sql`
      INSERT INTO tasks (company_id, created_by_agent_id, title, description, status, priority)
      VALUES (${company.id}, ${company.ceoAgentId}, ${t.title}, ${t.description}, 'queued', ${t.priority})`;
    createdTasks.push(t.title);
    open.push(t.title);
  }

  let missionUpdated = false;
  if (plan.mission_patch && plan.mission_patch !== company.mission) {
    await sql`UPDATE companies SET mission = ${plan.mission_patch} WHERE id = ${company.id}`;
    await ledger.append({
      companyId: company.id,
      actor: "ceo",
      eventType: "mission_updated",
      payload: { from: company.mission, to: plan.mission_patch, ...meta },
    });
    missionUpdated = true;
  }

  return { createdTasks, missionUpdated };
}

// ── Lessons: compounding memory (distil + reward reinforce) ─────────────────
// Tuning for the deterministic reinforcer. Every heartbeat decays the company's
// active lessons; rewards (sales / replies) bump the categories that drive them,
// so a tip only stays in the digest while it keeps coinciding with payoff.
const LESSON_DECAY = 0.95; // multiplicative, per heartbeat
const LESSON_FLOOR = 0.3; // below this an un-reinforced lesson retires
const SALE_REWARD = 0.6; // score added per heartbeat with sales (×min(sales,3))
const REPLY_REWARD = 0.3; // score added per heartbeat with inbound replies
const REVENUE_CATEGORIES = ["marketing", "outreach", "pricing", "product"];
const REPLY_CATEGORIES = ["outreach", "marketing"];

/** The reward deltas the distiller grounds on and the reinforcer scores against. */
export interface RewardSignal {
  salesCount: number;
  repliesReceived: number;
}

/**
 * Sales + "positive outbound" since yesterday. A reply counts only when it comes
 * from an address this company actually emailed — i.e. a cold-outreach target
 * wrote back — so noise (newsletters, bots) doesn't reinforce anything.
 */
export async function gatherRewardSignal(sql: Sql, company: CeoCompany): Promise<RewardSignal> {
  const [[sales], [replies]] = await Promise.all([
    sql<{ n: string }[]>`
      SELECT count(*) AS n FROM payments
      WHERE company_id = ${company.id} AND created_at > now() - interval '24 hours'`,
    sql<{ n: string }[]>`
      SELECT count(*) AS n FROM emails e
      WHERE e.company_id = ${company.id} AND e.direction = 'in'
        AND e.created_at > now() - interval '24 hours'
        AND EXISTS (
          SELECT 1 FROM emails o
          WHERE o.company_id = ${company.id} AND o.direction = 'out'
            AND e.from_addr = ANY(o.to_addrs))`,
  ]);
  return { salesCount: Number(sales!.n), repliesReceived: Number(replies!.n) };
}

/**
 * Deterministic reward reinforcement (no LLM): decay every active company lesson,
 * bump the categories a reward implicates, then retire the faded. Company-scoped
 * only — shared (conglomerate) lessons are maintained by the promoter, so a
 * company heartbeat can't N×-decay them. Idempotency under Temporal retries is
 * acceptable here: a re-run applies one extra mild decay, not a correctness bug.
 */
export async function reinforceLessons(
  sql: Sql,
  company: CeoCompany,
  reward: RewardSignal,
): Promise<{ reinforced: number; retired: number }> {
  await sql`
    UPDATE lessons SET score = score * ${LESSON_DECAY}, updated_at = now()
    WHERE status = 'active' AND company_id = ${company.id}`;

  let reinforced = 0;
  if (reward.salesCount > 0) {
    const bump = Math.min(3, reward.salesCount) * SALE_REWARD;
    const r = await sql<{ id: string }[]>`
      UPDATE lessons SET score = score + ${bump}, wins = wins + 1,
        last_reinforced_at = now(), updated_at = now()
      WHERE status = 'active' AND company_id = ${company.id}
        AND category = ANY(${REVENUE_CATEGORIES}) RETURNING id`;
    reinforced += r.length;
  }
  if (reward.repliesReceived > 0) {
    const r = await sql<{ id: string }[]>`
      UPDATE lessons SET score = score + ${REPLY_REWARD}, wins = wins + 1,
        last_reinforced_at = now(), updated_at = now()
      WHERE status = 'active' AND company_id = ${company.id}
        AND category = ANY(${REPLY_CATEGORIES}) RETURNING id`;
    reinforced += r.length;
  }

  const retired = await sql<{ id: string }[]>`
    UPDATE lessons SET status = 'retired', updated_at = now()
    WHERE status = 'active' AND company_id = ${company.id} AND score < ${LESSON_FLOOR}
    RETURNING id`;
  return { reinforced, retired: retired.length };
}

/**
 * Distil 0–3 new company lessons from what changed this heartbeat (reward-grounded
 * reflection, mini tier; deterministic offline). Deduped against the live table so
 * Temporal retries don't double-insert. Returns the stored tip texts for the ledger.
 */
export async function distillAndStoreLessons(
  sql: Sql,
  ledger: Ledger,
  company: CeoCompany,
  ctx: CeoContext,
  reward: RewardSignal,
  cfg: LlmConfig | null,
  trace?: Parameters<typeof distillLessons>[2],
): Promise<string[]> {
  const candidates = await distillLessons(
    cfg,
    {
      company: { name: company.name, mission: company.mission },
      recentReports: ctx.recentReports,
      revenueCents24h: ctx.revenueCents24h,
      salesCount: reward.salesCount,
      repliesReceived: reward.repliesReceived,
      existingLessons: (ctx.lessons ?? []).map((l) => l.text),
    },
    trace,
  );

  const stored: string[] = [];
  for (const c of candidates) {
    const [dup] = await sql`
      SELECT 1 FROM lessons WHERE company_id = ${company.id} AND lower(text) = lower(${c.text}) LIMIT 1`;
    if (dup) continue;
    const vec = await embedMaybe(c.text); // null when embeddings off → keyword/score recall
    await sql`
      INSERT INTO lessons (scope, conglomerate_id, company_id, category, text, source, evidence, embedding)
      VALUES ('company', ${company.conglomerateId}, ${company.id}, ${c.category}, ${c.text}, 'distiller',
        ${sql.json({ reports: ctx.recentReports.map((r) => r.title), salesCount: reward.salesCount })},
        ${vec ? sql`${toVectorLiteral(vec)}::vector` : null})`;
    stored.push(c.text);
  }
  if (stored.length) {
    await ledger.append({
      companyId: company.id,
      actor: "ceo",
      eventType: "lessons_distilled",
      payload: { lessons: stored },
    });
  }
  return stored;
}

// ── Promoter: lift proven company lessons to the shared (conglomerate) sheet ──
// A lesson that has compounded to high confidence in one company is worth
// teaching its siblings. Promotion is idempotent — it only acts on lessons that
// cross the threshold, and each action removes them from the candidate set — so
// it can run on every heartbeat with no churn and no per-conglomerate schedule.
export const PROMOTE_SCORE = 3.0; // a tip reinforced by several reward cycles
export const PROMOTE_WINS = 2; // proven across at least two distinct cycles
const MERGE_DISTANCE = 0.15; // cosine distance below which two tips are "the same"
const MERGE_REWARD = 0.6; // a second company proving it reinforces the shared tip

/** Pure promotion gate — factored out so it's unit-testable without a DB. */
export function qualifiesForPromotion(l: { score: number; wins: number }): boolean {
  return l.score >= PROMOTE_SCORE && l.wins >= PROMOTE_WINS;
}

/**
 * Promote this company's high-confidence lessons to conglomerate scope. When a
 * near-duplicate shared lesson already exists (semantic match if embeddings are
 * on, else identical text — e.g. a sibling already promoted the same insight),
 * merge: retire the company copy and reinforce the shared one, so a lesson
 * independently learned across companies compounds rather than duplicating.
 * Otherwise promote in place (the embedding and score ride along).
 */
export async function promoteCompanyLessons(
  sql: Sql,
  ledger: Ledger,
  company: CeoCompany,
): Promise<{ promoted: number; merged: number }> {
  const candidates = await sql<{ id: string; text: string }[]>`
    SELECT id, text FROM lessons
    WHERE status = 'active' AND scope = 'company' AND company_id = ${company.id}
      AND score >= ${PROMOTE_SCORE} AND wins >= ${PROMOTE_WINS}`;

  let promoted = 0;
  let merged = 0;
  for (const cand of candidates) {
    // Semantic near-duplicate among existing shared lessons (no-op when either
    // side lacks an embedding); fall back to an exact-text match.
    const [semantic] = await sql<{ id: string }[]>`
      SELECT l2.id FROM lessons l1
      JOIN lessons l2 ON l2.scope = 'conglomerate' AND l2.status = 'active'
        AND l2.conglomerate_id = ${company.conglomerateId}
      WHERE l1.id = ${cand.id}
        AND l1.embedding IS NOT NULL AND l2.embedding IS NOT NULL
        AND (l1.embedding <=> l2.embedding) < ${MERGE_DISTANCE}
      ORDER BY (l1.embedding <=> l2.embedding) LIMIT 1`;
    const [dup] = semantic
      ? [semantic]
      : await sql<{ id: string }[]>`
          SELECT id FROM lessons
          WHERE scope = 'conglomerate' AND status = 'active'
            AND conglomerate_id = ${company.conglomerateId}
            AND lower(text) = lower(${cand.text}) LIMIT 1`;

    if (dup) {
      await sql`UPDATE lessons SET status = 'retired', updated_at = now() WHERE id = ${cand.id}`;
      await sql`
        UPDATE lessons SET score = score + ${MERGE_REWARD}, wins = wins + 1,
          last_reinforced_at = now(), updated_at = now() WHERE id = ${dup.id}`;
      merged++;
    } else {
      // Start the shared-decay clock at promotion, not creation — a freshly
      // promoted lesson is proven, so it shouldn't inherit days of back-decay.
      await sql`
        UPDATE lessons SET scope = 'conglomerate', company_id = NULL, source = 'promoted',
          last_decayed_at = now(), updated_at = now()
        WHERE id = ${cand.id}`;
      promoted++;
    }
    await ledger.append({
      companyId: company.id,
      actor: "ceo",
      eventType: "lesson_promoted",
      payload: { lessonId: cand.id, text: cand.text, merged: Boolean(dup) },
    });
  }
  return { promoted, merged };
}

// ── Shared-sheet maintenance: time-proportional decay + retirement ──────────
// Company lessons decay a flat step per their own heartbeat (reinforceLessons).
// Shared (conglomerate) lessons can't: N companies' heartbeats all hit them, so
// a flat per-call step would decay them N× too fast. Instead decay is a function
// of elapsed wall-clock time off last_decayed_at — score × DECAY^days — which
// composes exactly regardless of how often (or by how many companies) it runs:
// decaying by DECAY^Δt₁ then DECAY^Δt₂ equals DECAY^(Δt₁+Δt₂). So it's safe to
// call on every heartbeat, and a shared tip that stops being reinforced fades to
// the floor and retires — keeping the shared sheet self-pruning, not unbounded.
const LESSON_DAILY_DECAY = 0.95; // multiplicative per day for shared lessons

export async function decayConglomerateLessons(
  sql: Sql,
  ledger: Ledger,
  conglomerateId: string,
): Promise<{ retired: number }> {
  await sql`
    UPDATE lessons SET
      score = score * power(
        ${LESSON_DAILY_DECAY},
        extract(epoch FROM (now() - coalesce(last_decayed_at, created_at))) / 86400.0
      ),
      last_decayed_at = now(),
      updated_at = now()
    WHERE status = 'active' AND scope = 'conglomerate' AND conglomerate_id = ${conglomerateId}`;

  const retired = await sql<{ id: string }[]>`
    UPDATE lessons SET status = 'retired', updated_at = now()
    WHERE status = 'active' AND scope = 'conglomerate' AND conglomerate_id = ${conglomerateId}
      AND score < ${LESSON_FLOOR}
    RETURNING id`;

  if (retired.length) {
    await ledger.append({
      companyId: null,
      actor: "system",
      eventType: "lessons_maintained",
      payload: { conglomerateId, retiredShared: retired.length },
    });
  }
  return { retired: retired.length };
}
