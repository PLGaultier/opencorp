import type { Sql } from "postgres";
import type {
  AcquisitionMetrics,
  ActivityItem,
  InsightsReport,
  MoneyMetrics,
  OpsMetrics,
} from "./types";

/**
 * Build the per-company insights report from the control DB + ledger. Every
 * query is read-only and scoped to one company (its conglomerate only for the
 * shared credit wallet). `visitors` is injected by the caller — only the gateway
 * (which holds the per-company analytics secret) can fetch it, so the package
 * stays dependency-light and the CLI can pass null.
 */
export interface BuildReportInput {
  company: {
    id: string;
    slug: string;
    name: string;
    conglomerateId: string;
    realBalanceCents: number;
  };
  rangeDays: number;
  /** Unique visitors over the window, or null when analytics isn't available. */
  visitors?: number | null;
}

export async function buildReport(sql: Sql, input: BuildReportInput): Promise<InsightsReport> {
  const { company, rangeDays } = input;
  const cid = company.id;
  const days = rangeDays;

  const [money, acquisition, ops, activity] = await Promise.all([
    moneyMetrics(sql, company, days),
    acquisitionMetrics(sql, cid, days),
    opsMetrics(sql, cid, days),
    activityFeed(sql, cid),
  ]);

  const visitors = input.visitors ?? null;
  const conversion = visitors && visitors > 0 ? money.salesCount / visitors : null;

  return {
    company: { id: company.id, slug: company.slug, name: company.name },
    rangeDays: days,
    generatedAt: new Date().toISOString(),
    money,
    acquisition,
    funnel: { visitors, adClicks: acquisition.clicks, sales: money.salesCount, conversion },
    ops,
    activity,
  };
}

async function moneyMetrics(
  sql: Sql,
  company: BuildReportInput["company"],
  days: number,
): Promise<MoneyMetrics> {
  const [[rev], [burn], [bal]] = await Promise.all([
    sql<{ gross: string; net: string; sales: string }[]>`
      SELECT COALESCE(SUM(amount_cents), 0) AS gross, COALESCE(SUM(net_cents), 0) AS net,
             count(*) AS sales
      FROM payments
      WHERE company_id = ${company.id} AND created_at > now() - make_interval(days => ${days})`,
    sql<{ burn: string }[]>`
      SELECT COALESCE(-SUM(delta), 0) AS burn FROM credit_entries
      WHERE company_id = ${company.id} AND delta < 0
        AND created_at > now() - make_interval(days => ${days})`,
    sql<{ bal: string }[]>`
      SELECT COALESCE(SUM(delta), 0) AS bal FROM credit_entries
      WHERE conglomerate_id = ${company.conglomerateId}`,
  ]);

  const creditBurnCents = Number(burn!.burn);
  const creditBalanceCents = Number(bal!.bal);
  const dailyBurn = creditBurnCents / days;
  return {
    revenueGrossCents: Number(rev!.gross),
    revenueNetCents: Number(rev!.net),
    salesCount: Number(rev!.sales),
    creditBurnCents,
    creditBalanceCents,
    realBalanceCents: company.realBalanceCents,
    runwayDays: dailyBurn > 0 ? Math.round(creditBalanceCents / dailyBurn) : null,
  };
}

async function acquisitionMetrics(sql: Sql, companyId: string, days: number): Promise<AcquisitionMetrics> {
  const [[totals], [attr], perCampaign] = await Promise.all([
    sql<{ spend: string; imp: string; clicks: string }[]>`
      SELECT COALESCE(SUM(s.spend_cents), 0) AS spend, COALESCE(SUM(s.impressions), 0) AS imp,
             COALESCE(SUM(s.clicks), 0) AS clicks
      FROM ad_spend s JOIN ad_campaigns c ON c.id = s.campaign_id
      WHERE c.company_id = ${companyId} AND s.day::date >= current_date - ${days}::int`,
    sql<{ rev: string }[]>`
      SELECT COALESCE(SUM(amount_cents), 0) AS rev FROM payments
      WHERE company_id = ${companyId} AND campaign_id IS NOT NULL
        AND created_at > now() - make_interval(days => ${days})`,
    sql<{ name: string; spend: string; rev: string }[]>`
      SELECT c.name,
             COALESCE(SUM(s.spend_cents), 0) AS spend,
             COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                       WHERE p.campaign_id = c.id
                         AND p.created_at > now() - make_interval(days => ${days})), 0) AS rev
      FROM ad_campaigns c
      LEFT JOIN ad_spend s ON s.campaign_id = c.id AND s.day::date >= current_date - ${days}::int
      WHERE c.company_id = ${companyId}
      GROUP BY c.id, c.name`,
  ]);

  const spendCents = Number(totals!.spend);
  const attributedRevenueCents = Number(attr!.rev);
  const best = perCampaign
    .map((r) => ({ name: r.name, spend: Number(r.spend), rev: Number(r.rev) }))
    .filter((r) => r.spend > 0)
    .map((r) => ({ name: r.name, roas: Math.round((r.rev / r.spend) * 100) / 100 }))
    .sort((a, b) => b.roas - a.roas)[0];

  return {
    spendCents,
    impressions: Number(totals!.imp),
    clicks: Number(totals!.clicks),
    attributedRevenueCents,
    roas: spendCents > 0 ? Math.round((attributedRevenueCents / spendCents) * 100) / 100 : null,
    bestCampaign: best ?? null,
  };
}

