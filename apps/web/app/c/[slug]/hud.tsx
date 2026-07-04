import Link from "next/link";
import { Coin, Heart, Mascot } from "../../sprites";

/**
 * Game HUD strip: mascot + name, HP hearts (= runway), gold (= P&L) with a
 * pixel sparkline. Replaces the old wall of € stats — the full breakdown
 * lives in the STATS menu tab. Display-only: everything is derived from data
 * the page already fetches.
 */

/** Runway days → 0–4 hearts. */
export function heartsForRunway(runwayDays: number, outOfCredits: boolean): number {
  if (outOfCredits) return 0;
  if (runwayDays >= 14) return 4;
  if (runwayDays >= 7) return 3;
  if (runwayDays >= 3) return 2;
  return 1;
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 56;
  const h = 14;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const poly = points
    .map((v, i) => `${Math.round(i * step)},${Math.round(h - 2 - ((v - min) / span) * (h - 4)) + 1}`)
    .join(" ");
  return (
    <svg className="sprite" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden shapeRendering="crispEdges">
      <polyline points={poly} fill="none" stroke="#767061" strokeWidth={2} />
    </svg>
  );
}

export function CompanyHud({
  slug,
  name,
  mission,
  paused,
  hearts,
  runwayLabel,
  pnlCents,
  spark,
  owner,
}: {
  slug: string;
  name: string;
  mission: string;
  paused: boolean;
  hearts: number;
  runwayLabel: string;
  pnlCents: number;
  spark: number[];
  owner: boolean;
}) {
  const pnl = pnlCents / 100;
  return (
    <header className="hud">
      <div className="hud-id">
        <Mascot slug={slug} size={40} paused={paused} />
        <div>
          <div className="hud-name">
            {name} <span className={`hud-status ${paused ? "paused" : "active"}`}>{paused ? "paused" : "active"}</span>
          </div>
          <p className="hud-mission" title={mission}>{mission}</p>
        </div>
      </div>

      <div className="hud-sep" aria-hidden />

      <div className="hud-stat" title={`Runway ${runwayLabel}`}>
        <span className="hud-label">HP · runway</span>
        <div className="hud-hearts">
          {[0, 1, 2, 3].map((i) => (
            <Heart key={i} filled={i < hearts} size={15} />
          ))}
          <span className="hint">{runwayLabel}</span>
        </div>
      </div>

      <div className="hud-sep" aria-hidden />

      <div className="hud-stat" title="P&L — real revenue minus real spend">
        <span className="hud-label">Gold · P&L</span>
        <div className="hud-gold">
          <Coin size={15} />
          <b className={pnl > 0 ? "pos" : pnl < 0 ? "neg" : ""}>
            {pnl > 0 ? "+" : ""}
            {pnl.toFixed(2)} €
          </b>
          <Sparkline points={spark} />
        </div>
      </div>

      {owner && (
        <div className="hud-links">
          <Link href={`/c/${slug}/insights`}>Insights</Link>
          <Link href={`/c/${slug}/settings`}>Settings</Link>
        </div>
      )}
    </header>
  );
}
