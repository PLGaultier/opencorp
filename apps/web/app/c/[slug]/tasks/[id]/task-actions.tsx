"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL, type TaskDetail } from "@/lib/data";

/**
 * Owner task controls: edit (title/description/priority/status), run now,
 * delete. Mirrors the server rules — running/done tasks are read-only.
 */
export function TaskActions({ slug, task }: { slug: string; task: TaskDetail }) {
  const router = useRouter();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState(task.priority);
  const [status, setStatus] = useState(task.status);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  const locked = task.status === "running" || task.status === "done";

  if (!API_URL) {
    return (
      <p className="sub">
        Demo preview — task actions (edit / run / delete) are available when the dashboard is
        connected to an API.
      </p>
    );
  }

  if (needsAuth) {
    return (
      <p className="sub">
        Task actions are limited to conglomerate members —{" "}
        <a href="/login" style={{ textDecoration: "underline" }}>
          sign in
        </a>
        .
      </p>
    );
  }

  if (locked) {
    return <p className="sub">Task is {task.status} — read-only.</p>;
  }

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch(`${API_URL}/tasks/${task.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) {
      setNeedsAuth(true);
      return null;
    }
    if (!res.ok) {
      const d = (await res.json()) as { error?: string; detail?: string };
      setError(d.detail ?? d.error ?? "update failed");
      return null;
    }
    return res.json();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const ok = await patch({ title: title.trim(), description, priority, status });
      if (ok) {
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("API unreachable");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (running) return;
    setError(null);
    setRunning(true);
    try {
      const res = await fetch(`${API_URL}/tasks/${task.id}/run`, {
        method: "POST",
        credentials: "include",
      });
      if (res.status === 401 || res.status === 403) {
        setNeedsAuth(true);
      } else if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setError(d.error ?? "run failed");
      } else {
        router.refresh();
      }
    } catch {
      // long-running: the company terminal is the source of truth
      router.refresh();
    } finally {
      setRunning(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this task?")) return;
    setError(null);
    setBusy(true);
    try {
      const ok = await patch({ status: "deleted" });
      if (ok) {
        router.push(`/c/${slug}`);
        router.refresh();
      }
    } catch {
      setError("API unreachable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="auth-form" style={{ maxWidth: "36rem" }}>
      <label className="field">
        <span className="sub">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      </label>
      <label className="field">
        <span className="sub">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={5000}
        />
      </label>
      <label className="field">
        <span className="sub">Priority (higher runs first)</span>
        <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
      </label>
      <label className="field">
        <span className="sub">Status</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as TaskDetail["status"])}
        >
          <option value="pending">pending — waits for the CEO to queue it</option>
          <option value="queued">queued — eligible for dispatch</option>
        </select>
      </label>

      {error && <p className="auth-error">{error}</p>}
      <div className="controls-row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "…" : "Save"}
        </button>
        <button className="btn" type="button" onClick={runNow} disabled={running}>
          {running ? "running… (watch the company terminal)" : "▶ Run now"}
        </button>
        <button className="btn" type="button" onClick={remove} disabled={busy}>
          Delete
        </button>
        {saved && <span className="saved">saved ✓</span>}
      </div>
      <span className="sub">
        Run now bypasses the daily cap; progress streams into the company terminal.
      </span>
    </form>
  );
}
