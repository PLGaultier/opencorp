import { describe, expect, test } from "bun:test";
import { signToken, verifyToken } from "@opencorp/mcp-client";
import { MemoryRateLimiter } from "@opencorp/ratelimit";

describe("gateway tokens", () => {
  const scope = { companyId: "c1", taskId: "t1", exp: Math.floor(Date.now() / 1000) + 60 };

  test("sign/verify roundtrip", () => {
    expect(verifyToken(signToken(scope))).toEqual(scope);
  });

  test("rejects tampered payload and expired tokens", () => {
    const token = signToken(scope);
    const [p, m] = token.split(".");
    const evil = Buffer.from(JSON.stringify({ ...scope, companyId: "other" })).toString("base64url");
    expect(verifyToken(`${evil}.${m}`)).toBeNull();
    expect(verifyToken(`${p}.AAAA`)).toBeNull();
    expect(verifyToken(signToken({ ...scope, exp: Math.floor(Date.now() / 1000) - 1 }))).toBeNull();
  });
});

describe("rate limiter (§7.2 contract)", () => {
  test("allows under limit, blocks over, failed calls count", () => {
    const rl = new MemoryRateLimiter();
    for (let i = 0; i < 5; i++) expect(rl.check("c1", "delete_product")).toBeNull();
    const err = rl.check("c1", "delete_product")!; // 6th call, hourly limit 5
    expect(err.error).toBe("rate_limited");
    expect(err.window).toBe("hour");
    expect(err.used).toBe(6);
    expect(err.limit).toBe(5);
    expect(err.retry_after_s).toBeGreaterThan(300);
    expect(err.should_wait).toBe(false);
    expect(err.message).toContain("delete_product");
  });

  test("limits are per company and per tool", () => {
    const rl = new MemoryRateLimiter();
    for (let i = 0; i < 6; i++) rl.check("c1", "delete_product");
    expect(rl.check("c2", "delete_product")).toBeNull();
    expect(rl.check("c1", "create_product")).toBeNull();
  });

  test("read tools are uncapped", () => {
    const rl = new MemoryRateLimiter();
    for (let i = 0; i < 500; i++) expect(rl.check("c1", "list_tasks_read_unlisted")).toBeNull();
  });
});
