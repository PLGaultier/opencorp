import type postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import type { SecretStore } from "./secrets";
import {
  adsFor,
  monthStartDay,
  dayString,
  planReallocation,
  type DailySpend,
  type CampaignPerf,
} from "./providers/ads";

/**
 * Ad-spend mirror + budget enforcement (§14). The provider bills the owner's
 * payment method directly, so our DB is the source of truth for the *audit*
 * (ledger `ad_spend`) and the *cap*. `syncCompanyAdSpend` pulls each active
 * campaign's daily spend into `ad_spend`, appends the ledger delta, and
 * auto-pauses everything when the company's rolling month-to-date spend reaches
 * the owner's cap — the backstop behind the provider's own budget limits.
 */

/** Month-to-date ad spend for a company (cents), the rolling-cap numerator. */
export async function monthlyAdSpendCents(sql: postgres.Sql, companyId: string): Promise<number> {
  const [r] = await sql<{ c: string }[]>`
    SELECT COALESCE(SUM(spend_cents), 0) AS c FROM ad_spend
    WHERE company_id = ${companyId} AND day >= ${monthStartDay()}`;
  return Number(r?.c ?? 0);
}

interface CampaignRow {
  id: string;
  provider_ref: string | null;
  budget_cents: string;
  budget_type: "daily" | "lifetime";
  launched_at: string | null;
}

export interface AdSyncResult {
  companyId: string;
  campaignsSynced: number;
  monthToDateCents: number;
  capCents: number;
  autoPaused: number;
}

export async function syncCompanyAdSpend(
  sql: postgres.Sql,
  ledger: Ledger,
  secrets: SecretStore,
  companyId: string,
): Promise<AdSyncResult> {
  const [co] = await sql<
    { conglomerate_id: string; ad_monthly_budget_cap_cents: string }[]
  >`SELECT conglomerate_id, ad_monthly_budget_cap_cents FROM companies WHERE id = ${companyId}`;
  if (!co) throw new Error("company_not_found");
  const capCents = Number(co.ad_monthly_budget_cap_cents);

  const [cg] = await sql<{ meta_ad_account_id: string | null; facebook_page_id: string | null }[]>`
    SELECT meta_ad_account_id, facebook_page_id FROM conglomerates WHERE id = ${co.conglomerate_id}`;
  const provider = await adsFor(co.conglomerate_id, secrets, cg?.meta_ad_account_id ?? null, cg?.facebook_page_id ?? null);

  const active = await sql<CampaignRow[]>`
    SELECT id, provider_ref, budget_cents, budget_type,
      to_char(launched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS launched_at
    FROM ad_campaigns WHERE company_id = ${companyId} AND status = 'active'`;

  const before = await monthlyAdSpendCents(sql, companyId);
  const today = dayString(new Date());
  const monthStart = monthStartDay();

  for (const c of active) {
    if (!c.provider_ref) continue;
    // Only the current month matters for the cap; re-simulating from the month
    // start is safe because the upsert is idempotent on (campaign_id, day).
    const launchedDay = c.launched_at ? c.launched_at.slice(0, 10) : monthStart;
    const sinceDay = launchedDay > monthStart ? launchedDay : monthStart;
    let rows: DailySpend[] = [];
    try {
      rows = await provider.insights({
        providerRef: c.provider_ref,
        budgetCents: Number(c.budget_cents),
        budgetType: c.budget_type,
        sinceDay,
        throughDay: today,
      });
    } catch {
      continue; // a provider hiccup never blocks the rest of the sync
    }
    for (const r of rows) {
      await sql`
        INSERT INTO ad_spend (company_id, campaign_id, day, spend_cents, impressions, clicks, updated_at)
        VALUES (${companyId}, ${c.id}, ${r.day}, ${r.spendCents}, ${r.impressions}, ${r.clicks}, now())
        ON CONFLICT (campaign_id, day) DO UPDATE SET
          spend_cents = EXCLUDED.spend_cents, impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks, updated_at = now()`;
    }
  }

  const monthToDate = await monthlyAdSpendCents(sql, companyId);
  if (monthToDate > before) {
    await ledger.append({
      companyId,
      actor: "system",
      eventType: "ad_spend",
      payload: { deltaCents: monthToDate - before, monthToDateCents: monthToDate, capCents, provider: provider.kind },
    });
  }

  // Auto-pause backstop: at/over the cap, pause every active campaign.
  let autoPaused = 0;
  if (capCents > 0 && monthToDate >= capCents && active.length > 0) {
    for (const c of active) {
      if (c.provider_ref) await provider.pause(c.provider_ref).catch(() => {});
      await sql`UPDATE ad_campaigns SET status = 'paused' WHERE id = ${c.id}`;
      autoPaused++;
      await ledger.append({
        companyId,
        actor: "system",
        eventType: "ad_campaign_paused",
        payload: { campaignId: c.id, reason: "monthly_budget_cap", monthToDateCents: monthToDate, capCents },
      });
    }
    await ledger.append({
      companyId,
      actor: "system",
      eventType: "ad_budget_exceeded",
      payload: { monthToDateCents: monthToDate, capCents, pausedCampaigns: autoPaused },
    });
  }

  return { companyId, campaignsSynced: active.length, monthToDateCents: monthToDate, capCents, autoPaused };
}

