"use client";

import { useEffect, useState } from "react";
import { API_URL, type LedgerEvent } from "@/lib/data";

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

export function LedgerFeed({
  initialEvents,
  companySlug,
}: {
  initialEvents: LedgerEvent[];
  companySlug?: string;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [connected, setConnected] = useState(false);

  // re-render every 30s so relative timestamps stay honest
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // §9.2 — subscribe to the live firehose (PG LISTEN/NOTIFY → SSE) when an API
  // is configured. The demo preview keeps the static snapshot.
  useEffect(() => {
    if (!API_URL) return;
    const es = new EventSource(`${API_URL}/api/live`);
    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("ledger", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { seq: number; eventType: string; companyId: string | null };
        if (companySlug && d.companyId !== companySlug) return;
        setEvents((prev) => {
          if (prev.some((e) => e.seq === d.seq)) return prev;
          const next: LedgerEvent = {
            seq: d.seq,
            companySlug: d.companyId,
            actor: "",
            eventType: d.eventType,
            summary: "new event — verify on /api/ledger",
            hash: "live",
            createdAt: new Date().toISOString(),
          };
          return [next, ...prev].slice(0, 60);
        });
      } catch {
        /* ignore malformed frames */
      }
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [companySlug]);

  return (
    <div className="feed">
      <div className="feed-head">
        <span className="pulse" /> Live ledger — append-only, hash-chained
        <span className="badge" style={{ marginLeft: "auto" }}>
          {API_URL ? (connected ? "streaming" : "connecting…") : "demo snapshot"}
        </span>
      </div>
      {events.map((e) => (
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
