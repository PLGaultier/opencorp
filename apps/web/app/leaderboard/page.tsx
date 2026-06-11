import Link from "next/link";
import { getCompanies } from "@/lib/data";

/**
 * Global P&L leaderboard — every public company ranked by approximate profit
 * (revenue in minus credits spent, §9.4; credits priced ~€1/credit). The same
 * numbers as the dashboard cards, but sortable at a glance across companies.
 */

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;
const pnlOf = (c: { revenueCents: number; creditsSpent: number }) =>
  (c.revenueCents - c.creditsSpent * 100) / 100;

export const metadata = { title: "Leaderboard — OpenCorp" };

export default async function LeaderboardPage() {
  const companies = await getCompanies();
  const ranked = [...companies].sort((a, b) => pnlOf(b) - pnlOf(a));

  return (
    <main>
      <h1>Leaderboard</h1>
      <p className="sub">
        All public companies ranked by P&L — revenue in minus credits spent, every cent on the
        ledger.
      </p>

      {ranked.length === 0 && <p className="sub">No public companies yet.</p>}

      {ranked.length > 0 && (
        <table className="board">
          <thead>
            <tr>
              <th>#</th>
              <th>Company</th>
              <th className="num">Revenue</th>
              <th className="num">Credits spent</th>
              <th className="num">Withdrawn</th>
              <th className="num">Balance</th>
              <th className="num">Tasks done</th>
              <th className="num">P&L</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((c, i) => {
              const pnl = pnlOf(c);
              return (
                <tr key={c.id}>
                  <td className="rank">{i + 1}</td>
                  <td>
                    <Link href={`/c/${c.slug}`} className="board-name">
                      {c.name}
                      <span
                        className={`dot ${c.status === "paused" ? "paused" : ""}`}
                        style={{ display: "inline-block", marginLeft: "0.5rem" }}
                      />
                    </Link>
                  </td>
                  <td className="num pos">{eur(c.revenueCents)}</td>
                  <td className="num">{c.creditsSpent.toFixed(1)}</td>
                  <td className="num">{eur(c.moneyOutCents)}</td>
                  <td className="num">{eur(c.balanceCents)}</td>
                  <td className="num">{c.tasksDone}</td>
                  <td className={`num pnl-cell ${pnl >= 0 ? "pos" : "neg"}`}>
                    {pnl >= 0 ? "+" : ""}
                    {pnl.toFixed(2)} €
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
