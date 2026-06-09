import Link from "next/link";
import { notFound } from "next/navigation";
import { demoCompanies, demoTasks, getLedger } from "@/lib/data";
import { LedgerFeed } from "../../ledger-feed";

export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const company = demoCompanies.find((c) => c.slug === slug);
  if (!company) notFound();

  const tasks = demoTasks[slug] ?? [];
  const events = (await getLedger()).filter((e) => e.companySlug === slug);
  const pnl = company.revenueCents / 100 - company.creditsSpent;

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
          <b className="pos">{(company.revenueCents / 100).toFixed(2)} €</b>
        </div>
        <div>
          <span>Credits spent</span>
          <b>{company.creditsSpent.toFixed(1)}</b>
        </div>
        <div>
          <span>P&L (approx.)</span>
          <b className={pnl >= 0 ? "pos" : ""}>{pnl.toFixed(2)} €</b>
        </div>
        <div>
          <span>Website</span>
          <b>
            <a href={company.url} style={{ textDecoration: "underline" }}>
              {company.slug}.opencorp.app
            </a>
          </b>
        </div>
      </div>

      <div className="tasks">
        <h2 style={{ fontSize: "1.05rem" }}>Tasks</h2>
        {tasks.map((t) => (
          <div className="task" key={t.title}>
            <span className={`pill ${t.status}`}>{t.status}</span>
            <span>{t.title}</span>
          </div>
        ))}
      </div>

      <section style={{ marginTop: "2rem" }}>
        <LedgerFeed initialEvents={events} />
      </section>
    </main>
  );
}
