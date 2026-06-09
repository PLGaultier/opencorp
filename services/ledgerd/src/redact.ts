/**
 * Redaction pass (§9.3) — runs on every payload BEFORE it is hashed and
 * appended. Rules are intentionally simple and versioned with the repo;
 * the ruleset version is stamped into the payload so verifiers know what
 * was applied.
 */
import { createHash } from "node:crypto";

export const REDACTION_RULESET_VERSION = 1;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|authorization|bearer)/i;
const OWN_DOMAIN = process.env.OPENCORP_DOMAIN ?? "opencorp.app";

export function redact(payload: unknown): unknown {
  const cleaned = walk(payload);
  if (cleaned !== null && typeof cleaned === "object" && !Array.isArray(cleaned)) {
    return { ...cleaned, _redaction_v: REDACTION_RULESET_VERSION };
  }
  return cleaned;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : walk(v);
    }
    return out;
  }
  return value;
}

/** Third-party email addresses are hashed; our own per-company addresses stay. */
function redactString(s: string): string {
  return s.replace(EMAIL_RE, (addr) => {
    if (addr.toLowerCase().endsWith(`@${OWN_DOMAIN}`)) return addr;
    const digest = createHash("sha256").update(addr.toLowerCase()).digest("hex").slice(0, 12);
    return `email:${digest}`;
  });
}
