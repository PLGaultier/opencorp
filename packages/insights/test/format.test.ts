import { describe, expect, test } from "bun:test";
import { renderReport, eur } from "../src/format";
import { summarizeEvent } from "../src/report";
import type { InsightsReport } from "../src/types";

const base: InsightsReport = {
  company: { id: "c1", slug: "acme", name: "ACME" },
  rangeDays: 7,
  generatedAt: "2026-06-27T00:00:00.000Z",
  money: {
    revenueGrossCents: 22800,
    revenueNetCents: 22000,
    salesCount: 12,
    creditBurnCents: 1100,
    creditBalanceCents: 54000,
    realBalanceCents: 22000,
    runwayDays: 34,
  },
  acquisition: {
    spendCents: 4000,
    impressions: 5000,
    clicks: 86,
    attributedRevenueCents: 22800,
    roas: 5.7,
    bestCampaign: { name: "summer-sale", roas: 8.1 },
  },
  funnel: { visitors: 1240, adClicks: 86, sales: 12, conversion: 12 / 1240 },
  ops: {
    tasksDone: 31,
    tasksFailed: 4,
    topFailingTools: [{ server: "browser", tool: "submit_form", count: 3 }],
    rateLimitedCount: 0,
    pendingApprovals: [{ server: "ads", tool: "launch_campaign", count: 2 }],
  },
  activity: [{ type: "money_in", at: "2026-06-27T00:00:00.000Z", summary: "sale +19.00€" }],
};

describe("renderReport", () => {
  test("renders the funnel, ROAS, ops failures, blockers and money", () => {
    const out = renderReport(base);
    expect(out).toContain("ACME · 7 derniers jours");
    expect(out).toContain("visites 1240 → clics ads 86 → ventes 12");
    expect(out).toContain("ROAS 5.7×");
    expect(out).toContain('best: "summer-sale" 8.1×');
    expect(out).toContain("browser.submit_form ×3");
    expect(out).toContain("approbations en attente (launch_campaign ×2)");
    expect(out).toContain("runway ~34j");
  });

  test("degrades gracefully when analytics + ads are absent", () => {
    const bare = {
      ...base,
      funnel: { visitors: null, adClicks: 0, sales: 0, conversion: null },
      acquisition: { ...base.acquisition, spendCents: 0, roas: null, bestCampaign: null },
      ops: { ...base.ops, topFailingTools: [], pendingApprovals: [], rateLimitedCount: 0 },
      money: { ...base.money, creditBurnCents: 0, runwayDays: null },
    };
    const out = renderReport(bare);
    expect(out).toContain("visites n/a");
    expect(out).toContain("conv. n/a");
    expect(out).toContain("ROAS n/a");
    expect(out).toContain("échecs: aucun");
    expect(out).toContain("runway n/a");
  });
});

describe("eur / summarizeEvent", () => {
  test("formats cents", () => {
    expect(eur(22800)).toBe("228.00€");
  });
  test("glosses ledger events", () => {
    expect(summarizeEvent("deploy", { kind: "site", url: "http://acme.localhost" })).toContain("deployed site");
    expect(summarizeEvent("money_in", { amountCents: 1900 })).toBe("sale +19.00€");
    expect(summarizeEvent("product_created", { name: "Pro", priceCents: 4900 })).toContain('"Pro" @ 49.00€');
  });
});
