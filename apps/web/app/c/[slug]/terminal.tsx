"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL, type TerminalEvent } from "@/lib/data";

/**
 * Company terminal (§9.2): the full pipeline under the lid, rendered from the
 * same hash-chained ledger anyone can verify — department plans, CEO
 * synthesis, credit movements, worker thoughts (worker_step), audited tool
 * calls, task states, and the daily brief, live over SSE.
 */

type P = Record<string, unknown>;
const p = (e: TerminalEvent): P => (e.payload ?? {}) as P;
const s = (v: unknown, max = 600): string =>
  (typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, max);

function actorClass(actor: string): string {
  if (actor === "ceo") return "a-ceo";
  if (actor.startsWith("dept:")) return "a-dept";
  if (actor.startsWith("worker:")) return "a-worker";
  if (actor === "user") return "a-user";
  return "a-system";
}

function shortActor(actor: string): string {
  if (actor.startsWith("worker:")) return `worker:${actor.slice(7, 15)}`;
  return actor;
}

/** One ledger event → terminal lines (first line carries the actor prompt). */
function renderLines(e: TerminalEvent): { text: string; cls?: string }[] {
  const d = p(e);
  switch (e.eventType) {
    case "department_plan": {
      const lines: { text: string; cls?: string }[] = [{ text: s(d.headline) }];
      for (const t of (d.proposedTasks as string[]) ?? [])
        lines.push({ text: `  → proposes: ${s(t)}`, cls: "dim" });
      if (d.degradedToFallback) lines.push({ text: `  ⚠ degraded to fallback`, cls: "warn" });
      return lines;
    }
    case "ceo_plan": {
      const created = (d.createdTasks as string[]) ?? [];
      return [
        { text: created.length ? `plan synthesized — queued: ${created.join(" · ")}` : "plan synthesized — nothing new queued" },
        ...(d.missionUpdated ? [{ text: "  mission updated", cls: "warn" }] : []),
      ];
    }
    case "daily_brief":
      return [{ text: `📋 ${s(d.brief, 1200)}` }];
    case "worker_step":
      return [{ text: `#${d.n} ${s(d.thought)}${d.tool ? `  → ${s(d.tool, 80)}` : ""}` }];
    case "tool_call": {
      const outcome = s(d.outcome, 40);
      const cls = outcome === "ok" ? "ok" : "fail";
      return [{ text: `$ ${s(d.server, 20)}.${s(d.tool, 40)}(${d.args ? s(d.args, 160) : ""}) → ${outcome}`, cls }];
    }
    case "task_state": {
      const status = s(d.status, 20);
      const lines = [{ text: `task "${s(d.title, 120)}" → ${status}`, cls: status === "failed" ? "fail" : status === "done" ? "ok" : undefined }];
      if (d.resultSummary) lines.push({ text: `  ${s(d.resultSummary, 400)}`, cls: "dim" });
      if (d.error) lines.push({ text: `  error: ${s(d.error, 200)}`, cls: "fail" });
      return lines;
    }
    case "credit_change": {
      const delta = Number(d.delta ?? 0);
      return [{ text: `${delta > 0 ? "+" : ""}${delta} credit (${s(d.reason, 40)})`, cls: delta > 0 ? "ok" : "dim" }];
    }
    case "ceo_chat":
      return [
        { text: `owner: ${s(d.message, 400)}`, cls: "dim" },
        { text: `ceo: ${s(d.reply, 800)}` },
      ];
    case "email_sent":
      return [{ text: `✉ → ${s((d.to as string[])?.join(", "), 120)} — "${s(d.subject, 120)}"` }];
    case "deploy":
      return [{ text: `🚀 deploy ${s(d.kind, 30)} → ${s(d.url ?? d.domain, 120)}`, cls: "ok" }];
    case "money_in":
      return [{ text: `💶 payment received: €${(Number(d.amountCents ?? 0) / 100).toFixed(2)}`, cls: "money" }];
    case "money_out":
      return [{ text: `💸 withdrawal: €${(Number(d.amountCents ?? 0) / 100).toFixed(2)}`, cls: "money" }];
    case "product_created":
      return [{ text: `🏷 product "${s(d.name, 80)}" — €${(Number(d.priceCents ?? 0) / 100).toFixed(2)}`, cls: "ok" }];
    case "mission_updated":
      return [{ text: `mission updated → ${s(d.to, 300)}`, cls: "warn" }];
    case "company_status":
      return [{ text: `company → ${s(d.status, 20)}`, cls: "warn" }];
    case "heartbeat_scheduled":
      return [{ text: `⏰ daily heartbeat scheduled (cron: ${s(d.cron, 30)})`, cls: "ok" }];
    case "company_created":
      return [{ text: `🏁 company created — ${s(d.url ?? d.slug, 120)}`, cls: "ok" }];
    default:
      return [{ text: `${e.eventType} ${s(e.payload, 200)}`, cls: "dim" }];
  }
}

const hhmmss = (iso: string) => new Date(iso).toTimeString().slice(0, 8);

export function CompanyTerminal({
  companyId,
  initialEvents,
}: {
  companyId: string | null;
  initialEvents: TerminalEvent[];
}) {
  const [events, setEvents] = useState(initialEvents);
  const [connected, setConnected] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // live tail: per-company SSE with enriched frames
  useEffect(() => {
    if (!API_URL || !companyId) return;
    const es = new EventSource(`${API_URL}/api/live?company=${companyId}`);
    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("ledger", (ev) => {
      try {
        const e = JSON.parse((ev as MessageEvent).data) as TerminalEvent;
        if (typeof e.seq !== "number" || !e.eventType) return;
        setEvents((prev) => (prev.some((x) => x.seq === e.seq) ? prev : [...prev, e].slice(-400)));
      } catch {
        /* ignore malformed frames */
      }
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [companyId]);

  // autoscroll unless the user scrolled up to read history
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div className="terminal">
      <div className="term-head">
        <span className="term-dot r" />
        <span className="term-dot y" />
        <span className="term-dot g" />
        <span className="term-title">opencorp — agent activity (hash-chained ledger)</span>
        <span className="badge">
          {API_URL ? (connected ? "live" : "connecting…") : "demo replay"}
        </span>
      </div>
      <div
        className="term-body"
        ref={bodyRef}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {events.length === 0 && <div className="tl"><span className="tl-body dim">no events yet — run a heartbeat</span></div>}
        {events.map((e) =>
          renderLines(e).map((line, i) => (
            <div className="tl" key={`${e.seq}:${i}`}>
              <span className="tl-time">{i === 0 ? hhmmss(e.createdAt) : ""}</span>
              <span className={`tl-actor ${i === 0 ? actorClass(e.actor) : ""}`}>
                {i === 0 ? shortActor(e.actor) : ""}
              </span>
              <span className={`tl-body ${line.cls ?? ""}`}>{line.text}</span>
            </div>
          )),
        )}
      </div>
    </div>
  );
}
