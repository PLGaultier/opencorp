import type { Sql } from "postgres";
import type { Ledger } from "@opencorp/ledgerd";

/**
 * Self-financing loop (§10, FINANCING_PLAN.md Phase 2). A company earns revenue
 * into `companies.real_balance_cents`; the LLM wallet it spends from lives in
 * `credit_entries` (conglomerate-scoped). Those two never met — so even a selling
 * company froze once its onboarding grant ran out.
 *
 * `reinvestRevenue` closes that gap: when the conglomerate's credit wallet runs
 * LOW and any of its companies hold earned revenue, it moves revenue → credits
 * 1:1 (credits are already real-money cents — no platform margin on the internal
 * reinvest; the platform still earns its cut on cash-out). Fully automatic, runs
 * each heartbeat. The owner keeps the surplus above the refill target as
 * withdrawable balance, so a profitable company never burns 100% of revenue.
 */

// Trigger the refill once credits dip below this (≈2 task holds by default), so a
// busy company refinances *before* it freezes rather than after.
export const REINVEST_MIN_CENTS = Number(process.env.REINVEST_MIN_CENTS ?? 160);
// Refill the wallet up to this; the surplus above it stays withdrawable revenue.
export const REINVEST_TARGET_CENTS = Number(process.env.REINVEST_TARGET_CENTS ?? 1000);
// Hard ceiling on how much revenue one cycle may convert (guardrail §10).
export const REINVEST_CAP_CENTS = Number(process.env.REINVEST_CAP_CENTS ?? 2000);

export interface ReinvestInputs {
  /** Current conglomerate credit-wallet balance (cents). */
  creditBalance: number;
  /** Total earned revenue available to draw on across the conglomerate (cents). */
  availableRevenue: number;
  minCents?: number;
  targetCents?: number;
  capCents?: number;
}

/**
 * Decide how many cents of revenue to convert to credits this cycle. Pure so it's
 * unit-testable without a database. Returns 0 when the wallet isn't low, no
 * revenue is available, or the refill need is already met.
 */
export function planReinvestment(inp: ReinvestInputs): number {
  const min = inp.minCents ?? REINVEST_MIN_CENTS;
  const target = inp.targetCents ?? REINVEST_TARGET_CENTS;
  const cap = inp.capCents ?? REINVEST_CAP_CENTS;
  if (inp.creditBalance >= min) return 0; // wallet healthy — nothing to do
  if (inp.availableRevenue <= 0) return 0; // nothing earned to draw on
  const need = target - inp.creditBalance; // refill up to the target
  const amount = Math.min(need, cap, inp.availableRevenue);
  return amount > 0 ? amount : 0;
}

export interface DrainSource {
  companyId: string;
  cents: number;
}

/**
 * Split `amount` cents of refill across the funding companies, draining
 * largest-first (caller passes them pre-sorted by balance DESC). Pure, so the
 * distribution — partial takes, zero-balance skips, stopping once satisfied — is
 * unit-testable without a database. Never pulls more than a company holds, never
 * more than `amount` in total.
 */
export function drainSources(
  amount: number,
  companies: { id: string; balanceCents: number }[],
): DrainSource[] {
  let remaining = amount;
  const sources: DrainSource[] = [];
  for (const co of companies) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, co.balanceCents);
    if (take <= 0) continue;
    sources.push({ companyId: co.id, cents: take });
    remaining -= take;
  }
  return sources;
}

export interface ReinvestResult {
  /** Total revenue converted to credits this cycle (0 = no-op). */
  movedCents: number;
  /** Per-company breakdown of where the revenue was drawn from. */
  sources: { companyId: string; cents: number }[];
}

/**
 * Convert a conglomerate's earned revenue into LLM credits when the wallet is
 * low. Atomic: balances are locked, drained greedily (largest first), and the
 * single wallet credit + per-company ledger trail are written in one transaction.
 *
 * Idempotent under Temporal retries by construction: a successful run raises the
 * balance to/above the target, so a re-run sees a healthy wallet and no-ops.
 */
export async function reinvestRevenue(
  sql: Sql,
  ledger: Ledger,
  conglomerateId: string,
): Promise<ReinvestResult> {
  return sql.begin(async (tx) => {
    const [bal] = await tx<{ balance: string }[]>`
      SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_entries
      WHERE conglomerate_id = ${conglomerateId}`;
    const creditBalance = Number(bal!.balance);
    if (creditBalance >= REINVEST_MIN_CENTS) return { movedCents: 0, sources: [] };

    // Lock the funding companies (largest balance first) so a concurrent
    // withdrawal can't race the drain.
    const companies = await tx<{ id: string; real_balance_cents: string }[]>`
      SELECT id, real_balance_cents FROM companies
      WHERE conglomerate_id = ${conglomerateId} AND real_balance_cents > 0
      ORDER BY real_balance_cents DESC
      FOR UPDATE`;
    const availableRevenue = companies.reduce((s, c) => s + Number(c.real_balance_cents), 0);

    const amount = planReinvestment({ creditBalance, availableRevenue });
    if (amount <= 0) return { movedCents: 0, sources: [] };

    // Decide the per-company split (pure, tested), then apply it. `companies` is
    // already locked and sorted largest-first by the query above.
    const sources = drainSources(
      amount,
      companies.map((c) => ({ id: c.id, balanceCents: Number(c.real_balance_cents) })),
    );
    for (const s of sources) {
      await tx`UPDATE companies SET real_balance_cents = real_balance_cents - ${s.cents}
               WHERE id = ${s.companyId}`;
    }

    const movedCents = sources.reduce((s, x) => s + x.cents, 0);
    if (movedCents <= 0) return { movedCents: 0, sources: [] };

    // One wallet credit for the conglomerate (company_id null — it's the shared
    // wallet), tagged so the /credits breakdown surfaces the self-financing line.
    await tx`
      INSERT INTO credit_entries (conglomerate_id, delta, reason, meta)
      VALUES (${conglomerateId}, ${movedCents}, 'revenue_reinvest',
              ${tx.json({ sources })})`;

    // Public-ledger trail: revenue leaving each company, then the wallet credit.
    for (const s of sources) {
      await ledger.append({
        companyId: s.companyId,
        actor: "system",
        eventType: "revenue_reinvest",
        payload: { amountCents: s.cents, conglomerateId, direction: "revenue_to_credits" },
      });
    }
    await ledger.append({
      companyId: null,
      actor: "system",
      eventType: "credit_change",
      payload: { conglomerateId, delta: movedCents, reason: "revenue_reinvest", sources },
    });

    return { movedCents, sources };
  });
}
