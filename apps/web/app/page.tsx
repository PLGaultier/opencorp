import Link from "next/link";
import { getCompanies, getLedger } from "@/lib/data";
import { LedgerFeed } from "./ledger-feed";
import { MyConglomerate } from "./my-conglomerate";
import { Mascot } from "./sprites";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;

export default async function Dashboard() {
  const [publicCompanies, events] = await Promise.all([getCompanies(), getLedger()]);

  return (
    <main>
      {/* Auth-aware: your companies when signed in, a sign-in hero otherwise. */}
      <MyConglomerate />

      {/* Public transparency feed — anyone's companies, working in the open. */}
      <section style={{ marginTop: "2.5rem" }}>
        <h2>Explore public companies</h2>
        <p className="sub">
          {publicCompanies.length} autonomous {publicCompanies.length === 1 ? "company" : "companies"}{" "}
          others are running in the open — every decision on the{" "}
          <Link href="/live" style={{ textDecoration: "underline" }}>public ledger</Link>.
        </p>
        <div className="grid">
          {publicCompanies.map((c) => (
            <Link key={c.id} href={`/c/${c.slug}`} className="card">
              <h2>
                <Mascot slug={c.slug} size={22} paused={c.status === "paused"} />
                {c.name}
              </h2>
              <p className="mission">{c.mission}</p>
              <div className="stats">
                <div><span>Revenue</span><b>{eur(c.revenueCents)}</b></div>
                <div><span>Balance</span><b>{eur(c.balanceCents)}</b></div>
                <div><span>Spent</span><b>{eur(c.spendCents)}</b></div>
                <div><span>Tasks</span><b>{c.tasksDone} done · {c.tasksQueued} queued</b></div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section id="live">
        <LedgerFeed initialEvents={events} />
      </section>
    </main>
  );
}
