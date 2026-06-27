import type { InsightsReport } from "./types";

/** cents → "12.34€" */
export function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)}€`;
}

/** fraction → "0.97%" (null → "n/a") */
function pct(frac: number | null): string {
  return frac == null ? "n/a" : `${(frac * 100).toFixed(2)}%`;
}

function row(label: string, value: string): string {
  return `─ ${label.padEnd(14)}  ${value}`;
}

/**
 * Render the report as a compact terminal block (the human-facing CLI surface).
 * Pure — no colours, no I/O — so it's trivially unit-testable and reusable.
 */
export function renderReport(r: InsightsReport): string {
  const lines: string[] = [];
  lines.push(`${r.company.name} · ${r.rangeDays} derniers jours`);

  const f = r.funnel;
  lines.push(
    row(
      "Funnel",
      `visites ${f.visitors ?? "n/a"} → clics ads ${f.adClicks} → ventes ${f.sales}  (conv. ${pct(f.conversion)})`,
    ),
  );

  const a = r.acquisition;
  const best = a.bestCampaign ? `  (best: "${a.bestCampaign.name}" ${a.bestCampaign.roas}×)` : "";
  lines.push(
    row(
      "Acquisition",
      `dépense ${eur(a.spendCents)} · ROAS ${a.roas == null ? "n/a" : `${a.roas}×`}${best}`,
    ),
  );

  const o = r.ops;
  const fails =
    o.topFailingTools.length === 0
      ? "aucun"
      : o.topFailingTools.map((t) => `${t.server}.${t.tool} ×${t.count}`).join(", ");
  lines.push(row("Ops", `tâches ${o.tasksDone} ✓ / ${o.tasksFailed} ✗   échecs: ${fails}`));
  if (o.rateLimitedCount > 0) {
    lines.push(row("", `⚠ ${o.rateLimitedCount} appels rate-limités`));
  }
  if (o.pendingApprovals.length > 0) {
    const tools = o.pendingApprovals.map((p) => `${p.tool}${p.count > 1 ? ` ×${p.count}` : ""}`).join(", ");
    lines.push(row("", `⚠ ${o.pendingApprovals.reduce((n, p) => n + p.count, 0)} approbations en attente (${tools})`));
  }

  const m = r.money;
  const runway = m.runwayDays == null ? "n/a" : `~${m.runwayDays}j`;
  lines.push(
    row(
      "Argent",
      `revenu ${eur(m.revenueGrossCents)} · burn ${eur(m.creditBurnCents)} crédits · balance ${eur(m.creditBalanceCents)} · runway ${runway}`,
    ),
  );

  if (r.activity.length > 0) {
    lines.push(row("Activité", r.activity.slice(0, 3).map((x) => x.summary).join(" · ")));
  }

  return lines.join("\n");
}
