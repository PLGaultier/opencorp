"use client";

import { useEffect, useState } from "react";
import type { LedgerEvent } from "@/lib/data";

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function typeClass(t: string): string {
  if (t === "money_in" || t === "money_out") return "type money";
  if (t.includes("fail") || t.includes("refund")) return "type fail";
  return "type";
}

export function LedgerFeed({ initialEvents }: { initialEvents: LedgerEvent[] }) {
  // re-render every 30s so the relative timestamps stay honest
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="feed">
      <div className="feed-head">
        <span className="pulse" /> Live ledger — append-only, hash-chained
      </div>
      {initialEvents.map((e) => (
        <div className="event" key={e.seq}>
          <span className={typeClass(e.eventType)}>{e.eventType}</span>
          <span className="company">{e.companySlug ?? "system"}</span>
          <span>{e.summary}</span>
          <span className="hash" title={`seq ${e.seq}`}>
            {e.hash} · {timeAgo(e.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}
