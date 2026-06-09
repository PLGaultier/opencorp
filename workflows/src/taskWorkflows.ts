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
    const message = err instanceof Error ? err.message : String(err);
    await act.refundTask(input.taskId);
    await act.setTaskState(input.taskId, "failed", { error: message });
    throw ApplicationFailure.nonRetryable(`task failed (refunded): ${message}`);
  }
}

export async function CompanyHeartbeat(input: { companyId: string }): Promise<{
  dispatched: number;
  stoppedBecause: string;
}> {
  // M2: dispatch-only heartbeat. The CEO planning step (LLM guided JSON,
  // §5.2 steps 1–3) lands with the chat surface in M3.
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
  await act.postDailyBrief(
    input.companyId,
    `Heartbeat: dispatched ${dispatched} task(s); stopped because: ${reason}.`,
  );
  return { dispatched, stoppedBecause: reason };
}
