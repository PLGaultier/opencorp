import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type ScheduleSpec,
} from "@temporalio/client";
import type { Sql } from "postgres";
import { temporalClient } from "./client";

/**
 * Per-company heartbeat schedules (§1 feature 5, §5.2): one autonomous
 * dispatch cycle per day per company via Temporal Schedules. Caps and pause
 * status are enforced at dispatch time inside the workflow (pickNextTask) —
 * the schedule is the clock, never the policy. Pause/resume are dashboard
 * actions (§5.2): the CEO has no tool that reaches this module.
 */

const TASK_QUEUE = "opencorp-control";

/** Default daily at 07:00 UTC; override per deployment with HEARTBEAT_CRON. */
export const DEFAULT_HEARTBEAT_CRON = "0 7 * * *";

export const heartbeatScheduleId = (companyId: string): string =>
  `heartbeat-schedule:${companyId}`;

export interface HeartbeatScheduleOptions {
  cron?: string;
  /** Test/demo override: fire on an interval instead of a cron expression. */
  intervalMs?: number;
}

function scheduleSpec(opts?: HeartbeatScheduleOptions): ScheduleSpec {
  if (opts?.intervalMs) return { intervals: [{ every: opts.intervalMs }] };
  return { cronExpressions: [opts?.cron ?? process.env.HEARTBEAT_CRON ?? DEFAULT_HEARTBEAT_CRON] };
}

/**
 * Create the company's heartbeat schedule; idempotent — an existing schedule
 * is left untouched (Temporal retries, backfills, and re-provisioning are
 * safe). Overlap SKIP: a heartbeat that's still dispatching (tasks run up to
 * 30 min, serialized) is never doubled; a missed slot older than the catchup
 * window is dropped — the next day's run covers it.
 */
export async function ensureHeartbeatSchedule(
  companyId: string,
  opts?: HeartbeatScheduleOptions,
): Promise<{ scheduleId: string; created: boolean }> {
  const c = await temporalClient();
  const scheduleId = heartbeatScheduleId(companyId);
  try {
    await c.schedule.create({
      scheduleId,
      spec: scheduleSpec(opts),
      action: {
        type: "startWorkflow",
        workflowType: "CompanyHeartbeat",
        taskQueue: TASK_QUEUE,
        args: [{ companyId }],
        workflowId: `heartbeat:${companyId}`, // Temporal appends the scheduled time
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: "1 hour" },
    });
    return { scheduleId, created: true };
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) return { scheduleId, created: false };
    throw err;
  }
}

export async function pauseHeartbeatSchedule(companyId: string, note?: string): Promise<void> {
  const c = await temporalClient();
  await c.schedule.getHandle(heartbeatScheduleId(companyId)).pause(note ?? "paused by owner");
}

export async function resumeHeartbeatSchedule(companyId: string, note?: string): Promise<void> {
  const c = await temporalClient();
  await c.schedule.getHandle(heartbeatScheduleId(companyId)).unpause(note ?? "resumed by owner");
}

export async function deleteHeartbeatSchedule(companyId: string): Promise<void> {
  const c = await temporalClient();
  try {
    await c.schedule.getHandle(heartbeatScheduleId(companyId)).delete();
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) return; // idempotent
    throw err;
  }
}

export interface HeartbeatScheduleInfo {
  scheduleId: string;
  paused: boolean;
  nextRun: string | null;
  recentRuns: number;
}

export async function describeHeartbeatSchedule(
  companyId: string,
): Promise<HeartbeatScheduleInfo | null> {
  const c = await temporalClient();
  try {
    const d = await c.schedule.getHandle(heartbeatScheduleId(companyId)).describe();
    return {
      scheduleId: d.scheduleId,
      paused: d.state.paused,
      nextRun: d.info.nextActionTimes[0]?.toISOString() ?? null,
      recentRuns: d.info.recentActions.length,
    };
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) return null;
    throw err;
  }
}

/**
 * Give every existing company a schedule (one-time migration for companies
 * provisioned before M5 scheduling; safe to re-run). Paused companies get a
 * paused schedule so resume is a pure unpause.
 */
export async function backfillHeartbeatSchedules(
  sql: Sql,
): Promise<{ companyId: string; slug: string; created: boolean }[]> {
  const companies = await sql<{ id: string; slug: string; status: string }[]>`
    SELECT id, slug, status FROM companies ORDER BY created_at`;
  const results = [];
  for (const co of companies) {
    const { created } = await ensureHeartbeatSchedule(co.id);
    if (created && co.status === "paused") {
      await pauseHeartbeatSchedule(co.id, "backfill: company was paused");
    }
    results.push({ companyId: co.id, slug: co.slug, created });
  }
  return results;
}
