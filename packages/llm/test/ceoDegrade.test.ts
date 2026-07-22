import { describe, expect, test } from "bun:test";
import { planHeartbeat, fallbackPlan, CeoPlan, type CeoContext } from "../src/ceo";
import type { LlmConfig } from "../src/client";

/**
 * Transient LLM failures must not reach the caller at all — prod (2026-07-19 →
 * 2026-07-22) lost whole days because a single empty completion escaped
 * planHeartbeat and killed the heartbeat workflow, queueing no work.
 *
 * A *persistent* failure still throws on purpose: runCeoPlanning catches it,
 * substitutes fallbackPlan, and records the reason on the ceo_plan ledger event
 * (same contract as planDepartment). Swallowing it here would hide a model that
 * has started failing every day behind a plausible-looking plan.
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

describe("planHeartbeat resilience", () => {
  test("a persistently unparseable reply throws after one schema repair", async () => {
    const { server, cfg, calls } = stubServer(() => ({ body: completion("not json at all") }));
    try {
      await expect(planHeartbeat(cfg, "system", ctx)).rejects.toThrow("ceo plan failed validation");
      // one initial call + exactly one schema-repair retry, then give up
      expect(calls()).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("a null reply (the 2026-07-21 prod failure) throws rather than hanging or looping", async () => {
    const { server, cfg } = stubServer(() => ({ body: completion("null") }));
    try {
      await expect(planHeartbeat(cfg, "system", ctx)).rejects.toThrow("ceo plan failed validation");
    } finally {
      server.stop(true);
    }
  });

  test("the deterministic fallback the caller substitutes is a valid plan", () => {
    expect(CeoPlan.safeParse(fallbackPlan(ctx)).success).toBe(true);
  });

  test("a transient empty completion is retried, not fatal", async () => {
    // First call returns no content at all → "llm returned empty completion".
    const { server, cfg, calls } = stubServer((n) =>
      n === 1 ? { body: completion("") } : { body: completion(validPlan) },
    );
    try {
      const plan = await planHeartbeat(cfg, "system", ctx);
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
      expect(plan.new_tasks[0]!.title).toBe("Ship pricing page");
    } finally {
      server.stop(true);
    }
  });
});
