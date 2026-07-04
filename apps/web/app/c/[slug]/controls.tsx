"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "@/lib/data";

/**
 * Owner controls (§5.2 — dashboard actions, never LLM tools): run a heartbeat
 * now, pause/resume the company (status + Temporal schedule), and see the
 * next scheduled run. Results stream into the terminal via the live ledger.
 * The CEO chat lives in CeoChat, docked under the terminal.
 */

interface ScheduleInfo {
  paused: boolean;
  nextRun: string | null;
  recentRuns: number;
}

interface Approval {
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  createdAt: string;
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
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [hbRunning, setHbRunning] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const loadApprovals = useCallback(async () => {
    if (!API_URL) return;
    try {
      const res = await api("/approvals?status=pending");
      if (res.ok) setApprovals(((await res.json()) as { approvals: Approval[] }).approvals);
    } catch {
      /* leave the list as-is */
    }
  }, [api]);

  useEffect(() => void loadSchedule(), [loadSchedule]);
  useEffect(() => void loadApprovals(), [loadApprovals]);

  const resolveApproval = async (id: string, decision: "approve" | "reject") => {
    setResolving(id);
    try {
      await api(`/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      // optimistic: drop it from the pending list (result streams to the terminal)
      setApprovals((list) => list.filter((a) => a.id !== id));
    } finally {
      setResolving(null);
    }
  };

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

  if (!API_URL) {
    return (
      <div className="controls">
        <span className="sub" style={{ margin: 0 }}>
          Owner controls (run / pause / chat) are available when the dashboard is connected to an API.
        </span>
      </div>
    );
  }

  function summarizeArgs(args: Record<string, unknown>): string {
    return Object.entries(args)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v)}`)
      .join(", ");
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

      {approvals.length > 0 && (
        <div className="approvals">
          <div className="sub" style={{ margin: "0 0 .4rem" }}>
            ⚠ {approvals.length} action(s) await your approval (§7.3 — irreversible / money-out)
          </div>
          {approvals.map((a) => (
            <div key={a.id} className="approval-row">
              <code className="approval-tool">
                {a.server}.{a.tool}({summarizeArgs(a.args)})
              </code>
              <div className="controls-row" style={{ marginLeft: "auto", gap: ".4rem" }}>
                <button
                  className="btn primary"
                  onClick={() => resolveApproval(a.id, "approve")}
                  disabled={resolving === a.id}
                >
                  Approve
                </button>
                <button className="btn" onClick={() => resolveApproval(a.id, "reject")} disabled={resolving === a.id}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
