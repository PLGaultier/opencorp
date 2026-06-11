import { describe, expect, test } from "bun:test";
import {
  MemoryBillingStore,
  PLANS,
  runGrantCycle,
  subscribe,
  type BillingProvider,
} from "../src/billing";

const none: BillingProvider = { kind: "none", ensureSubscription: async () => null };

function recorder() {
  const events: Record<string, unknown>[] = [];
  return { events, append: async (p: Record<string, unknown>) => void events.push(p) };
}

describe("plans (§10)", () => {
  test("catalog: free is one-time, paid plans recur", () => {
    expect(PLANS.free.oneTime).toBe(true);
    expect(PLANS.free.priceCents).toBe(0);
    expect(PLANS.builder.oneTime).toBe(false);
    expect(PLANS.pro.credits).toBeGreaterThan(PLANS.builder.credits);
  });
});

describe("subscribe", () => {
  test("free plan grants once, ever — resubscribing is a no-op", async () => {
    const store = new MemoryBillingStore();
    const { events, append } = recorder();
    await subscribe(store, none, append, "g1", "free");
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0]!.credits).toBe(PLANS.free.credits);

    // same plan again → idempotent
    await subscribe(store, none, append, "g1", "free");
    // downgrade away and back → the one-time grant must not repeat
    await subscribe(store, none, append, "g1", "builder");
    await subscribe(store, none, append, "g1", "free");
    expect(store.grants.filter((g) => g.meta.plan === "free")).toHaveLength(1);
    expect(events.filter((e) => e.plan === "free")).toHaveLength(1);
  });

  test("paid plan grants the first cycle and writes a ledger event", async () => {
    const store = new MemoryBillingStore();
    const { events, append } = recorder();
    const sub = await subscribe(store, none, append, "g1", "builder", new Date("2026-06-01T00:00:00Z"));
    expect(sub.plan).toBe("builder");
    expect(store.grants).toEqual([
      { conglomerateId: "g1", credits: 100, meta: { plan: "builder", period: "builder:2026-06-01" } },
    ]);
    expect(events[0]).toMatchObject({ reason: "grant", delta: 100 });
  });
});

describe("runGrantCycle", () => {
  test("grants each elapsed month exactly once, advancing the period", async () => {
    const store = new MemoryBillingStore();
    const { append } = recorder();
    await subscribe(store, none, append, "g1", "pro", new Date("2026-03-15T00:00:00Z"));
    expect(store.grants).toHaveLength(1);

    // three months later: 3 new cycles due
    const now = new Date("2026-06-16T00:00:00Z");
    expect((await runGrantCycle(store, append, now)).granted).toBe(3);
    expect(store.grants).toHaveLength(4);
    // re-running at the same instant is a no-op (cron-safe)
    expect((await runGrantCycle(store, append, now)).granted).toBe(0);
    expect((await store.get("g1"))!.currentPeriodStart).toEqual(new Date("2026-06-15T00:00:00Z"));
  });

  test("skips free and canceled subscriptions", async () => {
    const store = new MemoryBillingStore();
    const { append } = recorder();
    await subscribe(store, none, append, "free-g", "free", new Date("2026-01-01T00:00:00Z"));
    await subscribe(store, none, append, "gone-g", "builder", new Date("2026-01-01T00:00:00Z"));
    const sub = (await store.get("gone-g"))!;
    await store.upsert({ ...sub, status: "canceled" });

    const { granted } = await runGrantCycle(store, append, new Date("2026-06-01T00:00:00Z"));
    expect(granted).toBe(0);
  });
});
