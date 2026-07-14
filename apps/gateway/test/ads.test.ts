import { afterEach, describe, expect, test } from "bun:test";
import { adsFor, withinMonthlyCap, monthStartDay, dayString, planReallocation, DEFAULT_REALLOCATION, MetaApiError, GRAPH_VERSION } from "../src/providers/ads";
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
    const ads = await adsFor("cg-1", secrets, null, null);
    expect(ads.kind).toBe("local");
  });

  test("create/launch/pause are no-ops; createCampaign returns a deterministic ref", async () => {
    const ads = await adsFor("cg-1", secrets, null, null);
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
    const ads = await adsFor("cg-1", secrets, null, null);
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

describe("ROAS reallocation policy (§14)", () => {
  const ctx = { capCents: 100_00, monthToDateCents: 30_00 }; // plenty of headroom

  test("scales a winner up (ROAS ≥ target) by stepUp", () => {
    const [d] = planReallocation([{ campaignId: "w", budgetCents: 2000, spendCents: 1800, revenueCents: 5400 }], ctx);
    expect(d!.action).toBe("increase"); // ROAS 3.0 ≥ 2
    expect(d!.toBudgetCents).toBe(3000); // 2000 × 1.5
  });

  test("pauses a clear loser (ROAS < killRoas) after enough spend", () => {
    const [d] = planReallocation([{ campaignId: "l", budgetCents: 2000, spendCents: 1800, revenueCents: 0 }], ctx);
    expect(d!.action).toBe("pause"); // ROAS 0 < 0.5
  });

  test("trims a weak campaign (killRoas ≤ ROAS < 1) by stepDown", () => {
    const [d] = planReallocation([{ campaignId: "m", budgetCents: 2000, spendCents: 1000, revenueCents: 700 }], ctx);
    expect(d!.action).toBe("decrease"); // ROAS 0.7
    expect(d!.toBudgetCents).toBe(1000); // 2000 × 0.5
  });

  test("holds when there isn't enough spend to judge", () => {
    const [d] = planReallocation([{ campaignId: "new", budgetCents: 2000, spendCents: 100, revenueCents: 0 }], ctx);
    expect(d!.action).toBe("hold"); // spend < minSpendCents (500)
  });

  test("does not raise budgets once the cap headroom is used up", () => {
    const tight = { capCents: 100_00, monthToDateCents: 95_00 }; // > 90% of cap
    const [d] = planReallocation([{ campaignId: "w", budgetCents: 2000, spendCents: 1800, revenueCents: 5400 }], tight);
    expect(d!.action).toBe("hold"); // winner, but no headroom to scale
  });

  test("holds an on-target campaign (1 ≤ ROAS < target)", () => {
    const [d] = planReallocation([{ campaignId: "ok", budgetCents: 2000, spendCents: 1000, revenueCents: 1500 }], ctx);
    expect(d!.action).toBe("hold"); // ROAS 1.5
    expect(DEFAULT_REALLOCATION.targetRoas).toBe(2);
  });
});

describe("meta ads provider (§14 real client)", () => {
  const META_ENV = {
    OPENCORP_SECRET__META_ACCESS_TOKEN: "tok-123",
  };
  // A fully-configured conglomerate → the real Meta client.
  const metaSecrets = new EnvSecretStore(META_ENV);
  const ACT = "act_555";
  const PAGE = "page_99";

  /** A recorded Graph request (method + parsed body/query) + the canned reply. */
  interface Call {
    method: string;
    path: string;
    form: URLSearchParams;
  }
  let calls: Call[] = [];
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    calls = [];
  });

  /** Stub fetch: record the call, return an id per edge (or canned insights). */
  function stub(reply?: (path: string) => { status?: number; body: unknown }) {
    globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
      const u = new URL(String(url));
      const path = u.pathname.replace(`/${GRAPH_VERSION}/`, "");
      const method = init?.method ?? "GET";
      // POST bodies are URLSearchParams; GET params ride on the query string.
      const form = method === "POST" ? new URLSearchParams(String(init?.body)) : u.searchParams;
      calls.push({ method, path, form });
      if (reply) {
        const r = reply(path);
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
      // Default happy path: an id keyed off the edge.
      const id = path.endsWith("/campaigns") ? "c1"
        : path.endsWith("/adsets") ? "a1"
        : path.endsWith("/adcreatives") ? "cr1"
        : "ad1";
      return new Response(JSON.stringify({ id }), { status: 200 });
    }) as typeof fetch;
  }

  test("selects the mock unless token + ad account + page are ALL present", async () => {
    expect((await adsFor("cg", metaSecrets, null, PAGE)).kind).toBe("local"); // no account
    expect((await adsFor("cg", metaSecrets, ACT, null)).kind).toBe("local"); // no page
    expect((await adsFor("cg", new EnvSecretStore({}), ACT, PAGE)).kind).toBe("local"); // no token
    expect((await adsFor("cg", metaSecrets, ACT, PAGE)).kind).toBe("meta"); // all three
  });

  test("createCampaign builds campaign → adset → creative → ad, all PAUSED", async () => {
    stub();
    const ads = await adsFor("cg", metaSecrets, ACT, PAGE);
    const { providerRef } = await ads.createCampaign({
      campaignId: "our-id",
      name: "Summer",
      objective: "OUTCOME_SALES",
      budgetCents: 1500,
      budgetType: "daily",
      creative: { headline: "Buy now", body: "Great deal", imageUrl: "https://x/i.png", linkUrl: "https://x/pay?c=our-id" },
    });
    // provider_ref packs campaign + ad set ids for later launch/pause/budget.
    expect(providerRef).toBe("meta:c1:a1");
    expect(calls.map((c) => c.path)).toEqual([
      `${ACT}/campaigns`,
      `${ACT}/adsets`,
      `${ACT}/adcreatives`,
      `${ACT}/ads`,
    ]);
    const [campaign, adset, creative, ad] = calls;
    expect(campaign!.form.get("status")).toBe("PAUSED");
    expect(campaign!.form.get("objective")).toBe("OUTCOME_SALES");
    expect(campaign!.form.get("special_ad_categories")).toBe("[]");
    // ad set: budget in cents on the daily key, linked to the campaign, PAUSED.
    expect(adset!.form.get("daily_budget")).toBe("1500");
    expect(adset!.form.get("campaign_id")).toBe("c1");
    expect(adset!.form.get("optimization_goal")).toBe("LINK_CLICKS");
    expect(adset!.form.get("status")).toBe("PAUSED");
    // creative: link ad from our Page, pointing at the checkout URL + image.
    const oss = JSON.parse(creative!.form.get("object_story_spec")!);
    expect(oss.page_id).toBe(PAGE);
    expect(oss.link_data.link).toBe("https://x/pay?c=our-id");
    expect(oss.link_data.name).toBe("Buy now");
    expect(oss.link_data.picture).toBe("https://x/i.png");
    // ad: binds the creative to the ad set, PAUSED.
    expect(ad!.form.get("adset_id")).toBe("a1");
    expect(JSON.parse(ad!.form.get("creative")!).creative_id).toBe("cr1");
    expect(ad!.form.get("status")).toBe("PAUSED");
  });

  test("lifetime budgets use the lifetime_budget key", async () => {
    stub();
    const ads = await adsFor("cg", metaSecrets, ACT, PAGE);
    await ads.createCampaign({
      campaignId: "x", name: "L", objective: "OUTCOME_TRAFFIC", budgetCents: 9000, budgetType: "lifetime",
      creative: { headline: "h", body: "b", linkUrl: "https://x/pay" },
    });
    const adset = calls.find((c) => c.path.endsWith("/adsets"))!;
    expect(adset.form.get("lifetime_budget")).toBe("9000");
    expect(adset.form.get("daily_budget")).toBeNull();
  });

  test("launch flips both ad set and campaign to ACTIVE", async () => {
    stub();
    const ads = await adsFor("cg", metaSecrets, ACT, PAGE);
    await ads.launch("meta:c1:a1");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => [c.path, c.form.get("status")])).toEqual([
      ["a1", "ACTIVE"],
      ["c1", "ACTIVE"],
    ]);
  });

  test("pause sets the campaign to PAUSED", async () => {
    stub();
    const ads = await adsFor("cg", metaSecrets, ACT, PAGE);
    await ads.pause("meta:c1:a1");
    expect(calls).toEqual([expect.objectContaining({ path: "c1" })]);
    expect(calls[0]!.form.get("status")).toBe("PAUSED");
  });

  test("setBudget updates the ad set on the right budget key", async () => {
    stub();
    const ads = await adsFor("cg", metaSecrets, ACT, PAGE);
    await ads.setBudget("meta:c1:a1", 2500, "daily");
    expect(calls[0]!.path).toBe("a1");
    expect(calls[0]!.form.get("daily_budget")).toBe("2500");
  });

  test("insights parse Graph rows into cents-denominated DailySpend", async () => {
    stub((path) =>
      path.endsWith("/insights")
        ? { body: { data: [
            { date_start: "2026-07-01", spend: "1.23", impressions: "400", clicks: "9" },
            { date_start: "2026-07-02", spend: "0.50", impressions: "88", clicks: "1" },
          ] } }
        : { body: { id: "x" } },
    );
    const ads = await adsFor("cg", metaSecrets, ACT, PAGE);
    const rows = await ads.insights({ providerRef: "meta:c1:a1", budgetCents: 1000, budgetType: "daily", sinceDay: "2026-07-01", throughDay: "2026-07-02" });
    expect(rows).toEqual([
      { day: "2026-07-01", spendCents: 123, impressions: 400, clicks: 9 },
      { day: "2026-07-02", spendCents: 50, impressions: 88, clicks: 1 },
    ]);
    // insights is a GET on the campaign edge with a day-bucketed time range.
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.path).toBe("c1/insights");
    expect(JSON.parse(call.form.get("time_range")!)).toEqual({ since: "2026-07-01", until: "2026-07-02" });
    expect(call.form.get("time_increment")).toBe("1");
  });

  test("a 4xx Graph error surfaces as a terminal MetaApiError", async () => {
    stub(() => ({ status: 400, body: { error: { message: "Invalid parameter" } } }));
    const ads = await adsFor("cg", metaSecrets, ACT, PAGE);
    const err = await ads.pause("meta:c1:a1").catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).status).toBe(400);
    expect((err as MetaApiError).terminal).toBe(true); // sync will skip, not retry
  });
});
