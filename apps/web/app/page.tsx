import Link from "next/link";
import { getCompanies, getLedger } from "@/lib/data";
import { LedgerFeed } from "./ledger-feed";

export default async function Dashboard() {
  const [companies, events] = await Promise.all([getCompanies(), getLedger()]);
  const totalRevenue = companies.reduce((s, c) => s + c.revenueCents, 0);
  const totalCredits = companies.reduce((s, c) => s + c.creditsSpent, 0);

  return (
    <main>
      <h1>Conglomerate</h1>
      <p className="sub">
        {companies.length} companies · {(totalRevenue / 100).toFixed(2)} € revenue ·{" "}
        {totalCredits.toFixed(1)} credits spent — every number verifiable on the{" "}
        <a href="#live" style={{ textDecoration: "underline" }}>
          public ledger
        </a>
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
                <b>{(c.revenueCents / 100).toFixed(2)} €</b>
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
      </div>

      <section id="live">
        <LedgerFeed initialEvents={events} />
      </section>
    </main>
  );
}
