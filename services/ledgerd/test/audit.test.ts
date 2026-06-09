import { describe, expect, test } from "bun:test";
import { auditPayload, auditChain } from "../src/audit";
import { redact } from "../src/redact";
import { MemoryStore } from "../src/store";
import { Ledger } from "../src/ledger";

describe("redaction audit (§9.3)", () => {
  test("flags third-party emails and secret material", () => {
    const v = auditPayload({
      to: "customer@gmail.com",
      note: "key is sk_live_abc123DEF456",
      ours: "acme@opencorp.app",
    });
    const kinds = v.map((x) => x.kind).sort();
    expect(kinds).toEqual(["secret_material", "third_party_email"]);
  });

  test("clean payloads (own-domain only) produce no violations", () => {
    expect(auditPayload({ from: "acme@opencorp.app", subject: "hi", n: 3 })).toHaveLength(0);
  });

  test("redactor closes exactly what the auditor looks for (roundtrip)", () => {
    const dirty = { to: "lead@example.org", api_key: "sk_live_SHOULD_BE_GONE", body: "ping" };
    // auditing the raw payload finds leaks
    expect(auditPayload(dirty).length).toBeGreaterThan(0);
    // auditing the redacted payload finds none
    expect(auditPayload(redact(dirty))).toHaveLength(0);
  });

  test("auditChain over an append-redacted chain finds nothing", async () => {
    const store = new MemoryStore();
    const ledger = new Ledger(store);
    // Ledger.append redacts before storing, so the chain must come out clean.
    await ledger.append({ companyId: "c1", actor: "system", eventType: "email_sent", payload: { to: ["x@example.com"] } });
    await ledger.append({ companyId: "c1", actor: "system", eventType: "note", payload: { ok: true } });
    const { scanned, violations } = await auditChain(store);
    expect(scanned).toBe(2);
    expect(violations).toHaveLength(0);
  });

  test("auditChain catches a leak that bypassed redaction", async () => {
    const store = new MemoryStore();
    // Write directly to the store (bypassing Ledger's redactor) to simulate a bug.
    await store.append({ companyId: "c1", actor: "system", eventType: "raw", payload: { to: "lead@example.org" } });
    const { violations } = await auditChain(store);
    expect(violations[0]?.kind).toBe("third_party_email");
    expect(violations[0]?.seq).toBe(1);
  });
});
