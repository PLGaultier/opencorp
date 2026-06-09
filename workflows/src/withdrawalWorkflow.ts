import { proxyActivities, ApplicationFailure } from "@temporalio/workflow";
import type * as activities from "./withdrawalActivities";
import type { WithdrawalInput, WithdrawalResult } from "./withdrawalActivities";

/**
 * Withdrawal (§10, §13): durable money-out. The single activity is idempotent
 * in the gateway, so we can retry transient failures without double-paying.
 * A terminal `failed` (e.g. insufficient balance) surfaces as a non-retryable
 * error to the caller.
 */
const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 5, initialInterval: "2s", backoffCoefficient: 2 },
});

export async function Withdrawal(input: WithdrawalInput): Promise<WithdrawalResult> {
  const result = await act.submitWithdrawal(input);
  if (result.status === "failed") {
    throw ApplicationFailure.nonRetryable(`withdrawal failed: ${result.reason ?? "unknown"}`);
  }
  return result;
}
