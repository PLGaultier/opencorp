import { describe, expect, test } from "bun:test";
import { buildPnlSeries } from "../src/pnl";

describe("buildPnlSeries (§9.4 HUD sparkline)", () => {
  test("accumulates revenue minus spend per day on top of the baseline", () => {
    const series = buildPnlSeries(100, [
      { day: "2026-07-01", revenueCents: 0, spendCents: 40 },
      { day: "2026-07-02", revenueCents: 2900, spendCents: 0 },
      { day: "2026-07-03", revenueCents: 0, spendCents: 0 },
    ]);
    expect(series).toEqual([
      { day: "2026-07-01", pnlCents: 60 },
      { day: "2026-07-02", pnlCents: 2960 },
      { day: "2026-07-03", pnlCents: 2960 },
    ]);
  });

  test("empty window yields an empty series", () => {
    expect(buildPnlSeries(500, [])).toEqual([]);
  });

  test("negative days can pull the cumulative P&L below zero", () => {
    const series = buildPnlSeries(0, [
      { day: "2026-07-01", revenueCents: 0, spendCents: 90 },
      { day: "2026-07-02", revenueCents: 30, spendCents: 0 },
    ]);
    expect(series.map((p) => p.pnlCents)).toEqual([-90, -60]);
  });
});
