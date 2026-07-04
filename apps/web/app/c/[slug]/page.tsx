import Link from "next/link";
import { notFound } from "next/navigation";
import { getAnalytics, getCompany, getCompanyEvents, getCompanyTasks, getEmails, getProducts, siteUrl, GITHUB_ENABLED, type TerminalEvent } from "@/lib/data";
import { levelMeta } from "@/lib/levels";
import { forwardCookie, isOwner } from "@/lib/server-auth";
import { CompanyControls } from "./controls";
import { CompanyTerminal } from "./terminal";
import { CeoChat } from "./ceo-chat";
import { CompanyHud, heartsForRunway } from "./hud";
import { CompanyBadges } from "./badges";
import { DashboardTabs, type MenuTab } from "./dashboard-tabs";
import { TaskComposer } from "./task-composer";
import { TaskList } from "./task-list";
import { EmailPanel } from "./email-panel";
import { CopyButton } from "./copy-button";
import { EnginePanel } from "./engine-panel";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;

// Tasks are shown active-first so the user sees what's happening now at a glance.
const TASK_ORDER = ["running", "queued", "pending", "failed", "done"] as const;
const TASK_LABEL: Record<string, string> = {
  running: "Running",
  queued: "Queued",
  pending: "Pending",
  failed: "Failed",
  done: "Done",
};

/** Cumulative money trend from the ledger events — decorative HUD sparkline. */
function moneySpark(events: TerminalEvent[]): number[] {
  let acc = 0;
  const points = [0];
  for (const e of events) {
    if (e.eventType !== "money_in" && e.eventType !== "money_out") continue;
    const cents = Number((e.payload as { amountCents?: unknown })?.amountCents ?? 0);
    acc += e.eventType === "money_in" ? cents : -cents;
    points.push(acc);
  }
  return points.length > 1 ? points.slice(-30) : [0, 0];
}

