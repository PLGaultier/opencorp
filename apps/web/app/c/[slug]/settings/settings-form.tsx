"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "@/lib/data";

interface Settings {
  name: string;
  mission: string;
  dailyTaskCap: number;
  autonomyLevel: "supervised" | "bounded" | "full";
  isPublic: boolean;
}

export function SettingsForm({ companyId, initial }: { companyId: string; initial: Settings }) {
  const router = useRouter();
  const [form, setForm] = useState<Settings>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/companies/${companyId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.status === 401 || res.status === 403) {
        setNeedsAuth(true);
      } else if (!res.ok) {
        const d = (await res.json()) as { error?: string; detail?: string };
        setError(d.detail ?? d.error ?? "save failed");
      } else {
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("API unreachable");
    } finally {
      setBusy(false);
    }
  };

  if (!API_URL) {
    return (
      <p className="sub">
        Demo preview — settings are editable when the dashboard is connected to an API.
      </p>
    );
  }

  if (needsAuth) {
    return (
      <p className="sub">
        Settings are limited to this company&apos;s conglomerate members —{" "}
        <a href="/login" style={{ textDecoration: "underline" }}>
          sign in
        </a>
        .
      </p>
    );
  }

  return (
    <form onSubmit={save} className="auth-form" style={{ maxWidth: "36rem" }}>
      <label className="field">
        <span className="sub">Name</span>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
          maxLength={120}
        />
      </label>

      <label className="field">
        <span className="sub">Mission</span>
        <textarea
          value={form.mission}
          onChange={(e) => setForm({ ...form, mission: e.target.value })}
          required
          minLength={10}
          maxLength={2000}
          rows={4}
        />
      </label>

      <label className="field">
        <span className="sub">Daily task cap (1–50 autonomous tasks per heartbeat day)</span>
        <input
          type="number"
          min={1}
          max={50}
          value={form.dailyTaskCap}
          onChange={(e) => setForm({ ...form, dailyTaskCap: Number(e.target.value) })}
          required
        />
      </label>

      <label className="field">
        <span className="sub">
          Autonomy level — gated tools (delete product, custom domain, form submission) need
          &quot;full&quot;
        </span>
        <select
          value={form.autonomyLevel}
          onChange={(e) =>
            setForm({ ...form, autonomyLevel: e.target.value as Settings["autonomyLevel"] })
          }
        >
          <option value="supervised">supervised — irreversible actions blocked</option>
          <option value="bounded">bounded — irreversible actions blocked</option>
          <option value="full">full — agents may take irreversible actions</option>
        </select>
      </label>

      <label className="field check">
        <input
          type="checkbox"
          checked={form.isPublic}
          onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
        />
        <span className="sub">
          Public — list this company on the dashboard and expose its ledger. Unchecking hides it
          from all public pages (including this dashboard).
        </span>
      </label>

      {error && <p className="auth-error">{error}</p>}
      <div className="controls-row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "…" : "Save settings"}
        </button>
        {saved && <span className="saved">saved ✓</span>}
      </div>
    </form>
  );
}
