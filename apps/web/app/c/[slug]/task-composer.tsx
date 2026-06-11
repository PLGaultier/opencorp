"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "@/lib/data";

/** Owner task creation — queues a task the same way org.create_task does. */
export function TaskComposer({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  if (!API_URL) return null;

  if (needsAuth) {
    return (
      <p className="sub">
        Creating tasks is limited to conglomerate members —{" "}
        <a href="/login" style={{ textDecoration: "underline" }}>
          sign in
        </a>
        .
      </p>
    );
  }

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)} style={{ marginTop: "0.5rem" }}>
        ＋ New task
      </button>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/companies/${companyId}/tasks`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description, priority }),
      });
      if (res.status === 401 || res.status === 403) {
        setNeedsAuth(true);
      } else if (!res.ok) {
        const d = (await res.json()) as { error?: string; detail?: string };
        setError(d.detail ?? d.error ?? "task creation failed");
      } else {
        setTitle("");
        setDescription("");
        setPriority(0);
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError("API unreachable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="auth-form" style={{ marginTop: "0.5rem", maxWidth: "36rem" }}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        required
        maxLength={200}
        autoFocus
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={3}
        maxLength={5000}
      />
      <label className="field">
        <span className="sub">Priority (higher runs first)</span>
        <input
          type="number"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        />
      </label>
      {error && <p className="auth-error">{error}</p>}
      <div className="controls-row">
        <button className="btn primary" type="submit" disabled={busy || !title.trim()}>
          {busy ? "…" : "Queue task"}
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
