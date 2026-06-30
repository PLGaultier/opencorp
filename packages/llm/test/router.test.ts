import { describe, expect, test } from "bun:test";
import {
  routeTier,
  deriveHeartbeatSignals,
  deriveDepartmentSignals,
  deriveChatSignals,
  type Complexity,
  type Stakes,
} from "../src/router";
import type { ModelTier } from "../src/client";
import type { CeoContext } from "../src/ceo";

const COMPLEXITIES: Complexity[] = ["trivial", "routine", "hard"];
const STAKES: Stakes[] = ["low", "high"];
const rank: Record<ModelTier, number> = { mini: 0, standard: 1, frontier: 2 };

describe("routeTier (OPE-7) — policy table", () => {
  test("heartbeat_noop pins mini regardless of complexity/stakes", () => {
    for (const complexity of COMPLEXITIES)
      for (const stakes of STAKES)
        expect(routeTier({ taskKind: "heartbeat_noop", complexity, stakes }).tier).toBe("mini");
  });

  test("heartbeat_plan walks the ladder by complexity; high stakes floors at standard", () => {
    expect(routeTier({ taskKind: "heartbeat_plan", complexity: "trivial", stakes: "low" }).tier).toBe("mini");
    expect(routeTier({ taskKind: "heartbeat_plan", complexity: "routine", stakes: "low" }).tier).toBe("standard");
    expect(routeTier({ taskKind: "heartbeat_plan", complexity: "hard", stakes: "low" }).tier).toBe("frontier");
    // high stakes never decides on the floor model
    expect(routeTier({ taskKind: "heartbeat_plan", complexity: "trivial", stakes: "high" }).tier).toBe("standard");
    expect(routeTier({ taskKind: "heartbeat_plan", complexity: "routine", stakes: "high" }).tier).toBe("standard");
    expect(routeTier({ taskKind: "heartbeat_plan", complexity: "hard", stakes: "high" }).tier).toBe("frontier");
  });

  test("owner_chat: low stakes → mini, high stakes → standard (any complexity)", () => {
    for (const complexity of COMPLEXITIES) {
      expect(routeTier({ taskKind: "owner_chat", complexity, stakes: "low" }).tier).toBe("mini");
      expect(routeTier({ taskKind: "owner_chat", complexity, stakes: "high" }).tier).toBe("standard");
    }
  });

  test("owner_chat_directive: never below standard; hard → frontier", () => {
    for (const stakes of STAKES) {
      expect(routeTier({ taskKind: "owner_chat_directive", complexity: "trivial", stakes }).tier).toBe("standard");
      expect(routeTier({ taskKind: "owner_chat_directive", complexity: "routine", stakes }).tier).toBe("standard");
      expect(routeTier({ taskKind: "owner_chat_directive", complexity: "hard", stakes }).tier).toBe("frontier");
    }
  });

  test("department_synthesis: cheap floor, standard for hard/high, never frontier", () => {
    expect(routeTier({ taskKind: "department_synthesis", complexity: "trivial", stakes: "low" }).tier).toBe("mini");
    expect(routeTier({ taskKind: "department_synthesis", complexity: "routine", stakes: "low" }).tier).toBe("mini");
    expect(routeTier({ taskKind: "department_synthesis", complexity: "hard", stakes: "low" }).tier).toBe("standard");
    expect(routeTier({ taskKind: "department_synthesis", complexity: "routine", stakes: "high" }).tier).toBe("standard");
    // a sub-planner is never routed above the CEO's own ceiling
    for (const complexity of COMPLEXITIES)
      for (const stakes of STAKES)
        expect(rank[routeTier({ taskKind: "department_synthesis", complexity, stakes }).tier]).toBeLessThanOrEqual(rank.standard);
  });

  test("every taskKind × complexity × stakes returns a valid tier + reason", () => {
    const kinds = ["heartbeat_plan", "heartbeat_noop", "owner_chat", "owner_chat_directive", "department_synthesis"] as const;
    for (const taskKind of kinds)
      for (const complexity of COMPLEXITIES)
        for (const stakes of STAKES) {
          const d = routeTier({ taskKind, complexity, stakes });
          expect(["mini", "standard", "frontier"]).toContain(d.tier);
          expect(d.reason.length).toBeGreaterThan(0);
        }
  });

  test("defaults to routine/low when signals are omitted", () => {
    expect(routeTier({ taskKind: "heartbeat_plan" }).tier).toBe("standard");
    expect(routeTier({ taskKind: "owner_chat" }).tier).toBe("mini");
  });
});

