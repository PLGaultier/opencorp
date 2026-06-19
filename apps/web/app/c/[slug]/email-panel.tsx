"use client";

import Link from "next/link";
import { useState } from "react";
import type { Email } from "@/lib/data";
import { CopyButton } from "./copy-button";

const dt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Per-company email panel: the company's mailbox address, Inbox/Sent tabs and an
 * All/Unread filter, in the house style. Compose ("+ New") is a scaffold for now
 * — outbound is sent by the CEO autonomously.
 */
export function EmailPanel({ slug, address, emails }: { slug: string; address: string; emails: Email[] }) {
  const [tab, setTab] = useState<"inbox" | "sent" | "new">("inbox");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const inbox = emails.filter((e) => e.direction === "in");
  const sent = emails.filter((e) => e.direction === "out");
  const unread = inbox.filter((e) => !e.read).length;

  const rows = tab === "sent" ? sent : unreadOnly ? inbox.filter((e) => !e.read) : inbox;

  return (
    <section className="panel" style={{ marginTop: "1.5rem" }}>
      <div className="panel-head">
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>Email</h2>
        <span className="addr">{address}</span>
        <CopyButton value={address} />
      </div>

      <div className="seg">
        <button className={`seg-btn ${tab === "inbox" ? "on" : ""}`} onClick={() => setTab("inbox")}>Inbox</button>
        <button className={`seg-btn ${tab === "sent" ? "on" : ""}`} onClick={() => setTab("sent")}>Sent</button>
        <button className={`seg-btn ${tab === "new" ? "on" : ""}`} onClick={() => setTab("new")}>＋ New</button>
      </div>

      {tab === "inbox" && (
        <div className="seg sub-seg">
          <button className={`seg-btn ${!unreadOnly ? "on" : ""}`} onClick={() => setUnreadOnly(false)}>All</button>
          <button className={`seg-btn ${unreadOnly ? "on" : ""}`} onClick={() => setUnreadOnly(true)}>Unread</button>
        </div>
      )}

      {tab === "new" ? (
        <p className="sub" style={{ margin: "0.75rem 0 0" }}>
          The CEO sends outbound email autonomously. Manual compose is coming soon.
        </p>
      ) : rows.length === 0 ? (
        <p className="sub" style={{ margin: "0.75rem 0 0" }}>No emails yet.</p>
      ) : (
        <div className="email-list">
          {rows.map((e) => (
            <Link key={e.id} href={`/c/${slug}/inbox/${e.id}`} className={`email-row ${e.direction === "in" && !e.read ? "unread" : ""}`}>
              <span className="email-from">{e.direction === "in" ? e.fromAddr : `→ ${e.toAddrs.join(", ")}`}</span>
              <span className="email-subject">{e.subject}{e.direction === "in" && !e.read && <span className="unread-dot" />}</span>
              <span className="email-date sub">{dt(e.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}

      <p className="sub email-foot">
        {unread} unread · {inbox.length} received · {sent.length} sent
      </p>
    </section>
  );
}
