import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getLedger } from "@/lib/data";
import { LedgerFeed } from "../../ledger-feed";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;

export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getCompany(slug);
  if (!data) notFound();
  const { company, tasks } = data;

  const events = (await getLedger()).filter((e) => e.companySlug === slug);
  const pnl = (company.revenueCents - company.creditsSpent * 100) / 100; // credits priced ~€1/credit

  return (
    <main>
      <Link href="/" className="backlink">
        ← All companies
      </Link>
      <h1>
        {company.name} <span className={`dot ${company.status === "paused" ? "paused" : ""}`} style={{ display: "inline-block" }} />
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

      <div className="tasks">
        <h2 style={{ fontSize: "1.05rem" }}>Tasks</h2>
        {tasks.length === 0 && <p className="sub">No tasks yet.</p>}
        {tasks.map((t) => (
          <div className="task" key={t.title}>
            <span className={`pill ${t.status}`}>{t.status}</span>
            <span>{t.title}</span>
          </div>
        ))}
      </div>

      <section style={{ marginTop: "2rem" }}>
        <LedgerFeed initialEvents={events} companySlug={slug} />
      </section>
    </main>
  );
}
