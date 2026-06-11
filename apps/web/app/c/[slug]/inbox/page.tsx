import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getEmails } from "@/lib/data";

const dt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default async function InboxPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [data, emails] = await Promise.all([getCompany(slug), getEmails(slug)]);
  if (!data) notFound();
  const { company } = data;

  const inbox = emails.filter((e) => e.direction === "in");
  const sent = emails.filter((e) => e.direction === "out");

  return (
    <main>
      <Link href={`/c/${slug}`} className="backlink">
        ← {company.name}
      </Link>
      <h1>Inbox</h1>
      <p className="sub">
        {company.emailAddress ?? `hello@${slug}.opencorp.app`} · {inbox.length} received ·{" "}
        {sent.length} sent — every email on the ledger.
      </p>

      <section>
        <h2 style={{ fontSize: "1.05rem" }}>Received</h2>
        {inbox.length === 0 && <p className="sub">No inbound emails yet.</p>}
        {inbox.map((e) => (
          <Link key={e.id} href={`/c/${slug}/inbox/${e.id}`} className={`email-row ${e.read ? "" : "unread"}`}>
            <span className="email-from">{e.fromAddr}</span>
            <span className="email-subject">{e.subject}{!e.read && <span className="unread-dot" />}</span>
            <span className="email-date sub">{dt(e.createdAt)}</span>
          </Link>
        ))}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Sent</h2>
        {sent.length === 0 && <p className="sub">No outbound emails yet.</p>}
        {sent.map((e) => (
          <Link key={e.id} href={`/c/${slug}/inbox/${e.id}`} className="email-row">
            <span className="email-from">→ {e.toAddrs.join(", ")}</span>
            <span className="email-subject">{e.subject}</span>
            <span className="email-date sub">{dt(e.createdAt)}</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
