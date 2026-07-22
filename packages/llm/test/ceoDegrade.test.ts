import { describe, expect, test } from "bun:test";
import { planHeartbeat, CeoPlan, type CeoContext } from "../src/ceo";
import type { LlmConfig } from "../src/client";

/**
 * A failing CEO model must degrade to the deterministic plan, never throw.
 *
 * Prod (2026-07-19 → 2026-07-22) lost whole days this way: a transient empty
 * completion or an unparseable reply escaped planHeartbeat, the heartbeat
 * workflow died, and the company queued no work at all.
 */

/** A LiteLLM stub whose reply is chosen per request, so retries can differ. */
function stubServer(replies: (n: number) => { body?: unknown; status?: number }) {
  let n = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const { body, status = 200 } = replies(++n);
      return new Response(JSON.stringify(body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, cfg: { baseUrl: server.url.origin } as LlmConfig, calls: () => n };
}
const completion = (content: string) => ({ choices: [{ message: { content } }], model: "standard" });

const ctx: CeoContext = {
  company: { name: "Mug Co", mission: "Sell handmade ceramic mugs online." },
  creditBalance: 7.5,
  dailyTaskCap: 3,
  queuedTasks: 0,
  recentReports: [],
  revenueCents24h: 0,
  unreadEmails: [],
};

const validPlan = JSON.stringify({
  keep_doing: [],
  stop_doing: [],
  new_tasks: [{ title: "Ship pricing page", description: "", priority: 7 }],
  mission_patch: null,
  user_brief: "Recovered after a blip.",
});

describe("planHeartbeat degradation", () => {
  test("unparseable replies degrade to a valid fallback plan instead of throwing", async () => {
    const { server, cfg, calls } = stubServer(() => ({ body: completion("not json at all") }));
    try {
      const plan = await planHeartbeat(cfg, "system", ctx);
      expect(CeoPlan.safeParse(plan).success).toBe(true);
      expect(plan.degraded).toBe(true);
      // one initial call + one schema-repair retry, then degrade rather than throw
      expect(calls()).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("a null reply (the 2026-07-21 prod failure) degrades rather than throwing", async () => {
    const { server, cfg } = stubServer(() => ({ body: completion("null") }));
    try {
      const plan = await planHeartbeat(cfg, "system", ctx);
      expect(plan.degraded).toBe(true);
      expect(plan.user_brief.length).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  test("a transient empty completion is retried, not fatal", async () => {
    // First call returns no content at all → "llm returned empty completion".
    const { server, cfg, calls } = stubServer((n) =>
      n === 1 ? { body: completion("") } : { body: completion(validPlan) },
    );
    try {
      const plan = await planHeartbeat(cfg, "system", ctx);
      expect(plan.degraded).toBeUndefined();
      expect(plan.new_tasks[0]!.title).toBe("Ship pricing page");
      expect(calls()).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("a transient 503 is retried, not fatal", async () => {
    const { server, cfg } = stubServer((n) =>
      n === 1 ? { status: 503, body: { error: "upstream" } } : { body: completion(validPlan) },
    );
    try {
      const plan = await planHeartbeat(cfg, "system", ctx);
      expect(plan.degraded).toBeUndefined();
      expect(plan.new_tasks[0]!.title).toBe("Ship pricing page");
    } finally {
      server.stop(true);
    }
  });
});
