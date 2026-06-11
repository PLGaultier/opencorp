import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgents, getCompany, getCompanyEvents, getCompanyTasks, getEmails } from "@/lib/data";
import { CompanyControls } from "./controls";
import { CompanyTerminal } from "./terminal";
import { TaskComposer } from "./task-composer";
import { OrgChart } from "./org";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;

export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getCompany(slug);
  if (!data) notFound();
  const { company, tasks } = data;

  const [{ companyId, events }, richTasks, org, recentEmails] = await Promise.all([
    getCompanyEvents(slug),
    getCompanyTasks(slug),
    getAgents(slug),
    getEmails(slug),
  ]);
  const pnl = (company.revenueCents - company.creditsSpent * 100) / 100; // credits priced ~€1/credit

  return (
    <main>
      <Link href="/" className="backlink">
        ← All companies
      </Link>
      <h1>
        {company.name} <span className={`dot ${company.status === "paused" ? "paused" : ""}`} style={{ display: "inline-block" }} />{" "}
        <Link href={`/c/${slug}/settings`} className="sub" style={{ fontSize: "0.85rem", textDecoration: "underline" }}>
          settings
        </Link>
      </h1>
      <p className="sub">{company.mission}</p>

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
          <span>Credits spent</span>
          <b>{company.creditsSpent.toFixed(1)}</b>
        </div>
        <div>
          <span>P&L (approx.)</span>
          <b className={pnl >= 0 ? "pos" : ""}>{pnl.toFixed(2)} €</b>
        </div>
      </div>
      <p className="sub" style={{ margin: "0.75rem 0 0" }}>
        Website:{" "}
        <a href={`http://${slug}.opencorp.app`} style={{ textDecoration: "underline" }}>
          {slug}.opencorp.app
        </a>
      </p>

      {recentEmails.length > 0 && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1.05rem" }}>
            Inbox{" "}
            <Link href={`/c/${slug}/inbox`} className="sub" style={{ fontSize: "0.82rem", textDecoration: "underline" }}>
              view all
            </Link>
          </h2>
          {recentEmails.slice(0, 4).map((e) => (
            <Link key={e.id} href={`/c/${slug}/inbox/${e.id}`} className={`email-row ${!e.read ? "unread" : ""}`}>
              <span className="email-from">{e.direction === "in" ? e.fromAddr : `→ ${e.toAddrs[0]}`}</span>
              <span className="email-subject">{e.subject}{!e.read && <span className="unread-dot" />}</span>
            </Link>
          ))}
        </section>
      )}

      <OrgChart agents={org.agents} departmentPlans={org.departmentPlans} />

      <div className="tasks">
        <h2 style={{ fontSize: "1.05rem" }}>Tasks</h2>
        {richTasks.length === 0 && tasks.length === 0 && <p className="sub">No tasks yet.</p>}
        {richTasks.length > 0
          ? richTasks.map((t) => (
              <Link className="task" key={t.id} href={`/c/${slug}/tasks/${t.id}`}>
                <span className={`pill ${t.status}`}>{t.status}</span>
                <span>{t.title}</span>
                {t.traceUrl && (
                  <span className="sub" style={{ marginLeft: "auto", textDecoration: "underline" }}>
                    trace ↗
                  </span>
                )}
              </Link>
            ))
          : tasks.map((t) => (
              <div className="task" key={t.title}>
                <span className={`pill ${t.status}`}>{t.status}</span>
                <span>{t.title}</span>
                {t.traceUrl && (
                  <a href={t.traceUrl} className="sub" style={{ marginLeft: "auto", textDecoration: "underline" }}>
                    trace ↗
                  </a>
                )}
              </div>
            ))}
        <TaskComposer companyId={companyId ?? company.id} />
      </div>

      <section style={{ marginTop: "2rem" }}>
        <CompanyControls companyId={companyId ?? company.id} initialStatus={company.status} />
      </section>

      <section style={{ marginTop: "1rem" }}>
        <CompanyTerminal companyId={companyId ?? company.id} initialEvents={events} />
      </section>
    </main>
  );
}
