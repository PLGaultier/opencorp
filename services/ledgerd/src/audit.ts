import type { LedgerStore } from "./store";

/**
 * Redaction audit (§9.3). The redactor runs before append; this is the
 * after-the-fact verifier that proves it held. It scans stored (already
 * redacted) payloads for material that should never reach the public chain:
 *   - third-party email addresses (ours stay; others must be hashed to email:…)
 *   - recognizable secret material (provider keys/tokens)
 * Run in CI and as a periodic job; any violation is a redaction-rule bug.
 */
const OWN_DOMAIN = process.env.OPENCORP_DOMAIN ?? "opencorp.app";
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_RE =
  /(sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export type ViolationKind = "third_party_email" | "secret_material";
export interface RedactionViolation {
  seq: number;
  eventType: string;
  kind: ViolationKind;
  sample: string;
}

/** Find leaks in a single payload (pure; unit-tested). */
export function auditPayload(payload: unknown): { kind: ViolationKind; sample: string }[] {
  const out: { kind: ViolationKind; sample: string }[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const addr of v.match(EMAIL_RE) ?? []) {
        if (!addr.toLowerCase().endsWith(`@${OWN_DOMAIN}`))
          out.push({ kind: "third_party_email", sample: addr });
      }
      const secret = v.match(SECRET_RE);
      if (secret) out.push({ kind: "secret_material", sample: secret[0].slice(0, 12) + "…" });
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v !== null && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(visit);
    }
  };
  visit(payload);
  return out;
}

/** Scan a contiguous range of the chain, returning every violation found. */
export async function auditChain(
  store: LedgerStore,
  fromSeq = 1,
  toSeq?: number,
): Promise<{ scanned: number; violations: RedactionViolation[] }> {
  let scanned = 0;
  const violations: RedactionViolation[] = [];
  for await (const ev of store.range(fromSeq, toSeq)) {
    scanned++;
    for (const v of auditPayload(ev.payload))
      violations.push({ seq: ev.seq, eventType: ev.eventType, ...v });
  }
  return { scanned, violations };
}
