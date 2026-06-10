import { describe, expect, test } from "bun:test";
import { EgressProxy, LocalSandboxPool } from "../src/index";

describe("egress proxy (§8)", () => {
  test("allows public http(s), blocks scheme/private/metadata", () => {
    const p = new EgressProxy();
    expect(p.check("https://example.com").allowed).toBe(true);
    expect(p.check("http://127.0.0.1").reason).toBe("blocked_private_address");
    expect(p.check("http://169.254.169.254").reason).toBe("blocked_private_address");
    expect(p.check("http://metadata.google.internal").reason).toBe("blocked_private_address");
    expect(p.check("file:///etc/passwd").reason).toBe("blocked_scheme");
    expect(p.check("not a url").reason).toBe("invalid_url");
  });

  test("allowlist (exact + suffix) and decision logging", () => {
    const seen: string[] = [];
    const p = new EgressProxy({ allowlist: ["example.com"], onDecision: (d) => seen.push(`${d.allowed}:${d.url}`) });
    expect(p.check("https://example.com/a").allowed).toBe(true);
    expect(p.check("https://api.example.com/a").allowed).toBe(true); // suffix
    expect(p.check("https://evil.test/a").reason).toBe("not_on_allowlist");
    expect(seen).toHaveLength(3);
  });

  test("guarded fetch refuses denied URLs without calling out", async () => {
    const p = new EgressProxy();
    await expect(p.fetch("http://10.0.0.1/secret")).rejects.toThrow("egress_denied");
  });
});

describe("local sandbox pool (§8, §5.3)", () => {
  test("claim → run → release, with stats", async () => {
    const pool = new LocalSandboxPool(2);
    const sb = await pool.claim({ taskId: "t1", companyId: "c1" });
    expect(pool.stats().inUse).toBe(1);
    const out = await sb.run(async () => 42);
    expect(out).toBe(42);
    await sb.release();
    expect(pool.stats().inUse).toBe(0);
  });

  test("a released sandbox cannot run again (no reuse)", async () => {
    const pool = new LocalSandboxPool();
    const sb = await pool.claim({ taskId: "t", companyId: "c" });
    await sb.release();
    await expect(sb.run(async () => 1)).rejects.toThrow("sandbox_already_released");
  });

  test("capacity caps concurrency; a release admits a waiter", async () => {
    const pool = new LocalSandboxPool(1);
    const a = await pool.claim({ taskId: "a", companyId: "c" });
    let bClaimed = false;
    const bPromise = pool.claim({ taskId: "b", companyId: "c" }).then((sb) => {
      bClaimed = true;
      return sb;
    });
    await Promise.resolve();
    expect(bClaimed).toBe(false); // queued behind capacity
    await a.release();
    const b = await bPromise;
    expect(bClaimed).toBe(true);
    expect(pool.stats().inUse).toBe(1);
    await b.release();
  });

  test("run enforces the wall-clock budget", async () => {
    const pool = new LocalSandboxPool();
    const sb = await pool.claim({ taskId: "t", companyId: "c", budgets: { maxWallClockMs: 20 } });
    await expect(sb.run(() => new Promise((r) => setTimeout(r, 200)))).rejects.toThrow(
      "wall_clock_budget_exceeded",
    );
    await sb.release();
  });
});
