import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import {
  DEPARTMENTS,
  promptHash,
  type CeoContext,
  type CeoPlan,
  type DepartmentKey,
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
}

const PROMPT_PATH = fileURLToPath(new URL("../../prompts/ceo.md", import.meta.url));

function renderPrompt(path: string, company: { name: string; mission: string }): {
  system: string;
  hash: string;
} {
  const template = readFileSync(path, "utf8");
  const system = template
    .replaceAll("{{company_name}}", company.name)
    .replaceAll("{{mission}}", company.mission);
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
    { id: string; name: string; slug: string; mission: string; daily_task_cap: number; conglomerate_id: string; ceo_agent_id: string | null }[]
  >`SELECT c.id, c.name, c.slug, c.mission, c.daily_task_cap, c.conglomerate_id,
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
  };
}

/** §5.2 step 1 — mission, last reports, revenue delta, inbox digest, balance, caps. */
export async function gatherCeoContext(sql: Sql, company: CeoCompany): Promise<CeoContext> {
  const [reports, [balance], [revenue], emails, [queued], pending, rejected] = await Promise.all([
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

/**
 * §5.2 step 3 — create the plan's tasks (deduped by title against open tasks,
 * so Temporal retries don't double-queue) and apply the mission patch.
 * Returns what actually changed, for the ledger event.
 */
export async function applyCeoPlan(
  sql: Sql,
  ledger: Ledger,
  company: CeoCompany,
  plan: Pick<CeoPlan, "new_tasks" | "mission_patch">,
  meta: { promptHash: string; source: "heartbeat" | "chat" },
): Promise<{ createdTasks: string[]; missionUpdated: boolean }> {
  const createdTasks: string[] = [];
  for (const t of plan.new_tasks) {
    const [exists] = await sql`
      SELECT 1 FROM tasks WHERE company_id = ${company.id} AND title = ${t.title}
        AND status IN ('pending', 'queued', 'running')`;
    if (exists) continue;
    await sql`
      INSERT INTO tasks (company_id, created_by_agent_id, title, description, status, priority)
      VALUES (${company.id}, ${company.ceoAgentId}, ${t.title}, ${t.description}, 'queued', ${t.priority})`;
    createdTasks.push(t.title);
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
