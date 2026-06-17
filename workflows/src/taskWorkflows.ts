import { proxyActivities, executeChild, ApplicationFailure } from "@temporalio/workflow";
import type * as activities from "./taskActivities";

/**
 * TaskRun (§5.3): charge up front → run agent → done, or full refund on any
 * failure. CompanyHeartbeat (§5.2): plan (later milestone: LLM) + serialized
 * dispatch under caps.
 */

const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3, initialInterval: "1s" },
});

// the agent loop gets the full §5.3 wall-clock budget and no retries:
// a second attempt would double-charge side effects (emails, deploys)
const agent = proxyActivities<Pick<typeof activities, "runWorker">>({
  startToCloseTimeout: "31 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export async function TaskRun(input: { taskId: string }): Promise<{ summary: string }> {
  await act.chargeTask(input.taskId, 1);
  await act.setTaskState(input.taskId, "running");
  try {
    const { summary } = await agent.runWorker(input.taskId);
    await act.setTaskState(input.taskId, "done", { resultSummary: summary });
    return { summary };
  } catch (err) {
    // Temporal wraps the activity error ("Activity task failed"); the ledger
    // and the CEO should see the root cause (e.g. step_budget_exceeded)
    let cause: unknown = err;
    while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    await act.refundTask(input.taskId);
    await act.setTaskState(input.taskId, "failed", { error: message });
    throw ApplicationFailure.nonRetryable(`task failed (refunded): ${message}`);
  }
}

export async function CompanyHeartbeat(input: { companyId: string }): Promise<{
  dispatched: number;
  stoppedBecause: string;
}> {
  // Mirror ad spend + enforce the monthly cap before planning, so the CEO sees
  // fresh spend and over-budget campaigns are already paused (§14). Never blocks
  // the heartbeat — a sync failure is logged via the activity's own ledger path.
  let adNote = "";
  try {
    const ads = await act.syncAdSpend(input.companyId);
    if (ads.autoPaused > 0) adNote = ` Auto-paused ${ads.autoPaused} campaign(s) at the ad budget cap.`;
  } catch {
    /* ad sync is best-effort; dispatch continues */
  }

  // §5.2 steps 1–3: the CEO gathers context, plans, creates tasks, maybe
  // patches the mission. Planning failure must not block dispatch of work
  // that's already queued.
  let brief = "";
  try {
    const plan = await act.runCeoPlanning(input.companyId);
    brief = plan.userBrief;
  } catch (err) {
    brief = `CEO planning failed: ${err instanceof Error ? err.message : String(err)}.`;
  }

  // step 4: serialized dispatch under cap semantics
  let dispatched = 0;
  let reason = "ok";
  for (;;) {
    const next = await act.pickNextTask(input.companyId);
    if (!next.taskId) {
      reason = next.reason;
      break;
    }
    try {
      await executeChild(TaskRun, {
        args: [{ taskId: next.taskId }],
        workflowId: `task-run:${next.taskId}`,
      });
    } catch {
      // failed tasks are refunded inside TaskRun; the heartbeat moves on
    }
    dispatched++;
  }

  // step 5: daily brief to the owner
  await act.postDailyBrief(
    input.companyId,
    `${brief} Dispatched ${dispatched} task(s); stopped because: ${reason}.${adNote}`,
  );
  return { dispatched, stoppedBecause: reason };
}
