import { describe, expect, test } from "bun:test";
import { drainSources, planReinvestment } from "../src/reinvest";

const opts = { minCents: 160, targetCents: 1000, capCents: 2000 };

describe("planReinvestment (self-financing decision)", () => {
  test("no-op when the wallet is healthy (at or above the trigger)", () => {
    expect(planReinvestment({ creditBalance: 160, availableRevenue: 5000, ...opts })).toBe(0);
    expect(planReinvestment({ creditBalance: 900, availableRevenue: 5000, ...opts })).toBe(0);
  });

  test("no-op when low but no revenue to draw on", () => {
    expect(planReinvestment({ creditBalance: 0, availableRevenue: 0, ...opts })).toBe(0);
  });

  test("refills up to the target when low and revenue is ample", () => {
    // need = 1000 - 50 = 950, well under cap and revenue → move 950
    expect(planReinvestment({ creditBalance: 50, availableRevenue: 5000, ...opts })).toBe(950);
  });

  test("bounded by available revenue when revenue is the scarce side", () => {
    // need = 1000, revenue only 300 → move 300
    expect(planReinvestment({ creditBalance: 0, availableRevenue: 300, ...opts })).toBe(300);
  });

  test("bounded by the per-cycle cap", () => {
    // need = 5000 (target 6000 - 1000 bal... use a high target via opts) capped at 2000
    expect(
      planReinvestment({ creditBalance: 0, availableRevenue: 99999, minCents: 160, targetCents: 6000, capCents: 2000 }),
    ).toBe(2000);
  });

  test("a profitable company keeps the surplus above target (never 100%)", () => {
    // huge revenue, low credits → still only pulls the refill need, not everything
    const moved = planReinvestment({ creditBalance: 100, availableRevenue: 1_000_000, ...opts });
    expect(moved).toBe(900); // 1000 - 100; the rest stays withdrawable
  });
});

describe("drainSources (per-company split)", () => {
  test("pulls it all from a single company that can cover it", () => {
    expect(drainSources(300, [{ id: "a", balanceCents: 1000 }])).toEqual([
      { companyId: "a", cents: 300 },
    ]);
  });

  test("takes a company whole, then a partial slice of the next (largest-first)", () => {
    // 700 needed: drain a (500) fully, take 200 of b — c is never touched.
    expect(
      drainSources(700, [
        { id: "a", balanceCents: 500 },
        { id: "b", balanceCents: 400 },
        { id: "c", balanceCents: 300 },
      ]),
    ).toEqual([
      { companyId: "a", cents: 500 },
      { companyId: "b", cents: 200 },
    ]);
  });

  test("bounded by total revenue — drains everyone and stops, no over-pull", () => {
    const sources = drainSources(5000, [
      { id: "a", balanceCents: 300 },
      { id: "b", balanceCents: 200 },
    ]);
    expect(sources).toEqual([
      { companyId: "a", cents: 300 },
      { companyId: "b", cents: 200 },
    ]);
    expect(sources.reduce((s, x) => s + x.cents, 0)).toBe(500);
  });

  test("skips zero-balance companies", () => {
    expect(
      drainSources(150, [
        { id: "a", balanceCents: 0 },
        { id: "b", balanceCents: 200 },
      ]),
    ).toEqual([{ companyId: "b", cents: 150 }]);
  });

  test("nothing to do when the amount is zero", () => {
    expect(drainSources(0, [{ id: "a", balanceCents: 1000 }])).toEqual([]);
  });
});
