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

// ── ROAS-driven reallocation (§14 closed-loop growth) ──────────────────────

export interface CampaignPerf {
  campaignId: string;
  budgetCents: number;
  spendCents: number;
  revenueCents: number; // attributed this month
}

export interface ReallocationOpts {
  targetRoas: number; // scale up at/above this (revenue per €1 spend)
  minSpendCents: number; // need this much spend before judging a campaign
  killRoas: number; // below this (after min spend) → pause
  maxBudgetCents: number; // never raise a campaign above this
  minBudgetCents: number; // never cut below this
  stepUp: number; // winner budget multiplier (e.g. 1.5)
  stepDown: number; // weak-campaign budget multiplier (e.g. 0.5)
  /** Stop raising budgets once month-to-date reaches this fraction of the cap. */
  headroomFraction: number;
}

export const DEFAULT_REALLOCATION: ReallocationOpts = {
  targetRoas: Number(process.env.ADS_TARGET_ROAS ?? 2),
  minSpendCents: 500,
  killRoas: 0.5,
  maxBudgetCents: 1_000_000_00,
  minBudgetCents: 100,
  stepUp: 1.5,
  stepDown: 0.5,
  headroomFraction: 0.9,
};

export type ReallocAction = "increase" | "decrease" | "pause" | "hold";

export interface ReallocDecision {
  campaignId: string;
  action: ReallocAction;
  fromBudgetCents: number;
  toBudgetCents: number;
  roas: number;
}

/**
 * Decide per-campaign budget moves from this month's ROAS, bounded by the
 * owner's monthly cap. Pure + deterministic so it's unit-tested and the agent
 * can never push spend past the cap: budgets only rise while month-to-date is
 * under `headroomFraction` of the cap, and clear losers are paused outright.
 */
