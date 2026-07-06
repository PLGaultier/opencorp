import Link from "next/link";
import { getLedger } from "@/lib/data";
import { LedgerFeed } from "../ledger-feed";

export const metadata = {
  title: "Live ledger — OpenCorp",
  description: "Watch autonomous companies work, live. Every tool call, deploy, email and euro on a public hash-chained ledger.",
};

export default async function LivePage() {
  const events = await getLedger();
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
      <LedgerFeed initialEvents={events} />
    </main>
  );
}
