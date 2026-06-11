"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "@/lib/data";

/**
 * Owner controls (§5.2 — dashboard actions, never LLM tools): run a heartbeat
 * now, pause/resume the company (status + Temporal schedule), see the next
 * scheduled run, and chat with the CEO. Results stream into the terminal
 * below via the live ledger; the chat reply is also shown inline.
 */

interface ScheduleInfo {
  paused: boolean;
  nextRun: string | null;
  recentRuns: number;
}

export function CompanyControls({
  companyId,
  initialStatus,
}: {
  companyId: string;
  initialStatus: "active" | "paused";
}) {
  const [status, setStatus] = useState(initialStatus);
  const [schedule, setSchedule] = useState<ScheduleInfo | null | "none">(null);
  const [hbRunning, setHbRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState<{ role: "owner" | "ceo"; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);

  // owner actions require a session (cookie on the API origin)
  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${API_URL}/companies/${companyId}${path}`, {
        ...init,
        credentials: "include",
      });
      if (res.status === 401 || res.status === 403) setNeedsAuth(true);
      return res;
    },
    [companyId],
  );

  const loadSchedule = useCallback(async () => {
    if (!API_URL) return;
    try {
      const res = await api("/schedule");
      setSchedule(res.ok ? ((await res.json()) as ScheduleInfo) : "none");
    } catch {
      setSchedule("none");
    }
  }, [api]);

  useEffect(() => void loadSchedule(), [loadSchedule]);

  const runHeartbeat = async () => {
    setHbRunning(true);
    try {
      // long-running: the workflow executes synchronously; progress streams
      // into the terminal regardless of whether this response survives proxies
      await api("/heartbeat", { method: "POST" });
    } catch {
      /* the terminal is the source of truth */
    } finally {
      setHbRunning(false);
      void loadSchedule();
    }
  };

  const setPaused = async (pause: boolean) => {
    setBusy(true);
    try {
      const res = await api(pause ? "/pause" : "/resume", { method: "POST" });
      if (res.ok) setStatus(pause ? "paused" : "active");
      void loadSchedule();
    } finally {
      setBusy(false);
    }
  };

  const createSchedule = async () => {
    setBusy(true);
    try {
      await api("/schedule", { method: "POST" });
      void loadSchedule();
    } finally {
      setBusy(false);
    }
  };

  const sendChat = async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setDraft("");
    setChat((c) => [...c, { role: "owner", text: message }]);
    setSending(true);
    try {
      const res = await api("/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const d = (await res.json()) as { reply?: string; createdTasks?: string[]; error?: string };
      const reply = d.reply ?? `error: ${d.error ?? "chat failed"}`;
      const queued = d.createdTasks?.length ? `\n[queued: ${d.createdTasks.join(" · ")}]` : "";
      setChat((c) => [...c, { role: "ceo", text: reply + queued }]);
    } catch {
      setChat((c) => [...c, { role: "ceo", text: "error: API unreachable" }]);
    } finally {
      setSending(false);
    }
  };

  if (!API_URL) {
    return (
      <div className="controls">
        <span className="sub" style={{ margin: 0 }}>
          Owner controls (run / pause / chat) are available when the dashboard is connected to an API.
        </span>
      </div>
    );
  }

  if (needsAuth) {
    return (
      <div className="controls">
        <span className="sub" style={{ margin: 0 }}>
          Owner controls are limited to this company&apos;s conglomerate members —{" "}
          <a href="/login" style={{ textDecoration: "underline" }}>
            sign in
          </a>
          . The ledger and live feed below stay public.
        </span>
      </div>
    );
  }

  return (
    <div className="controls">
      <div className="controls-row">
        <button className="btn primary" onClick={runHeartbeat} disabled={hbRunning || status === "paused"}>
          {hbRunning ? "Heartbeat running…" : "▶ Run heartbeat"}
        </button>
        {status === "active" ? (
          <button className="btn" onClick={() => setPaused(true)} disabled={busy}>
            ⏸ Pause company
          </button>
        ) : (
          <button className="btn" onClick={() => setPaused(false)} disabled={busy}>
            ▶ Resume company
          </button>
        )}
        <span className="sched">
          {schedule === null && "schedule: …"}
          {schedule === "none" && (
            <>
              no daily schedule —{" "}
              <button className="btn link" onClick={createSchedule} disabled={busy}>
                schedule daily heartbeat
              </button>
            </>
          )}
          {schedule !== null && schedule !== "none" && (
            <>
              {schedule.paused ? "schedule paused" : `next run: ${schedule.nextRun ? new Date(schedule.nextRun).toLocaleString() : "—"}`}
              {` · ${schedule.recentRuns} recent run(s)`}
            </>
          )}
        </span>
      </div>

      <div className="chat">
        {chat.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <span className="chat-role">{m.role}</span>
            <span>{m.text}</span>
          </div>
        ))}
        <div className="chat-input">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendChat()}
            placeholder='Message the CEO… (it can queue tasks, never pause itself or change caps)'
            disabled={sending}
          />
          <button className="btn primary" onClick={sendChat} disabled={sending || !draft.trim()}>
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