export function planReallocation(
  campaigns: CampaignPerf[],
  ctx: { capCents: number; monthToDateCents: number },
  opts: ReallocationOpts = DEFAULT_REALLOCATION,
): ReallocDecision[] {
  const hasHeadroom = ctx.capCents > 0 && ctx.monthToDateCents < ctx.capCents * opts.headroomFraction;
  return campaigns.map((c) => {
    const roas = c.spendCents > 0 ? c.revenueCents / c.spendCents : 0;
    const base = { campaignId: c.campaignId, fromBudgetCents: c.budgetCents, roas };
    // Not enough signal yet — leave it running as-is.
    if (c.spendCents < opts.minSpendCents) return { ...base, action: "hold", toBudgetCents: c.budgetCents };
    if (roas >= opts.targetRoas && hasHeadroom) {
      const to = Math.min(Math.round(c.budgetCents * opts.stepUp), opts.maxBudgetCents);
      return { ...base, action: to > c.budgetCents ? "increase" : "hold", toBudgetCents: to };
    }
    if (roas < opts.killRoas) return { ...base, action: "pause", toBudgetCents: c.budgetCents };
    if (roas < 1) {
      const to = Math.max(Math.round(c.budgetCents * opts.stepDown), opts.minBudgetCents);
      return { ...base, action: to < c.budgetCents ? "decrease" : "hold", toBudgetCents: to };
    }
    return { ...base, action: "hold", toBudgetCents: c.budgetCents };
  });
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

// ── Meta (real ad platform) ────────────────────────────────────────────────

/** Marketing API version we pin against (revisit on Meta deprecation). */
export const GRAPH_VERSION = "v21.0";
/**
 * Default audience geo when we create an ad set. v1 targeting is deliberately
 * minimal — a broad country + Advantage+ audience (let Meta optimise). Owners
 * can override the country via ADS_DEFAULT_COUNTRY; richer targeting is a later
 * step (we don't expose it to agents yet).
 */
const DEFAULT_COUNTRY = process.env.ADS_DEFAULT_COUNTRY ?? "US";

/**
 * A Meta rejection. 4xx is terminal (a retry won't help — bad request / policy);
 * a 5xx or a thrown network error is transient and safe for the caller to retry.
 * The spend sync catches *any* throw per-campaign, so one bad campaign never
 * blocks the rest of the sync (see syncCompanyAdSpend).
 */
export class MetaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MetaApiError";
  }
  get terminal(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/**
 * A Meta campaign spans two objects we later act on: the campaign (launch /
 * pause / insights) and its ad set (budget / launch). We pack both into the one
 * existing `provider_ref text` column as `meta:<campaignId>:<adSetId>`, leaving
 * the mock's `local:campaign:<id>` format untouched.
 */
function encodeRef(campaignId: string, adSetId: string): string {
  return `meta:${campaignId}:${adSetId}`;
}
function decodeRef(providerRef: string): { campaignId: string; adSetId: string } {
  const [kind, campaignId, adSetId] = providerRef.split(":");
  if (kind !== "meta" || !campaignId || !adSetId) throw new Error(`not a meta provider_ref: ${providerRef}`);
  return { campaignId, adSetId };
}

/** Objective → a pixel-free ad-set optimisation goal. Optimising for actual
 *  purchases needs the Meta Pixel / Conversions API (a later step); until then
 *  every objective drives clicks to the checkout link, where our ?c= param does
 *  the sale attribution. */
function optimizationGoal(objective: string): string {
  return objective === "OUTCOME_AWARENESS" ? "REACH" : "LINK_CLICKS";
}

class MetaAds implements AdsProvider {
  readonly kind = "meta";
  constructor(
    private token: string,
    private adAccountId: string, // act_<digits>
    private pageId: string,
  ) {}

  async createCampaign(spec: CampaignSpec): Promise<{ providerRef: string }> {
    // 1) Campaign — PAUSED; special_ad_categories must be sent (empty = none).
    const campaign = await this.graph(`${this.adAccountId}/campaigns`, {
      name: spec.name,
      objective: spec.objective,
      status: "PAUSED",
      special_ad_categories: "[]",
    });
    // 2) Ad set — carries the budget, schedule and (minimal) targeting.
    const budgetKey = spec.budgetType === "lifetime" ? "lifetime_budget" : "daily_budget";
    const adset = await this.graph(`${this.adAccountId}/adsets`, {
      name: spec.name,
      campaign_id: campaign.id,
      [budgetKey]: String(spec.budgetCents),
      billing_event: "IMPRESSIONS",
      optimization_goal: optimizationGoal(spec.objective),
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: JSON.stringify({
        geo_locations: { countries: [DEFAULT_COUNTRY] },
        targeting_automation: { advantage_audience: 1 },
      }),
      status: "PAUSED",
    });
    // 3) Ad creative — a link ad pointing at the checkout URL. v1 hotlinks the
    //    creative image via link_data.picture; hardening to an uploaded
    //    /adimages image_hash is a later step.
    const linkData: Record<string, string> = {
      message: spec.creative.body,
      name: spec.creative.headline,
      link: spec.creative.linkUrl,
    };
    if (spec.creative.imageUrl) linkData.picture = spec.creative.imageUrl;
    const creative = await this.graph(`${this.adAccountId}/adcreatives`, {
      name: spec.name,
      object_story_spec: JSON.stringify({ page_id: this.pageId, link_data: linkData }),
    });
    // 4) Ad — binds creative to ad set, PAUSED.
    await this.graph(`${this.adAccountId}/ads`, {
      name: spec.name,
      adset_id: adset.id,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: "PAUSED",
    });
    return { providerRef: encodeRef(campaign.id, adset.id) };
  }

  async setBudget(providerRef: string, budgetCents: number, budgetType: "daily" | "lifetime"): Promise<void> {
    const { adSetId } = decodeRef(providerRef);
    const budgetKey = budgetType === "lifetime" ? "lifetime_budget" : "daily_budget";
    await this.graph(adSetId, { [budgetKey]: String(budgetCents) });
  }

  async launch(providerRef: string): Promise<void> {
    const { campaignId, adSetId } = decodeRef(providerRef);
    // Both must be ACTIVE for delivery to start.
    await this.graph(adSetId, { status: "ACTIVE" });
    await this.graph(campaignId, { status: "ACTIVE" });
  }

  async pause(providerRef: string): Promise<void> {
    const { campaignId } = decodeRef(providerRef);
    // Pausing the campaign halts delivery of every ad set under it.
    await this.graph(campaignId, { status: "PAUSED" });
  }

  async insights(q: InsightsQuery): Promise<DailySpend[]> {
    const { campaignId } = decodeRef(q.providerRef);
    const body = await this.graphGet(`${campaignId}/insights`, {
      fields: "spend,impressions,clicks",
      time_range: JSON.stringify({ since: q.sinceDay, until: q.throughDay }),
      time_increment: "1",
    });
    const rows = (body.data as { date_start: string; spend?: string; impressions?: string; clicks?: string }[]) ?? [];
    return rows.map((r) => ({
      day: r.date_start,
      spendCents: Math.round(parseFloat(r.spend ?? "0") * 100), // Meta reports spend in major units
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
    }));
  }

  /** POST a form to the Graph API (create/update). Returns the JSON node. */
  private async graph(path: string, form: Record<string, string>): Promise<{ id: string; [k: string]: unknown }> {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
    });
    const body = (await res.json()) as { id: string; error?: { message: string } };
    if (!res.ok) throw new MetaApiError(`meta ${path} failed: ${body.error?.message ?? res.status}`, res.status);
    return body;
  }

  /** GET a Graph edge (insights). Returns the JSON node. */
  private async graphGet(path: string, params: Record<string, string>): Promise<{ data?: unknown[]; [k: string]: unknown }> {
    const qs = new URLSearchParams({ ...params, access_token: this.token });
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}?${qs}`);
    const body = (await res.json()) as { data?: unknown[]; error?: { message: string } };
    if (!res.ok) throw new MetaApiError(`meta ${path} failed: ${body.error?.message ?? res.status}`, res.status);
    return body;
  }
}

/**
 * Select the ads provider for a conglomerate: Meta when a token + ad account +
 * Facebook Page are all configured, else the local mock. Token is a secret
 * (vault); the ad account id and page id are plain identifiers from the
 * conglomerate row. All three are required — a Meta ad creative can't be built
 * without a Page.
 */
export async function adsFor(
  conglomerateId: string,
  secrets: SecretStore,
  metaAdAccountId: string | null,
  facebookPageId: string | null,
): Promise<AdsProvider> {
  const token = await secrets.get(conglomerateId, "META_ACCESS_TOKEN");
  return token && metaAdAccountId && facebookPageId
    ? new MetaAds(token, metaAdAccountId, facebookPageId)
    : new LocalAds();
}
