import Link from "next/link";
import { getCompanies, getLedger } from "@/lib/data";
import { LedgerFeed } from "./ledger-feed";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;

export default async function Dashboard() {
  const [companies, events] = await Promise.all([getCompanies(), getLedger()]);
  const totalRevenue = companies.reduce((s, c) => s + c.revenueCents, 0);
  const totalBalance = companies.reduce((s, c) => s + c.balanceCents, 0);
  const totalCredits = companies.reduce((s, c) => s + c.creditsSpent, 0);

  return (
    <main>
      <h1>Conglomerate</h1>
      <p className="sub">
        {companies.length} companies · {eur(totalRevenue)} revenue · {eur(totalBalance)} balance ·{" "}
        {totalCredits.toFixed(1)} credits spent — every number verifiable on the{" "}
        <Link href="/live" style={{ textDecoration: "underline" }}>
          public ledger
        </Link>
        .
      </p>

      <div className="grid">
        {companies.map((c) => (
          <Link key={c.id} href={`/c/${c.slug}`} className="card">
            <h2>
              <span className={`dot ${c.status === "paused" ? "paused" : ""}`} />
              {c.name}
            </h2>
            <p className="mission">{c.mission}</p>
            <div className="stats">
              <div>
                <span>Revenue</span>
                <b>{eur(c.revenueCents)}</b>
              </div>
              <div>
                <span>Balance</span>
                <b>{eur(c.balanceCents)}</b>
              </div>
              <div>
                <span>Credits</span>
                <b>{c.creditsSpent.toFixed(1)}</b>
              </div>
              <div>
                <span>Tasks</span>
                <b>
                  {c.tasksDone} done · {c.tasksQueued} queued
                </b>
              </div>
            </div>
          </Link>
        ))}
        <Link href="/new" className="card new-company">
          <h2>＋ New company</h2>
          <p className="mission">
            One prompt founds a company: website, email, database, repo and a CEO agent.
          </p>
        </Link>
      </div>

      <section id="live">
        <LedgerFeed initialEvents={events} />
      </section>
    </main>
  );
}