export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // §4 — a logged-out visitor sees only the public profile (P&L stats, website,
  // products + payment link) and the public ledger. The owner sees everything.
  const owner = await isOwner(slug);
  const data = await getCompany(slug);
  if (!data) notFound();
  const { company, tasks } = data;

  // Public data (everyone): the ledger + the storefront.
  const [{ companyId, events }, products] = await Promise.all([
    getCompanyEvents(slug),
    getProducts(slug),
  ]);

  // Owner-only operational data: tasks, inbox, site analytics. Skipped entirely
  // (not just hidden) for non-owners, so it never reaches the browser.
  const cookie = owner ? await forwardCookie() : "";
  const [richTasks, emails, analytics] = owner
    ? await Promise.all([getCompanyTasks(slug, cookie), getEmails(slug, undefined, cookie), getAnalytics(slug)])
    : [[], [], { pageviews: 0, visitors: 0, sessions: 0, peakPerDay: 0 }];
  const pnlCents = company.revenueCents - company.spendCents; // real revenue in minus real money spent
  const cid = companyId ?? company.id;
  const siteHref = siteUrl(slug);
  const siteDisplay = siteHref.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const emailAddress = company.emailAddress ?? `hello@${slug}.opencorp.app`;
  const referralLink = `https://app.nanocorp.so/login?ref=${slug}`;
  const payLink = products.find((p) => p.paymentLink.startsWith("http"))?.paymentLink ?? `https://buy.stripe.com/demo_${slug}`;
  const testPayLink = `https://buy.stripe.com/test_demo_${slug}`;

  // HUD: HP hearts from runway (same estimate the Engine widget uses), gold = P&L.
  const paused = company.status === "paused";
  const perTaskCents = levelMeta(company.modelLevel).perTaskCents;
  const burnPerDay = perTaskCents * Math.max(1, company.dailyTaskCap);
  const runwayDays = burnPerDay > 0 ? company.balanceCents / burnPerDay : 0;
  const outOfCredits = company.balanceCents <= 0;
  const hearts = heartsForRunway(runwayDays, outOfCredits);
  const runwayLabel = paused ? "paused" : outOfCredits ? "0d" : `≈${runwayDays < 1 ? "<1" : Math.round(runwayDays)}d`;

  // Normalise the two task sources into one shape and sort active-first.
  const taskList = (
    richTasks.length > 0
      ? richTasks.map((t) => ({ key: t.id, href: `/c/${slug}/tasks/${t.id}`, status: t.status, title: t.title }))
      : tasks.map((t) => ({ key: t.title, href: undefined, status: t.status, title: t.title }))
  ).sort((a, b) => TASK_ORDER.indexOf(a.status) - TASK_ORDER.indexOf(b.status));
  const taskCounts = TASK_ORDER.map((s) => [s, taskList.filter((t) => t.status === s).length] as const).filter(
    ([, n]) => n > 0,
  );

  /* ── Menu tabs — one panel on screen at a time ──────────────────────────── */

  const siteTab = (
    <>
      <div className="panel-head">
        <h2 style={{ margin: 0 }}>Website</h2>
        <a href={siteHref} target="_blank" rel="noreferrer" className="addr">
          {siteDisplay}
        </a>
        <CopyButton value={siteHref} />
        <a href={siteHref} target="_blank" rel="noreferrer" className="site-open" style={{ marginLeft: "auto" }}>
          Open ↗
        </a>
      </div>
      <a href={siteHref} target="_blank" rel="noreferrer" className="site-preview" aria-label="Open website">
        <iframe src={siteHref} title={`${company.name} website preview`} loading="lazy" tabIndex={-1} />
        <span className="site-preview-bar">{siteDisplay} — open ↗</span>
      </a>
    </>
  );

  const tasksTab = (
    <div className="tasks">
      <div className="tasks-head">
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>Tasks</h2>
        {taskCounts.length > 0 && (
          <div className="task-summary">
            {taskCounts.map(([status, n]) => (
              <span className={`task-chip ${status}`} key={status}>
                <span className="task-dot" />
                {n} {TASK_LABEL[status]}
              </span>
            ))}
          </div>
        )}
        <div className="tasks-action">
          <TaskComposer companyId={cid} />
        </div>
      </div>

      <TaskList tasks={taskList} />
    </div>
  );

  // Payments — the storefront (products + payment link) is public so a
  // customer can buy; the owner-only rows manage the account.
  const shopTab = (
    <>
      <div className="panel-head">
        <h2 style={{ margin: 0 }}>Payments</h2>
        {owner && (
          <Link href={`/c/${slug}/revenue`} className="sub" style={{ fontSize: "0.82rem", textDecoration: "underline", marginLeft: "auto" }}>
            revenue & history ↗
          </Link>
        )}
      </div>

      {owner && (
        <>
          <div className="pay-balance">
            <span className="sub">Balance</span>
            <b>{eur(company.balanceCents)}</b>
          </div>

          <div className="pay-row">
            <span className="pay-label">Referrals</span>
            <code className="pay-link">{referralLink}</code>
            <CopyButton value={referralLink} />
            <span className="sub">0 referrals</span>
          </div>
        </>
      )}

      <div className="pay-row">
        <span className="pay-label">Payment link</span>
        <code className="pay-link">{payLink}</code>
        <CopyButton value={payLink} />
      </div>

      {owner && (
        <>
          <div className="pay-row">
            <span className="pay-label">Test link</span>
            <code className="pay-link">{testPayLink}</code>
            <CopyButton value={testPayLink} />
          </div>
          <p className="sub" style={{ margin: "0.1rem 0 0" }}>
            Pay with test card <code>4242 4242 4242 4242</code> — any future expiry, any CVC. No real charge, and it doesn&apos;t count as revenue.
          </p>
        </>
      )}

      <h3 style={{ fontSize: "0.9rem", margin: "1.1rem 0 0.5rem" }}>Products</h3>
      {products.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>No products yet.</p>
      ) : (
        <div className="product-grid">
          {products.map((p) => (
            <div key={p.id} className="product-card">
              <span className="product-name">{p.name}</span>
              <span className="product-price">{(p.priceCents / 100).toFixed(2)} {p.currency.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}
      {owner && (
        <>
          {/* Ads / outbound — locked upsell (§14, future) */}
          <div className="locked-card" style={{ marginTop: "1.25rem" }}>
            <div>
              <b>Outbound · Locked</b>
              <p className="sub" style={{ margin: "0.2rem 0 0" }}>
                Automated prospect discovery and cold outreach, run by the CMO within your budget cap.
              </p>
            </div>
            <Link href="/credits" className="locked-cta">
              Unlock prospect discovery →
            </Link>
          </div>
          <p className="sub" style={{ margin: "0.85rem 0 0" }}>
            <Link href="/credits" style={{ textDecoration: "underline" }}>Learn more about credits &amp; billing →</Link>
          </p>
        </>
      )}
    </>
  );

  const statsTab = (
    <>
      <div className="panel-head">
        <h2 style={{ margin: 0 }}>Stats</h2>
      </div>
      <div className="pnl">
        <div>
          <span>Revenue</span>
          <b className="pos">{eur(company.revenueCents)}</b>
        </div>
        <div>
          <span>Withdrawn</span>
          <b>{eur(company.moneyOutCents)}</b>
        </div>
        <div>
          <span>Balance</span>
          <b>{eur(company.balanceCents)}</b>
        </div>
        <div>
          <span>Spent</span>
          <b>{eur(company.spendCents)}</b>
        </div>
        <div>
          <span>P&L (approx.)</span>
          <b className={pnlCents >= 0 ? "pos" : ""}>{(pnlCents / 100).toFixed(2)} €</b>
        </div>
      </div>

      {owner && (
        <>
          <div className="panel-head" style={{ marginTop: "1.5rem" }}>
            <h2 style={{ margin: 0 }}>Site · last 30 days</h2>
            <a href={siteHref} target="_blank" rel="noreferrer" className="sub" style={{ fontSize: "0.82rem", textDecoration: "underline", marginLeft: "auto" }}>
              View site ↗
            </a>
          </div>
          {analytics.peakPerDay > 0 && (
            <p className="sub" style={{ margin: "0 0 0.6rem" }}>peak {analytics.peakPerDay} PV/day</p>
          )}
          <div className="metric-row">
            <div className="metric">
              <b>{analytics.pageviews}</b>
              <span className="sub">Pageviews</span>
            </div>
            <div className="metric">
              <b>{analytics.visitors}</b>
              <span className="sub">Visitors</span>
            </div>
            <div className="metric">
              <b>{analytics.sessions}</b>
              <span className="sub">Sessions</span>
            </div>
          </div>
        </>
      )}

      <div className="panel-head" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>Badges</h2>
      </div>
      <CompanyBadges
        revenueCents={company.revenueCents}
        pnlCents={pnlCents}
        productCount={products.length}
        hasDeploy={events.some((e) => e.eventType === "deploy")}
        emailsSent={emails.filter((e) => e.direction === "out").length}
      />
    </>
  );

  const systemTab = (
    <div className="system-grid">
      <EnginePanel
        companyId={cid}
        initialLevel={company.modelLevel}
        initialBundle={company.modelBundle}
        balanceCents={company.balanceCents}
        dailyTaskCap={company.dailyTaskCap}
        paused={paused}
      />
      <CompanyControls companyId={cid} initialStatus={company.status} />
    </div>
  );

  const tabs: MenuTab[] = owner
    ? [
        { id: "tasks", label: "Tasks", content: tasksTab },
        { id: "site", label: "Site", content: siteTab },
        { id: "mail", label: "Mail", content: <EmailPanel slug={slug} address={emailAddress} emails={emails} /> },
        { id: "shop", label: "Shop", content: shopTab },
        { id: "stats", label: "Stats", content: statsTab },
        { id: "system", label: "System", content: systemTab },
      ]
    : [
        { id: "site", label: "Site", content: siteTab },
        { id: "shop", label: "Shop", content: shopTab },
        { id: "stats", label: "Stats", content: statsTab },
      ];

  return (
    <main>
      <Link href="/" className="backlink">
        ← All companies
      </Link>

      <CompanyHud
        slug={slug}
        name={company.name}
        mission={company.mission}
        paused={paused}
        hearts={hearts}
        runwayLabel={runwayLabel}
        pnlCents={pnlCents}
        spark={moneySpark(events)}
        owner={owner}
      />

      {/* The centerpiece: CEO orders in, agent activity out — live. */}
      <CompanyTerminal companyId={cid} initialEvents={events} />
      {owner && <CeoChat companyId={cid} />}

      {!owner && (
        <p className="sub" style={{ margin: "0.75rem 0 0" }}>
          You&apos;re viewing this company&apos;s public page — its P&L and every action on the
          hash-chained ledger above. {GITHUB_ENABLED ? (
            <Link href="/login" style={{ textDecoration: "underline" }}>Sign in</Link>
          ) : (
            "Sign in"
          )}{" "}
          as the owner to manage tasks, email and settings.
        </p>
      )}

      <DashboardTabs tabs={tabs} initial={owner ? "tasks" : "site"} />
    </main>
  );
}
