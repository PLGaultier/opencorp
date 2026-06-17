import { createHash } from "node:crypto";
import type { SecretStore } from "../secrets";

/**
 * Ads arm (§14 ads adapter). `AdsProvider` is the ad-platform seam: Meta in
 * prod, a deterministic offline mock in dev. The mock simulates spend so the
 * full create → launch → spend → auto-pause loop runs on a laptop with zero
 * external accounts (the MVP contract). Money here is billed by the ad platform
 * to the owner's payment method — NOT through our Stripe — so the platform is
 * the source of truth only for the *audit* (ledger `ad_spend`) and the *cap*.
 *
 * Budgets and spend are in minor currency units (cents). Campaigns are always
 * created PAUSED; going ACTIVE (launch) and raising budget are money-out
 * actions gated by autonomy + the owner's monthly cap (§7.3).
 */

export interface CampaignSpec {
  campaignId: string; // our id (also used to seed the mock's deterministic spend)
  name: string;
  objective: string;
  budgetCents: number;
  budgetType: "daily" | "lifetime";
  creative: { headline: string; body: string; imageUrl?: string; linkUrl: string };
}

/** A daily spend row pulled from the provider's insights. */
export interface DailySpend {
  day: string; // YYYY-MM-DD
  spendCents: number;
  impressions: number;
  clicks: number;
}

export interface InsightsQuery {
  providerRef: string;
  /** Campaign budget so the mock can bound simulated daily spend. */
  budgetCents: number;
  budgetType: "daily" | "lifetime";
  /** Only return rows on/after this day (YYYY-MM-DD) to keep upserts cheap. */
  sinceDay: string;
  /** Last day to simulate/report (today, in the account tz). */
  throughDay: string;
}

export interface AdsProvider {
  readonly kind: "meta" | "local";
  /** Create the campaign + ad set + creative + ad, all PAUSED. */
  createCampaign(spec: CampaignSpec): Promise<{ providerRef: string }>;
  /** Change the campaign/ad-set budget (money-out — gated). */
  setBudget(providerRef: string, budgetCents: number, budgetType: "daily" | "lifetime"): Promise<void>;
  /** PAUSED → ACTIVE (money-out — gated). */
  launch(providerRef: string): Promise<void>;
  /** ACTIVE → PAUSED (always safe; used by owner + auto-pause). */
  pause(providerRef: string): Promise<void>;
  /** Daily spend/impressions/clicks for the cap sync + reporting. */
  insights(q: InsightsQuery): Promise<DailySpend[]>;
}

// ── Pure budget helpers (unit-tested; no I/O) ──────────────────────────────

/**
 * Conservative pre-spend gate: treat a campaign's budget as its worst-case
 * spend, so the month's already-incurred spend plus this budget must fit under
 * the cap. cap=0 means ads are disabled → never within budget.
 */
export function withinMonthlyCap(
  monthSpendCents: number,
  requestedBudgetCents: number,
  capCents: number,
): boolean {
  if (capCents <= 0) return false;
  return monthSpendCents + requestedBudgetCents <= capCents;
}

/** First day of the current month (YYYY-MM-DD), the rolling-cap window start. */
export function monthStartDay(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Day string (YYYY-MM-DD, UTC) for a Date. */
export function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Local (dev / offline) ──────────────────────────────────────────────────
class LocalAds implements AdsProvider {
  readonly kind = "local";

  async createCampaign(spec: CampaignSpec) {
    return { providerRef: `local:campaign:${spec.campaignId}` };
  }
  async setBudget() {
    /* nothing external */
  }
  async launch() {
    /* the mock only "spends" via insights once status is active in our DB */
  }
  async pause() {
    /* idem */
  }

  /**
   * Deterministic simulated spend: each active day spends 80–100% of the daily
   * budget (daily-budget campaigns) or budget/7 (lifetime), seeded by the
   * campaign ref + day so repeated syncs are idempotent. The caller decides
   * which days are "active" by passing the launched→today window.
   */
  async insights(q: InsightsQuery): Promise<DailySpend[]> {
    const perDay = q.budgetType === "lifetime" ? Math.round(q.budgetCents / 7) : q.budgetCents;
    const out: DailySpend[] = [];
    for (let d = new Date(`${q.sinceDay}T00:00:00Z`); dayString(d) <= q.throughDay; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = dayString(d);
      const r = seededFraction(`${q.providerRef}:${day}`); // 0..1
      const spendCents = Math.round(perDay * (0.8 + 0.2 * r));
      out.push({
        day,
        spendCents,
        impressions: Math.round(spendCents * (3 + 2 * r)), // ~3–5 impressions/cent
        clicks: Math.round(spendCents * (0.02 + 0.03 * r)),
      });
    }
    return out;
  }
}

/** Stable 0..1 from a string (so the mock is reproducible across syncs). */
function seededFraction(seed: string): number {
  const h = createHash("sha256").update(seed).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

// ── Meta (real ad platform) — Phase 2 scaffold ─────────────────────────────
// The wire calls (campaigns/adsets/creatives/ads/insights over the Graph API)
// land in Phase 2. The seam, gating, cap enforcement and ledger audit are all
// here now; this throws clearly until the real client is wired so nothing
// silently no-ops against a connected account.
class MetaAds implements AdsProvider {
  readonly kind = "meta";
  constructor(
    private token: string,
    private adAccountId: string,
  ) {}

  private notYet(op: string): never {
    throw new Error(`meta ads ${op} not implemented yet (Phase 2); account ${this.adAccountId}`);
  }
  async createCampaign(): Promise<{ providerRef: string }> {
    this.notYet("createCampaign");
  }
  async setBudget(): Promise<void> {
    this.notYet("setBudget");
  }
  async launch(): Promise<void> {
    this.notYet("launch");
  }
  async pause(): Promise<void> {
    this.notYet("pause");
  }
  async insights(): Promise<DailySpend[]> {
    this.notYet("insights");
  }
}

/**
 * Select the ads provider for a conglomerate: Meta when a token + ad account are
 * configured, else the local mock. Token is a secret (vault); the ad account id
 * is a plain identifier passed in from the conglomerate row.
 */
export async function adsFor(
  conglomerateId: string,
  secrets: SecretStore,
  metaAdAccountId: string | null,
): Promise<AdsProvider> {
  const token = await secrets.get(conglomerateId, "META_ACCESS_TOKEN");
  return token && metaAdAccountId ? new MetaAds(token, metaAdAccountId) : new LocalAds();
}