async function opsMetrics(sql: Sql, companyId: string, days: number): Promise<OpsMetrics> {
  const [tasks, failing, [rl], pending] = await Promise.all([
    sql<{ status: string; n: string }[]>`
      SELECT status, count(*) AS n FROM tasks
      WHERE company_id = ${companyId} AND status IN ('done', 'failed')
        AND finished_at > now() - make_interval(days => ${days})
      GROUP BY status`,
    // Where agents get stuck: tools that returned outcome=error most often.
    sql<{ server: string; tool: string; n: string }[]>`
      SELECT payload->>'server' AS server, payload->>'tool' AS tool, count(*) AS n
      FROM ledger_events
      WHERE company_id = ${companyId} AND event_type = 'tool_call'
        AND payload->>'outcome' = 'error'
        AND created_at > now() - make_interval(days => ${days})
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 5`,
    sql<{ n: string }[]>`
      SELECT count(*) AS n FROM ledger_events
      WHERE company_id = ${companyId} AND event_type = 'tool_call'
        AND payload->>'outcome' = 'rate_limited'
        AND created_at > now() - make_interval(days => ${days})`,
    // Current blockers (not range-bound): actions parked awaiting the owner.
    sql<{ server: string; tool: string; n: string }[]>`
      SELECT server, tool, count(*) AS n FROM approvals
      WHERE company_id = ${companyId} AND status = 'pending'
      GROUP BY 1, 2 ORDER BY n DESC`,
  ]);

  const byStatus = Object.fromEntries(tasks.map((t) => [t.status, Number(t.n)]));
  return {
    tasksDone: byStatus.done ?? 0,
    tasksFailed: byStatus.failed ?? 0,
    topFailingTools: failing.map((f) => ({ server: f.server, tool: f.tool, count: Number(f.n) })),
    rateLimitedCount: Number(rl!.n),
    pendingApprovals: pending.map((p) => ({ server: p.server, tool: p.tool, count: Number(p.n) })),
  };
}

async function activityFeed(sql: Sql, companyId: string): Promise<ActivityItem[]> {
  const rows = await sql<{ event_type: string; payload: Record<string, unknown>; created_at: Date }[]>`
    SELECT event_type, payload, created_at FROM ledger_events
    WHERE company_id = ${companyId}
      AND event_type IN ('deploy', 'email_sent', 'ad_campaign_launched', 'money_in', 'product_created')
    ORDER BY seq DESC LIMIT 8`;
  return rows.map((r) => ({
    type: r.event_type,
    at: r.created_at.toISOString(),
    summary: summarizeEvent(r.event_type, r.payload),
  }));
}

/** One-line gloss of a ledger event for the activity feed. */
export function summarizeEvent(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case "deploy":
      return `deployed ${payload.kind ?? "site"}${payload.url ? ` → ${payload.url}` : ""}`;
    case "email_sent": {
      const to = Array.isArray(payload.to) ? payload.to.join(", ") : String(payload.to ?? "");
      return `emailed ${to}: ${String(payload.subject ?? "")}`.trim();
    }
    case "ad_campaign_launched":
      return `launched campaign ${payload.campaignId ?? ""}`;
    case "money_in":
      return `sale +${centsToEur(Number(payload.amountCents ?? 0))}`;
    case "product_created":
      return `created product "${payload.name ?? ""}" @ ${centsToEur(Number(payload.priceCents ?? 0))}`;
    default:
      return type;
  }
}

function centsToEur(cents: number): string {
  return `${(cents / 100).toFixed(2)}€`;
}
