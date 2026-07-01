"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { API_URL, type ModelBundle, type ModelLevel } from "@/lib/data";
import { LEVELS, levelMeta, modelLabel } from "@/lib/levels";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;

/** Provider bundles (OPE-6): Claude vs the cheaper z.ai GLM family. */
const BUNDLES: { id: ModelBundle; name: string; tag: string }[] = [
  { id: "anthropic", name: "Claude", tag: "Anthropic — Haiku · Sonnet · Opus" },
  { id: "glm", name: "GLM", tag: "z.ai — cheaper, lifts margin" },
];

/**
 * The "Engine" widget (§10): runway + the playful CEO "brains" picker. Choosing
 * a smarter level swaps the model bundle behind every agent call — pricier and
 * more capable — and the per-task estimate / runway update to match.
 */
export function EnginePanel({
  companyId,
  initialLevel,
  initialBundle,
  balanceCents,
  dailyTaskCap,
  paused,
}: {
  companyId: string;
  initialLevel: ModelLevel;
  initialBundle: ModelBundle;
  balanceCents: number;
  dailyTaskCap: number;
  paused: boolean;
}) {
  const router = useRouter();
  const [level, setLevel] = useState<ModelLevel>(initialLevel);
  const [saving, setSaving] = useState<ModelLevel | null>(null);
  const [bundle, setBundle] = useState<ModelBundle>(initialBundle);
  const [savingBundle, setSavingBundle] = useState(false);
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

  const chooseBundle = async (next: ModelBundle) => {
    if (next === bundle || savingBundle) return;
    const prev = bundle;
    setBundle(next); // optimistic
    if (!API_URL) return; // demo: visual only
    setSavingBundle(true);
    try {
      const res = await fetch(`${API_URL}/companies/${companyId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelBundle: next }),
      });
      if (res.status === 401 || res.status === 403) {
        setNeedsAuth(true);
        setBundle(prev);
      } else if (!res.ok) {
        setBundle(prev);
      } else {
        router.refresh();
      }
    } catch {
      setBundle(prev);
    } finally {
      setSavingBundle(false);
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
            title={`${modelLabel(l, bundle)} · ≈${l.costMult}× cost`}
          >
            <span className="level-name">{l.name}</span>
            <span className="level-mult">{modelLabel(l, bundle)}</span>
          </button>
        ))}
      </div>
      <p className="sub engine-tag">{meta.tagline}</p>

      <div className="engine-label">Provider</div>
      <div className="level-dial">
        {BUNDLES.map((b) => (
          <button
            key={b.id}
            className={`level-card ${bundle === b.id ? "on" : ""}`}
            onClick={() => chooseBundle(b.id)}
            disabled={savingBundle}
            title={b.tag}
          >
            <span className="level-name">{b.name}</span>
            <span className="level-mult">{b.id === "glm" ? "z.ai" : "Anthropic"}</span>
          </button>
        ))}
      </div>
      <p className="sub engine-tag">{BUNDLES.find((b) => b.id === bundle)?.tag}</p>

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
