import { describe, expect, test } from "bun:test";
import { adsFor, withinMonthlyCap, monthStartDay, dayString } from "../src/providers/ads";
import { EnvSecretStore } from "../src/secrets";

describe("ad budget cap (§14)", () => {
  test("within cap when month-to-date + new budget fits", () => {
    expect(withinMonthlyCap(3000, 2000, 10_000)).toBe(true); // 5000 <= 10000
  });

  test("over cap when it would exceed", () => {
    expect(withinMonthlyCap(9000, 2000, 10_000)).toBe(false); // 11000 > 10000
  });

  test("exactly at the cap is allowed", () => {
    expect(withinMonthlyCap(8000, 2000, 10_000)).toBe(true);
  });

  test("cap of 0 means ads disabled — never within budget", () => {
    expect(withinMonthlyCap(0, 100, 0)).toBe(false);
  });

  test("month window starts on the 1st (UTC)", () => {
    expect(monthStartDay(new Date("2026-06-17T12:00:00Z"))).toBe("2026-06-01");
  });
});

describe("local ads provider (§14 offline)", () => {
  const secrets = new EnvSecretStore({});

  test("selects local when no Meta token / account is configured", async () => {
    const ads = await adsFor("cg-1", secrets, null);
    expect(ads.kind).toBe("local");
  });

  test("create/launch/pause are no-ops; createCampaign returns a deterministic ref", async () => {
    const ads = await adsFor("cg-1", secrets, null);
    const { providerRef } = await ads.createCampaign({
      campaignId: "camp-1",
      name: "Launch",
      objective: "OUTCOME_SALES",
      budgetCents: 1000,
      budgetType: "daily",
      creative: { headline: "Hi", body: "Buy", linkUrl: "http://x/pay" },
    });
    expect(providerRef).toBe("local:campaign:camp-1");
    await ads.launch(providerRef);
    await ads.pause(providerRef);
  });

  test("insights simulate bounded, reproducible daily spend", async () => {
    const ads = await adsFor("cg-1", secrets, null);
    const q = {
      providerRef: "local:campaign:camp-1",
      budgetCents: 1000,
      budgetType: "daily" as const,
      sinceDay: "2026-06-15",
      throughDay: "2026-06-17",
    };
    const a = await ads.insights(q);
    const b = await ads.insights(q);
    expect(a.length).toBe(3); // 15th, 16th, 17th
    expect(a).toEqual(b); // deterministic across calls (idempotent upsert)
    for (const row of a) {
      // each day spends 80–100% of the daily budget
      expect(row.spendCents).toBeGreaterThanOrEqual(800);
      expect(row.spendCents).toBeLessThanOrEqual(1000);
      expect(row.impressions).toBeGreaterThan(0);
    }
  });

  test("dayString formats UTC YYYY-MM-DD", () => {
    expect(dayString(new Date("2026-06-17T23:30:00Z"))).toBe("2026-06-17");
  });
});
