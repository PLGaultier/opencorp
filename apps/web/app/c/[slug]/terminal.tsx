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

/** Compact bracketed tag, ops-floor style: [CEO ] [DEPT] [WRKR] [USER]. */
function shortActor(actor: string): string {
  if (actor === "ceo") return "[CEO ]";
  if (actor.startsWith("dept:")) return "[DEPT]";
  if (actor.startsWith("worker:")) return "[WRKR]";
  if (actor === "user") return "[USER]";
  return "[SYS ]";
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

/** Optimistic order/reply lines shown until the ledger echoes them back. */
interface LocalLine {
  id: number;
  role: "owner" | "ceo";
  text: string;
  at: string;
}

export function CompanyTerminal({
  companyId,
  initialEvents,
  canOrder = false,
}: {
  companyId: string | null;
  initialEvents: TerminalEvent[];
  /** Owner only: dock the CEO command line inside the terminal. */
  canOrder?: boolean;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [connected, setConnected] = useState(false);
  const [local, setLocal] = useState<LocalLine[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const localId = useRef(0);

  // live tail: per-company SSE with enriched frames
  useEffect(() => {
    if (!API_URL || !companyId) return;
    const es = new EventSource(`${API_URL}/api/live?company=${companyId}`);
    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("ledger", (ev) => {
      try {
        const e = JSON.parse((ev as MessageEvent).data) as TerminalEvent;
        if (typeof e.seq !== "number" || !e.eventType) return;
        // the ledger echoes chat back as a ceo_chat event — drop our optimistic copy
        if (e.eventType === "ceo_chat") {
          const d = p(e);
          setLocal((ls) => ls.filter((l) => l.text !== d.message && l.text !== d.reply));
        }
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
  }, [events, local]);

  // give the CEO an order from the terminal's own prompt (§5.2 chat)
  const sendOrder = async () => {
    const message = draft.trim();
    if (!message || sending || !API_URL || !companyId) return;
    setDraft("");
    pinnedRef.current = true;
    const now = new Date().toISOString();
    setLocal((ls) => [...ls, { id: ++localId.current, role: "owner", text: message, at: now }]);
    setSending(true);
    try {
      const res = await fetch(`${API_URL}/companies/${companyId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.status === 401 || res.status === 403) {
        setNeedsAuth(true);
        return;
      }
      const d = (await res.json()) as { reply?: string; createdTasks?: string[]; error?: string };
      const reply = d.reply ?? `error: ${d.error ?? "chat failed"}`;
      const queued = d.createdTasks?.length ? `\n[queued: ${d.createdTasks.join(" · ")}]` : "";
      setLocal((ls) => [
        ...ls,
        { id: ++localId.current, role: "ceo", text: reply + queued, at: new Date().toISOString() },
      ]);
    } catch {
      setLocal((ls) => [
        ...ls,
        { id: ++localId.current, role: "ceo", text: "error: API unreachable", at: new Date().toISOString() },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="terminal">
      <div className="term-head">
        <span className={`term-live ${connected ? "on" : ""}`} />
        <span className="term-title">Company floor — live agent activity</span>
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
        {events.length === 0 && local.length === 0 && (
          <div className="tl"><span className="tl-body dim">no events yet — run a heartbeat</span></div>
        )}
        {events.map((e) =>
          renderLines(e).map((line, i) => (
            <div className="tl" key={`${e.seq}:${i}`}>
              <span className="tl-time">{i === 0 ? hhmmss(e.createdAt) : ""}</span>
              <span className={`tl-actor ${i === 0 ? actorClass(e.actor) : ""}`} title={i === 0 ? e.actor : undefined}>
                {i === 0 ? shortActor(e.actor) : ""}
              </span>
              <span className={`tl-body ${line.cls ?? ""}`}>{line.text}</span>
            </div>
          )),
        )}
        {/* optimistic order/reply lines, until the ledger echoes them */}
        {local.map((l) => (
          <div className="tl" key={`local:${l.id}`}>
            <span className="tl-time">{hhmmss(l.at)}</span>
            <span className={`tl-actor ${l.role === "owner" ? "a-user" : "a-ceo"}`}>
              {l.role === "owner" ? "[USER]" : "[CEO ]"}
            </span>
            <span className="tl-body">{l.text}</span>
          </div>
        ))}
        {sending && (
          <div className="tl">
            <span className="tl-time" />
            <span className="tl-actor a-ceo">[CEO ]</span>
            <span className="tl-body dim">thinking…</span>
          </div>
        )}
      </div>

      {canOrder && (
        <div className="term-input">
          {needsAuth ? (
            <span className="term-note">
              orders are limited to members — <a href="/login">sign in</a>
            </span>
          ) : (
            <>
              <span className="prompt">▸</span>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendOrder()}
                placeholder={API_URL ? "give the CEO an order… (it can queue tasks, never pause itself)" : "demo replay — connect an API to give orders"}
                disabled={sending || !API_URL}
                aria-label="Give the CEO an order"
              />
              <button onClick={sendOrder} disabled={sending || !draft.trim() || !API_URL}>
                {sending ? "…" : "⏎ send"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
