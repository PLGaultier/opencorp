"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelBundle, ModelLevel } from "@/lib/data";
import { EnginePanel } from "./engine-panel";

/**
 * The pause menu — a game-style overlay opened from the HUD's ⚙ TUNE button.
 * Holds the Engine (brains/provider/runway) and the link to the full settings
 * page. Run/pause + heartbeat live in the always-visible deck next to the
 * terminal (CompanyControls), not here.
 */
export function TuneMenu({
  companyId,
  slug,
  initialLevel,
  initialBundle,
  balanceCents,
  dailyTaskCap,
  paused,
}: {
  companyId: string;
  slug: string;
  initialLevel: ModelLevel;
  initialBundle: ModelBundle;
  balanceCents: number;
  dailyTaskCap: number;
  paused: boolean;
}) {
  const [open, setOpen] = useState(false);

  // pause-menu convention: Escape closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)} aria-haspopup="dialog">
        ⚙ Tune
      </button>

      {/* portal: the HUD's clip-path would otherwise trap position:fixed */}
      {open &&
        createPortal(
        <div className="tune-backdrop" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="tune-panel" role="dialog" aria-modal="true" aria-label="Tune company">
            <div className="tune-head">
              <span className="tune-title">⚙ Tune company</span>
              <button className="btn" onClick={() => setOpen(false)}>
                ✕ Close
              </button>
            </div>

            <EnginePanel
              companyId={companyId}
              initialLevel={initialLevel}
              initialBundle={initialBundle}
              balanceCents={balanceCents}
              dailyTaskCap={dailyTaskCap}
              paused={paused}
            />

            <p className="sub tune-foot">
              Name, mission &amp; visibility live in{" "}
              <Link href={`/c/${slug}/settings`} style={{ textDecoration: "underline" }}>
                full settings →
              </Link>
            </p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
