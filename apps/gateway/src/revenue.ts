import type postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";

/**
 * Revenue mirror (§9.4, §10). A payment confirmation — a Stripe webhook in
 * prod, the dev checkout POST in local mode — lands here. We mirror it into the
 * `payments` table, credit the company's real balance, and append a `money_in`
 * ledger event so the public P&L is verifiable. Idempotent on `providerRef`:
 * the acquirer may deliver a webhook more than once.
 */
export interface PaymentConfirmation {
  companyId: string;
  productId: string | null;
  amountCents: number;
  currency: string;
  providerRef: string;
  feeCents?: number;
}

export async function recordPayment(
  sql: postgres.Sql,
  ledger: Ledger,
  p: PaymentConfirmation,
): Promise<{ recorded: boolean; netCents: number }> {
  const feeCents = p.feeCents ?? 0;
  const netCents = p.amountCents - feeCents;

  return sql.begin(async (tx) => {
    const [dup] = await tx`SELECT 1 FROM payments WHERE provider_ref = ${p.providerRef}`;
    if (dup) return { recorded: false, netCents };

    await tx`
      INSERT INTO payments (company_id, product_id, amount_cents, currency, provider_ref, fee_cents, net_cents)
      VALUES (${p.companyId}, ${p.productId}, ${p.amountCents}, ${p.currency},
              ${p.providerRef}, ${feeCents}, ${netCents})`;
    await tx`
      UPDATE companies SET real_balance_cents = real_balance_cents + ${netCents}
      WHERE id = ${p.companyId}`;

    await ledger.append({
      companyId: p.companyId,
      actor: "system",
      eventType: "money_in",
      payload: {
        productId: p.productId,
        amountCents: p.amountCents,
        feeCents,
        netCents,
        currency: p.currency,
        providerRef: p.providerRef,
      },
    });
    return { recorded: true, netCents };
  });
}
