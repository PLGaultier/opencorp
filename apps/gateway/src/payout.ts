import type postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import type { SecretStore } from "./secrets";
import { paymentsFor } from "./providers/payments";

/**
 * Withdrawals / money-out (§10, §7.3). The mirror of `recordPayment`: a company
 * moves its real balance out to a connected account. Money-out is irreversible,
 * so the flow reserves first, pays out, then confirms — and refunds the reserve
 * if the external transfer fails. Idempotent on `withdrawalId` so the durable
 * Withdrawal workflow can retry safely. Withdrawals are user-initiated dashboard
 * actions (the human approval §7.3 asks for), never an agent tool.
 */
export interface WithdrawalRequest {
  withdrawalId: string;
  conglomerateId: string;
  companyId: string;
  amountCents: number;
  currency: string;
}

export interface WithdrawalResult {
  status: "paid" | "failed" | "already_done";
  transferId?: string;
  reason?: string;
}

export async function processWithdrawal(
  sql: postgres.Sql,
  ledger: Ledger,
  secrets: SecretStore,
  req: WithdrawalRequest,
): Promise<WithdrawalResult> {
  // 1. Reserve: guard balance and debit atomically, recording a 'processing' row.
  const reserved = await sql.begin(async (tx) => {
    const [existing] = await tx<{ status: string; provider_transfer_id: string | null }[]>`
      SELECT status, provider_transfer_id FROM withdrawals WHERE id = ${req.withdrawalId}`;
    if (existing) return { kind: "exists" as const, status: existing.status, transferId: existing.provider_transfer_id };

    const [c] = await tx<{ real_balance_cents: string }[]>`
      SELECT real_balance_cents FROM companies WHERE id = ${req.companyId} FOR UPDATE`;
    if (!c) return { kind: "error" as const, reason: "company_not_found" };
    if (Number(c.real_balance_cents) < req.amountCents) return { kind: "error" as const, reason: "insufficient_balance" };

    await tx`UPDATE companies SET real_balance_cents = real_balance_cents - ${req.amountCents}
             WHERE id = ${req.companyId}`;
    await tx`
      INSERT INTO withdrawals (id, conglomerate_id, amount_cents, status)
      VALUES (${req.withdrawalId}, ${req.conglomerateId}, ${req.amountCents}, 'processing')`;
    return { kind: "reserved" as const };
  });

  if (reserved.kind === "exists") {
    return { status: reserved.status === "paid" ? "already_done" : "failed", transferId: reserved.transferId ?? undefined };
  }
  if (reserved.kind === "error") return { status: "failed", reason: reserved.reason };

  // 2. Pay out externally (Stripe Connect transfer, or local no-op).
  const destination = await secrets.get(req.companyId, "STRIPE_CONNECT_ACCOUNT");
  const provider = await paymentsFor(req.companyId, secrets, "");
  try {
    const { transferId } = await provider.payout({
      amountCents: req.amountCents,
      currency: req.currency,
      destination,
    });

    // 3. Confirm: mark paid + money_out ledger event.
    await sql`UPDATE withdrawals SET status = 'paid', provider_transfer_id = ${transferId}
              WHERE id = ${req.withdrawalId}`;
    await ledger.append({
      companyId: req.companyId,
      actor: "user",
      eventType: "money_out",
      payload: {
        withdrawalId: req.withdrawalId,
        amountCents: req.amountCents,
        currency: req.currency,
        transferId,
        provider: provider.kind,
      },
    });
    return { status: "paid", transferId };
  } catch (err) {
    // Refund the reserve so a failed transfer never strands the balance.
    await sql.begin(async (tx) => {
      await tx`UPDATE companies SET real_balance_cents = real_balance_cents + ${req.amountCents}
               WHERE id = ${req.companyId}`;
      await tx`UPDATE withdrawals SET status = 'failed' WHERE id = ${req.withdrawalId}`;
    });
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
