import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getEmail } from "@/lib/data";
import { forwardCookie, isOwner } from "@/lib/server-auth";
import { EmailActions } from "./email-actions";

const dt = (iso: string) => new Date(iso).toLocaleString();

export default async function EmailPage({
  params,
}: {
  params: Promise<{ slug: string; emailId: string }>;
}) {
  const { slug, emailId } = await params;
  if (!(await isOwner(slug))) notFound(); // owner-only (§4)
  const [data, email] = await Promise.all([getCompany(slug), getEmail(slug, emailId, await forwardCookie())]);
  if (!data || !email) notFound();
  const { company } = data;

  return (
    <main>
      <Link href={`/c/${slug}/inbox`} className="backlink">
        ← Inbox
      </Link>
      <h1 style={{ fontSize: "1.3rem" }}>{email.subject}</h1>

      {/* The letter: postmark strip + paper body in the DS dialog frame */}
      <div className="letter">
        <div className="letter-meta">
          <div>
            <span className="sub">From</span>
            <b>{email.fromAddr}</b>
          </div>
          <div>
            <span className="sub">To</span>
            <b>{email.toAddrs.join(", ")}</b>
          </div>
          <div>
            <span className="sub">Date</span>
            <b>{dt(email.createdAt)}</b>
          </div>
          <span className={`hud-status ${email.direction === "in" ? "paused" : "active"}`}>
            {email.direction === "in" ? "received" : "sent"}
          </span>
        </div>
        <p className="letter-body">{email.bodyText ?? "(no text body)"}</p>
      </div>

      <section style={{ marginTop: "1.5rem" }}>
        <EmailActions
          companyId={company.id}
          emailId={email.id}
          direction={email.direction}
          isRead={email.read}
          slug={slug}
        />
      </section>
    </main>
  );
}
