import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getInsights } from "@/lib/data";
import { forwardCookie, isOwner } from "@/lib/server-auth";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;
const pct = (frac: number | null) => (frac == null ? "—" : `${(frac * 100).toFixed(2)}%`);
const x = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}×`);

const RANGES = [7, 30, 90];

/**
 * Per-company insights dashboard (ticket #4). Owner-only — it surfaces the same
 * report the agent `insights.get_report` tool and the CLI use (funnel, ROAS, ops
 * health, money, activity), rendered clean. Reuses @opencorp/insights via the
 * API; the funnel starts at ad clicks (visitor analytics rides the agent tool).
 */
export default async function InsightsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  if (!(await isOwner(slug))) notFound();
  const range = Number((await searchParams).range);
  const rangeDays = RANGES.includes(range) ? range : 7;

  const cookie = await forwardCookie();
  const [data, report] = await Promise.all([getCompany(slug), getInsights(slug, rangeDays, cookie)]);
  if (!data) notFound();
  const { company } = data;

  if (!report) {
    return (
      <main>
        <Link href={`/c/${slug}`} className="backlink">← {company.name}</Link>
        <h1>Insights</h1>
        <p className="sub">No insights available yet — this company hasn&apos;t produced any activity.</p>
      </main>
    );
  }

  const { money, acquisition: acq, funnel, ops, activity } = report;
  const blockers = ops.pendingApprovals.reduce((n, p) => n + p.count, 0);

  return (
    <main>
      <Link href={`/c/${slug}`} className="backlink">← {company.name}</Link>
      <div className="ins-head">
        <h1 style={{ marginBottom: 0 }}>Insights</h1>
        <nav className="ins-range">
          {RANGES.map((r) => (
            <Link key={r} href={`/c/${slug}/insights?range=${r}`} className={r === rangeDays ? "on" : ""}>
              {r}d
            </Link>
          ))}
        </nav>
      </div>
      <p className="sub">What this company did over the last {rangeDays} days — and where it&apos;s stuck. Same read the CEO agent sees.</p>

      {/* KPI strip */}
      <div className="ins-grid">
        <div className="ins-card">
          <h2>Revenue</h2>
          <div className="ins-kpi pos">{eur(money.revenueGrossCents)}<small>{money.salesCount} sales</small></div>
        </div>
        <div className="ins-card">
          <h2>ROAS</h2>
          <div className="ins-kpi">{x(acq.roas)}<small>{eur(acq.spendCents)} ad spend</small></div>
        </div>
        <div className="ins-card">
          <h2>Tasks</h2>
          <div className="ins-kpi">
            <span className="ins-good">{ops.tasksDone}✓</span>{" "}
            <span className={ops.tasksFailed > 0 ? "ins-bad" : undefined}>{ops.tasksFailed}✗</span>
            <small>completed this period</small>
          </div>
        </div>
        <div className="ins-card">
          <h2>Runway</h2>
          <div className="ins-kpi">{money.runwayDays == null ? "—" : `~${money.runwayDays}d`}<small>{eur(money.creditBalanceCents)} credits left</small></div>
        </div>
      </div>

      {/* Funnel + acquisition */}
      <div className="ins-grid">
        <div className="ins-card">
          <h2>Funnel</h2>
          {(() => {
            const steps = [
              { label: "visitors", n: funnel.visitors },
              { label: "ad clicks", n: funnel.adClicks },
              { label: "sales", n: funnel.sales },
            ];
            const max = Math.max(1, ...steps.map((s) => s.n ?? 0));
            return steps.map((s) => (
              <div className="ins-bar-row" key={s.label}>
                <span className="ins-bar-label">{s.label}</span>
                <span className="ins-bar">
                  <span
                    className="ins-bar-fill"
                    style={{ width: `${s.n == null ? 0 : Math.max(s.n > 0 ? 6 : 0, Math.round(((s.n ?? 0) / max) * 100))}%` }}
                  />
                </span>
                <b>{s.n ?? "—"}</b>
              </div>
            ));
          })()}
          <div className="ins-row" style={{ marginTop: "0.75rem" }}>
            <span>Conversion</span><b>{pct(funnel.conversion)}</b>
          </div>
        </div>
        <div className="ins-card">
          <h2>Acquisition</h2>
          <div className="ins-row"><span>Ad spend</span><b>{eur(acq.spendCents)}</b></div>
          <div className="ins-row"><span>Attributed revenue</span><b className="pos">{eur(acq.attributedRevenueCents)}</b></div>
          <div className="ins-row"><span>Impressions / clicks</span><b>{acq.impressions} / {acq.clicks}</b></div>
          {acq.bestCampaign && (
            <div className="ins-row"><span>Best campaign</span><b className="ins-good">{acq.bestCampaign.name} · {x(acq.bestCampaign.roas)}</b></div>
          )}
        </div>
      </div>

      {/* Ops health — where the agent is stuck */}
      <div className="ins-grid">
        <div className="ins-card">
          <h2>Where it&apos;s stuck</h2>
          {ops.topFailingTools.length === 0 ? (
            <div className="ins-row"><span>Tool failures</span><b className="ins-good">none ✓</b></div>
          ) : (
            ops.topFailingTools.map((t) => (
              <div className="ins-row" key={`${t.server}.${t.tool}`}>
                <span>{t.server}.{t.tool}</span><b className="ins-bad">×{t.count}</b>
              </div>
            ))
          )}
          {ops.rateLimitedCount > 0 && (
            <div className="ins-row"><span>Rate-limited calls</span><b className="ins-warn">{ops.rateLimitedCount}</b></div>
          )}
          <div className="ins-row">
            <span>Awaiting your approval</span>
            <b className={blockers > 0 ? "ins-warn" : "ins-good"}>
              {blockers === 0 ? "none" : `${blockers} (${ops.pendingApprovals.map((p) => p.tool).join(", ")})`}
            </b>
          </div>
        </div>
        <div className="ins-card">
          <h2>Money</h2>
          <div className="ins-row"><span>Net revenue</span><b className="pos">{eur(money.revenueNetCents)}</b></div>
          <div className="ins-row"><span>Credits burned</span><b>{eur(money.creditBurnCents)}</b></div>
          <div className="ins-row"><span>Cash balance</span><b>{eur(money.realBalanceCents)}</b></div>
          <div className="ins-row"><span>Credit balance</span><b>{eur(money.creditBalanceCents)}</b></div>
        </div>
      </div>

      {/* Recent activity — replayed in the house CRT */}
      {activity.length > 0 && (
        <div className="terminal mini-crt" style={{ marginTop: "1rem" }}>
          <div className="term-head">
            <span className="term-live" />
            <span className="term-title">Recent activity — last {rangeDays} days</span>
          </div>
          <div className="term-body">
            {activity.map((a, i) => (
              <div className="tl" key={i}>
                <span className="tl-time" />
                <span className="tl-actor a-system">[LOG ]</span>
                <span className="tl-body dim">{a.summary}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