export interface AdOptimizeResult {
  companyId: string;
  reallocated: number;
  skipped?: string;
}

/**
 * Closed-loop reallocation (§14): attribute this month's revenue to each active
 * campaign, compute ROAS, and shift budget toward winners / away from losers —
 * within the owner's monthly cap. Runs only for companies that have opted into
 * autonomous spend (`bounded`/`full`); `supervised` companies can't launch
 * campaigns in the first place, so there's nothing to optimize. Every move is a
 * deterministic, policy-driven decision recorded as an `ad_reallocation` event.
 */
export async function optimizeCompanyAds(
  sql: postgres.Sql,
  ledger: Ledger,
  secrets: SecretStore,
  companyId: string,
): Promise<AdOptimizeResult> {
  const [co] = await sql<
    { conglomerate_id: string; autonomy_level: string; ad_monthly_budget_cap_cents: string }[]
  >`SELECT conglomerate_id, autonomy_level, ad_monthly_budget_cap_cents FROM companies WHERE id = ${companyId}`;
  if (!co) throw new Error("company_not_found");
  if (co.autonomy_level !== "bounded" && co.autonomy_level !== "full") {
    return { companyId, reallocated: 0, skipped: "autonomy_not_autonomous" };
  }
  const capCents = Number(co.ad_monthly_budget_cap_cents);

  const [cg] = await sql<{ meta_ad_account_id: string | null; facebook_page_id: string | null }[]>`
    SELECT meta_ad_account_id, facebook_page_id FROM conglomerates WHERE id = ${co.conglomerate_id}`;
  const provider = await adsFor(co.conglomerate_id, secrets, cg?.meta_ad_account_id ?? null, cg?.facebook_page_id ?? null);

  // Per active campaign: this month's spend (ad_spend) + attributed revenue
  // (payments tagged with the campaign). One row per campaign.
  const perf = await sql<
    { id: string; budget_cents: string; budget_type: "daily" | "lifetime"; provider_ref: string | null; spend: string; revenue: string }[]
  >`
    SELECT ac.id, ac.budget_cents, ac.budget_type, ac.provider_ref,
      COALESCE((SELECT SUM(spend_cents) FROM ad_spend s
                WHERE s.campaign_id = ac.id AND s.day >= ${monthStartDay()}), 0) AS spend,
      COALESCE((SELECT SUM(amount_cents) FROM payments p
                WHERE p.campaign_id = ac.id AND p.created_at >= date_trunc('month', now())), 0) AS revenue
    FROM ad_campaigns ac
    WHERE ac.company_id = ${companyId} AND ac.status = 'active'`;
  if (perf.length === 0) return { companyId, reallocated: 0 };

  const monthToDate = await monthlyAdSpendCents(sql, companyId);
  const campaigns: CampaignPerf[] = perf.map((r) => ({
    campaignId: r.id,
    budgetCents: Number(r.budget_cents),
    spendCents: Number(r.spend),
    revenueCents: Number(r.revenue),
  }));
  const decisions = planReallocation(campaigns, { capCents, monthToDateCents: monthToDate });
  const byId = new Map(perf.map((r) => [r.id, r]));

  let reallocated = 0;
  for (const d of decisions) {
    if (d.action === "hold") continue;
    const row = byId.get(d.campaignId)!;
    try {
      if (d.action === "pause") {
        if (row.provider_ref) await provider.pause(row.provider_ref);
        await sql`UPDATE ad_campaigns SET status = 'paused' WHERE id = ${d.campaignId}`;
      } else {
        if (row.provider_ref) await provider.setBudget(row.provider_ref, d.toBudgetCents, row.budget_type);
        await sql`UPDATE ad_campaigns SET budget_cents = ${d.toBudgetCents} WHERE id = ${d.campaignId}`;
      }
    } catch {
      continue; // a provider hiccup on one campaign never blocks the rest
    }
    reallocated++;
    await ledger.append({
      companyId,
      actor: "system",
      eventType: "ad_reallocation",
      payload: {
        campaignId: d.campaignId,
        action: d.action,
        fromBudgetCents: d.fromBudgetCents,
        toBudgetCents: d.toBudgetCents,
        roas: Math.round(d.roas * 100) / 100,
        revenueCents: campaigns.find((c) => c.campaignId === d.campaignId)!.revenueCents,
        reason: "roas",
      },
    });
  }
  return { companyId, reallocated };
}
