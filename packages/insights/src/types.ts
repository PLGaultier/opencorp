/**
 * Insights report (F7) — a per-company, read-only roll-up of signals that
 * already exist across the control DB and the transparency ledger, joined into
 * one "what did the company do / where is it stuck" view. The same shape backs
 * the agent-facing `insights.get_report` MCP tool and the `insights` CLI (and a
 * future dashboard), so the queries live here once.
 */

export interface MoneyMetrics {
  /** Gross sales in the window (cents). */
  revenueGrossCents: number;
  /** Net of processing fees (cents). */
  revenueNetCents: number;
  salesCount: number;
  /** LLM credits burned by this company's task charges in the window (cents). */
  creditBurnCents: number;
  /** Conglomerate-level credit wallet balance (cents) — the shared runway. */
  creditBalanceCents: number;
  /** This company's own earned cash balance (cents). */
  realBalanceCents: number;
  /** balance ÷ daily burn, in days; null when nothing is burning. */
  runwayDays: number | null;
}

export interface AcquisitionMetrics {
  spendCents: number;
  impressions: number;
  clicks: number;
  /** Revenue attributed to campaigns (cents) over the window. */
  attributedRevenueCents: number;
  /** attributedRevenue ÷ spend; null when there was no spend. */
  roas: number | null;
  /** Best campaign by ROAS (spend > 0), if any. */
  bestCampaign: { name: string; roas: number } | null;
}

export interface FunnelMetrics {
  /** Unique visitors from analytics; null when analytics isn't wired. */
  visitors: number | null;
  adClicks: number;
  sales: number;
  /** sales ÷ visitors as a fraction; null when visitors is unknown/zero. */
  conversion: number | null;
}

export interface OpsMetrics {
  tasksDone: number;
  tasksFailed: number;
  /** Tools that errored most in the window — where agents get stuck. */
  topFailingTools: { server: string; tool: string; count: number }[];
  rateLimitedCount: number;
  /** Current blockers: actions parked awaiting the owner. */
  pendingApprovals: { server: string; tool: string; count: number }[];
}

export interface ActivityItem {
  type: string;
  at: string;
  summary: string;
}

export interface InsightsReport {
  company: { id: string; slug: string; name: string };
  rangeDays: number;
  generatedAt: string;
  money: MoneyMetrics;
  acquisition: AcquisitionMetrics;
  funnel: FunnelMetrics;
  ops: OpsMetrics;
  activity: ActivityItem[];
}
