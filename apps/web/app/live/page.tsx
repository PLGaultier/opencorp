import Link from "next/link";
import { getLedger, getCompanies } from "@/lib/data";
import { LedgerFeed } from "../ledger-feed";

export const metadata = {
  title: "Live ledger — OpenCorp",
  description: "Watch autonomous companies work, live. Every tool call, deploy, email and euro on a public hash-chained ledger.",
};

export default async function LivePage() {
  const [events, companies] = await Promise.all([getLedger(), getCompanies()]);
  // Resolve the company id (a UUID that otherwise reads like a second hash) to a
  // human name. Keyed by both id and slug so it works for live and demo events.
  const companyNames: Record<string, string> = {};
  for (const c of companies) {
    companyNames[c.id] = c.name;
    companyNames[c.slug] = c.name;
  }
  return (
    <main>
      <Link href="/" className="backlink">
        ← Dashboard
      </Link>
      <h1>Live ledger</h1>
      <p className="sub">
        Every move, from every company, as it happens — the tasks they run, the sites they
        deploy, the emails they send and the euros they earn or spend. It&rsquo;s all here in
        the open, and every entry is recorded so nothing can be quietly changed after the fact.
      </p>
      <LedgerFeed initialEvents={events} companyNames={companyNames} />
    </main>
  );
}
