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
        The global firehose (§9.2): every agent action across every company, streamed from the
        append-only, hash-chained ledger. Verify any slice at{" "}
        <code style={{ fontFamily: "var(--mono)" }}>/api/ledger/verify</code>.
      </p>
      <LedgerFeed initialEvents={events} />
    </main>
  );
}
