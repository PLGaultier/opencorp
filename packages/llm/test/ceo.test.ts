import { describe, expect, test } from "bun:test";
import {
  CeoPlan,
  CeoChatReply,
  fallbackChat,
  fallbackPlan,
  planHeartbeat,
  ceoChat,
  promptHash,
  type CeoContext,
} from "../src/ceo";

const ctx: CeoContext = {
  company: { name: "Mug Co", mission: "Sell handmade ceramic mugs online." },
  creditBalance: 7.5,
  dailyTaskCap: 3,
  queuedTasks: 0,
  recentReports: [
    { title: "Launch storefront", status: "done", summary: "Live with payment link." },
    { title: "Cold outreach batch", status: "failed", summary: "rate_limited" },
  ],
  revenueCents24h: 2900,
  unreadEmails: [{ from: "buyer@example.com", subject: "Bulk order?" }],
};

describe("CEO planning (§5.2)", () => {
  test("fallback plan passes schema and refills an empty queue", () => {
    const plan = fallbackPlan(ctx);
    expect(CeoPlan.safeParse(plan).success).toBe(true);
    expect(plan.new_tasks).toHaveLength(1);
    expect(plan.stop_doing).toEqual(["Cold outreach batch"]);
    expect(plan.mission_patch).toBeNull();
    expect(plan.user_brief).toContain("€29.00");
  });

  test("fallback plan leaves a non-empty queue alone", () => {
    expect(fallbackPlan({ ...ctx, queuedTasks: 2 }).new_tasks).toHaveLength(0);
  });

  test("planHeartbeat without llm config uses the fallback", async () => {
    const plan = await planHeartbeat(null, "system", ctx);
    expect(plan.user_brief).toContain("no LLM configured");
  });

  test("prompt hash is stable and content-sensitive (§5.4)", () => {
    expect(promptHash("a")).toBe(promptHash("a"));
    expect(promptHash("a")).not.toBe(promptHash("b"));
    expect(promptHash("a")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("schema bounds: at most 10 new tasks, brief required", () => {
    const base = fallbackPlan(ctx);
    const task = { title: "t", description: "", priority: 0 };
    expect(CeoPlan.safeParse({ ...base, new_tasks: Array(11).fill(task) }).success).toBe(false);
    expect(CeoPlan.safeParse({ ...base, user_brief: "" }).success).toBe(false);
  });
});

describe("CEO chat", () => {
  test("fallback answers with status and queues nothing by default", () => {
    const r = fallbackChat(ctx, "how are we doing?");
    expect(CeoChatReply.safeParse(r).success).toBe(true);
    expect(r.new_tasks).toHaveLength(0);
    expect(r.reply).toContain("€29.00");
  });

  test("'task:' directive queues a task", () => {
    const r = fallbackChat(ctx, "task: write a pricing page");
    expect(r.new_tasks).toEqual([
      {
        title: "write a pricing page",
        description: 'Requested by the owner in chat: "task: write a pricing page"',
        priority: 1,
      },
    ]);
  });

  test("ceoChat without llm config uses the fallback", async () => {
    const r = await ceoChat(null, "system", ctx, [], "status?");
    expect(r.reply).toContain("no LLM configured");
  });
});
