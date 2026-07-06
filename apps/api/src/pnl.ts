/**
 * P&L series for the dashboard HUD sparkline (§9.4): cumulative
 * (revenue − spend) per day, seeded with the company's P&L before the
 * window so the last point equals the all-time P&L shown as "gold".
 * Pure — the route feeds it day buckets straight from SQL.
 */

export interface PnlDayRow {
  day: string; // YYYY-MM-DD
  revenueCents: number;
  spendCents: number;
}

export interface PnlPoint {
  day: string;
  pnlCents: number;
}

export function buildPnlSeries(baselinePnlCents: number, days: PnlDayRow[]): PnlPoint[] {
  let acc = baselinePnlCents;
  return days.map((d) => {
    acc += d.revenueCents - d.spendCents;
    return { day: d.day, pnlCents: acc };
  });
}
