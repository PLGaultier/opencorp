import { describe, expect, test } from "bun:test";
import {
  DEPARTMENT_KEYS,
  DepartmentProposal,
  fallbackDepartment,
  planDepartment,
  type DepartmentReport,
} from "../src/departments";
import { fallbackPlan, planHeartbeat, CeoPlan, type CeoContext } from "../src/ceo";

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

describe("department sub-planners (§14 M5)", () => {
  test("every department fallback passes the proposal schema", () => {
    for (const dept of DEPARTMENT_KEYS) {
      const report = fallbackDepartment(dept, ctx);
      expect(report.department).toBe(dept);
      expect(DepartmentProposal.safeParse(report).success).toBe(true);
    }
  });

  test("CMO answers the inbox and skips outreach when revenue is flowing", () => {
    const r = fallbackDepartment("cmo", ctx);
    expect(r.proposed_tasks.map((t) => t.title)).toEqual(["Reply to unread inbound emails"]);
  });

  test("CMO proposes outreach when revenue is zero and the queue is empty", () => {
    const r = fallbackDepartment("cmo", { ...ctx, revenueCents24h: 0, unreadEmails: [] });
    expect(r.proposed_tasks.map((t) => t.title)).toEqual([
      "Draft and run a customer outreach campaign",
    ]);
    expect(r.headline).toContain("No revenue");
  });

  test("CMO stays quiet when there is nothing to do", () => {
    const r = fallbackDepartment("cmo", { ...ctx, unreadEmails: [], queuedTasks: 2 });
    expect(r.proposed_tasks).toHaveLength(0);
  });

  test("CTO turns failed reports into fix tasks, capped at 2", () => {
    const failed = (n: string) => ({ title: n, status: "failed", summary: "boom" });
    const r = fallbackDepartment("cto", {
      ...ctx,
      recentReports: [failed("a"), failed("b"), failed("c")],
    });
    expect(r.proposed_tasks.map((t) => t.title)).toEqual([
      "Fix failed task: a",
      "Fix failed task: b",
    ]);
  });

  test("CFO observes but never spends", () => {
    const r = fallbackDepartment("cfo", { ...ctx, creditBalance: 1 });
    expect(r.proposed_tasks).toHaveLength(0);
    expect(r.headline).toContain("below one day's cap");
  });

  test("planDepartment without llm config uses the fallback", async () => {
    const r = await planDepartment(null, "system", "cto", ctx);
    expect(r.department).toBe("cto");
    expect(r.proposed_tasks[0]!.title).toBe("Fix failed task: Cold outreach batch");
  });
});

describe("CEO synthesis over department reports", () => {
  const reports: DepartmentReport[] = [
    {
      department: "cmo",
      headline: "Inbox needs replies.",
      observations: [],
      proposed_tasks: [
        { title: "Reply to unread inbound emails", description: "", priority: 2 },
        { title: "Write a newsletter", description: "", priority: 0 },
      ],
    },
    {
      department: "cto",
      headline: "One failure.",
      observations: [],
      proposed_tasks: [
        { title: "Fix failed task: Cold outreach batch", description: "", priority: 2 },
        // duplicate across departments — must be deduped
        { title: "Reply to unread inbound emails", description: "dupe", priority: 1 },
      ],
    },
    { department: "cfo", headline: "Runway healthy.", observations: [], proposed_tasks: [] },
  ];

  test("adopts proposals deduped by title, priority-sorted, capped at the daily task cap", () => {
    const plan = fallbackPlan({ ...ctx, dailyTaskCap: 2 }, reports);
    expect(CeoPlan.safeParse(plan).success).toBe(true);
    expect(plan.new_tasks.map((t) => t.title)).toEqual([
      "Reply to unread inbound emails",
      "Fix failed task: Cold outreach batch",
    ]);
    expect(plan.user_brief).toContain("CFO — Runway healthy.");
  });

  test("with proposals, the generic refill task is not created", () => {
    const plan = fallbackPlan(ctx, reports);
    expect(plan.new_tasks.map((t) => t.title)).not.toContain(
      "Review performance and plan next steps",
    );
  });

  test("without proposals, behavior is unchanged: refill an empty queue", () => {
    const plan = fallbackPlan(ctx, []);
    expect(plan.new_tasks.map((t) => t.title)).toEqual([
      "Review performance and plan next steps",
    ]);
  });

  test("planHeartbeat without llm config synthesizes the department reports", async () => {
    const plan = await planHeartbeat(null, "system", ctx, undefined, reports);
    expect(plan.new_tasks.length).toBeGreaterThan(0);
    expect(plan.user_brief).toContain("CMO — Inbox needs replies.");
  });
});
