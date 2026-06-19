import { createHmac } from "node:crypto";

/**
 * Withdrawal activity (§10): a durable, retryable call to the gateway's signed
 * money-out endpoint. Kept as a thin signed HTTP call so the workflow package
 * stays decoupled from gateway internals; idempotency lives in the gateway
 * (keyed on withdrawalId), so Temporal retries are safe.
 */
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3004";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";

export interface WithdrawalInput {
  withdrawalId: string;
  companyId: string;
  amountCents: number;
  currency: string;
}

export interface WithdrawalResult {
  status: "paid" | "failed" | "already_done";
  transferId?: string;
  reason?: string;
  /** Platform withdrawal fee withheld, and the net paid to the owner (§10 pillar 2). */
  feeCents?: number;
  netCents?: number;
}

export async function submitWithdrawal(input: WithdrawalInput): Promise<WithdrawalResult> {
  const raw = JSON.stringify(input);
  const sig = createHmac("sha256", GATEWAY_SECRET).update(raw).digest("hex");
  const res = await fetch(`${GATEWAY_URL}/admin/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sig },
    body: raw,
  });
  // 5xx → throw so Temporal retries; 4xx (insufficient balance, etc.) is terminal.
  if (res.status >= 500) throw new Error(`gateway ${res.status}`);
  return (await res.json()) as WithdrawalResult;
}
