import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/ledger";
import { MemoryStore } from "../src/store";
import { canonicalJson, computeHash, verifyChain, GENESIS_HASH } from "../src/chain";
import { redact } from "../src/redact";

describe("canonical json", () => {
  test("sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
  });
});

describe("M0 exit test", () => {
  test("append 10k events, chain verifies", async () => {
    const store = new MemoryStore();
    const ledger = new Ledger(store);
    for (let i = 0; i < 10_000; i++) {
      await ledger.append({
        companyId: null,
        actor: "system",
        eventType: "tool_call",
        payload: { tool: "send_email", i, args: { to: "someone@example.com" } },
      });
    }
    const r = await ledger.verify();
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(10_000);
  });

  test("tampered payload is detected", async () => {
    const store = new MemoryStore();
    const ledger = new Ledger(store);
    for (let i = 0; i < 100; i++) {
      await ledger.append({ companyId: null, actor: "system", eventType: "x", payload: { i } });
    }
    (store.events[49]!.payload as Record<string, unknown>).i = 999;
    const r = await ledger.verify();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(50);
    expect(r.reason).toBe("hash_mismatch");
  });

  test("re-hashing a tampered event breaks the next link", async () => {
    const store = new MemoryStore();
    const ledger = new Ledger(store);
    for (let i = 0; i < 10; i++) {
      await ledger.append({ companyId: null, actor: "system", eventType: "x", payload: { i } });
    }
    const ev = store.events[4]!;
    (ev.payload as Record<string, unknown>).i = 999;
    ev.hash = computeHash(ev.prevHash, ev.payload, ev.seq, ev.createdAt);
    const r = await ledger.verify();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(6);
    expect(r.reason).toBe("chain_broken");
  });

  test("mid-chain verification with anchor", async () => {
    const store = new MemoryStore();
    const ledger = new Ledger(store);
    for (let i = 0; i < 50; i++) {
      await ledger.append({ companyId: null, actor: "system", eventType: "x", payload: { i } });
    }
    const r = await ledger.verify(20, 40);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(21);
  });

  test("seq gap is detected", () => {
    const store = new MemoryStore();
    const mk = async () => {
      const ledger = new Ledger(store);
      for (let i = 0; i < 5; i++) {
        await ledger.append({ companyId: null, actor: "system", eventType: "x", payload: { i } });
      }
    };
    return mk().then(() => {
      const events = [...store.events];
      events.splice(2, 1);
      const r = verifyChain(events, GENESIS_HASH);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("seq_gap");
    });
  });
});

describe("redaction", () => {
  test("hashes third-party emails, keeps own domain", () => {
    const out = redact({ note: "mail bob@gmail.com and acme@opencorp.app" }) as { note: string };
    expect(out.note).toContain("acme@opencorp.app");
    expect(out.note).not.toContain("bob@gmail.com");
    expect(out.note).toMatch(/email:[0-9a-f]{12}/);
  });

  test("strips secret-looking keys and stamps ruleset version", () => {
    const out = redact({ api_key: "sk-123", nested: { Authorization: "Bearer x" } }) as Record<string, unknown>;
    expect(out.api_key).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).Authorization).toBe("[REDACTED]");
    expect(out._redaction_v).toBe(1);
  });
});