describe("routeTier (OPE-7) — schema_repair_retry never downshifts", () => {
  test("holds the failed call's tier", () => {
    for (const t of ["mini", "standard", "frontier"] as ModelTier[])
      expect(routeTier({ taskKind: "schema_repair_retry", baseTier: t }).tier).toBe(t);
  });

  test("never routes below the failed tier (it is exactly the base, regardless of signals)", () => {
    const d = routeTier({ taskKind: "schema_repair_retry", baseTier: "frontier", complexity: "trivial", stakes: "low" });
    expect(rank[d.tier]).toBeGreaterThanOrEqual(rank.frontier);
  });

  test("falls back to frontier when no baseTier is given", () => {
    expect(routeTier({ taskKind: "schema_repair_retry" }).tier).toBe("frontier");
  });
});

// ── signal derivation ──────────────────────────────────────────────────────
function ctx(over: Partial<CeoContext> = {}): CeoContext {
  return {
    company: { name: "Co", mission: "m" },
    creditBalance: 1000,
    dailyTaskCap: 3,
    queuedTasks: 0,
    recentReports: [],
    revenueCents24h: 0,
    unreadEmails: [],
    ...over,
  };
}

describe("deriveHeartbeatSignals (OPE-7)", () => {
  test("a totally quiet heartbeat is a no-op (→ mini downstream)", () => {
    const s = deriveHeartbeatSignals(ctx());
    expect(s.taskKind).toBe("heartbeat_noop");
    expect(routeTier(s).tier).toBe("mini");
  });

  test("queued work makes it a real plan, routine/low → standard", () => {
    const s = deriveHeartbeatSignals(ctx({ queuedTasks: 2 }));
    expect(s.taskKind).toBe("heartbeat_plan");
    expect(s.complexity).toBe("routine");
    expect(s.stakes).toBe("low");
    expect(routeTier(s).tier).toBe("standard");
  });

  test("failures/inbox/approvals make it hard + high → frontier", () => {
    const s = deriveHeartbeatSignals(ctx({ recentReports: [{ title: "t", status: "failed", summary: null }] }));
    expect(s.complexity).toBe("hard");
    expect(s.stakes).toBe("high");
    expect(routeTier(s).tier).toBe("frontier");
  });

  test("revenue alone raises stakes (high) but not complexity", () => {
    const s = deriveHeartbeatSignals(ctx({ revenueCents24h: 500 }));
    expect(s.taskKind).toBe("heartbeat_plan");
    expect(s.stakes).toBe("high");
  });
});

describe("deriveDepartmentSignals (OPE-7)", () => {
  test("quiet context → trivial/low → mini", () => {
    const s = { taskKind: "department_synthesis" as const, ...deriveDepartmentSignals(ctx()) };
    expect(routeTier(s).tier).toBe("mini");
  });
  test("messy context → standard (capped)", () => {
    const s = { taskKind: "department_synthesis" as const, ...deriveDepartmentSignals(ctx({ unreadEmails: [{ from: "a", subject: "s" }] })) };
    expect(routeTier(s).tier).toBe("standard");
  });
});

describe("deriveChatSignals (OPE-7)", () => {
  test("plain question → owner_chat (mini)", () => {
    const s = deriveChatSignals("What is our best growth move?");
    expect(s.taskKind).toBe("owner_chat");
    expect(routeTier(s).tier).toBe("mini");
  });
  test("'task:' directive → owner_chat_directive (standard)", () => {
    const s = deriveChatSignals("task: publish the pricing page");
    expect(s.taskKind).toBe("owner_chat_directive");
    expect(routeTier(s).tier).toBe("standard");
  });
});
