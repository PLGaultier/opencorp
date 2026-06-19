"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { API_URL, type ModelLevel } from "@/lib/data";
import { LEVELS, levelMeta } from "@/lib/levels";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;

/**
 * The "Engine" widget (§10): runway + the playful CEO "brains" picker. Choosing
 * a smarter level swaps the model bundle behind every agent call — pricier and
 * more capable — and the per-task estimate / runway update to match.
 */
export function EnginePanel({
  companyId,
  initialLevel,
  balanceCents,
  dailyTaskCap,
  paused,
}: {
  companyId: string;
  initialLevel: ModelLevel;
  balanceCents: number;
  dailyTaskCap: number;
  paused: boolean;
}) {
  const router = useRouter();
  const [level, setLevel] = useState<ModelLevel>(initialLevel);
  const [saving, setSaving] = useState<ModelLevel | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  const meta = levelMeta(level);
  const perTask = meta.perTaskCents;
  const burnPerDay = perTask * Math.max(1, dailyTaskCap);
  const runwayDays = burnPerDay > 0 ? balanceCents / burnPerDay : 0;
  const outOfCredits = balanceCents <= 0;

  const choose = async (next: ModelLevel) => {
    if (next === level || saving) return;
    const prev = level;
    setLevel(next); // optimistic — the dial should feel instant
    if (!API_URL) return; // demo: visual only
    setSaving(next);
    try {
      const res = await fetch(`${API_URL}/companies/${companyId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelLevel: next }),
      });
      if (res.status === 401 || res.status === 403) {
        setNeedsAuth(true);
        setLevel(prev);
      } else if (!res.ok) {
        setLevel(prev);
      } else {
        router.refresh();
      }
    } catch {
      setLevel(prev);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="engine">
      <div className="engine-head">
        <span className="engine-title">Engine</span>
        <Link href="/credits" className="engine-buy">Buy credits →</Link>
      </div>

      <div className="runway">
        <span className="sub">Runway</span>
        <b>{paused ? "Paused" : outOfCredits ? "—" : `≈ ${runwayDays < 1 ? "<1" : Math.round(runwayDays)} day${Math.round(runwayDays) === 1 ? "" : "s"}`}</b>
        <span className="sub">· {eur(perTask)}/task</span>
      </div>
      {outOfCredits && (
        <p className="engine-warn">Out of credits — company paused. Top up to keep the CEO running.</p>
      )}

      <div className="engine-label">Brains</div>
      <div className="level-dial">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            className={`level-card ${level === l.id ? "on" : ""}`}
            onClick={() => choose(l.id)}
            disabled={saving !== null}
            title={`${l.model} · ≈${l.costMult}× cost`}
          >
            <span className="level-name">{l.name}</span>
            <span className="level-mult">{l.model}</span>
          </button>
        ))}
      </div>
      <p className="sub engine-tag">{meta.tagline}</p>
      {needsAuth && (
        <p className="sub">
          Tuning the engine is limited to members —{" "}
          <a href="/login" style={{ textDecoration: "underline" }}>sign in</a>.
        </p>
      )}

      <p className="sub engine-note">
        Autonomy · CEO checks in daily, up to {dailyTaskCap} tasks/day (a cap, not a target).
      </p>
    </div>
  );
}
