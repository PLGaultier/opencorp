import { createHash } from "node:crypto";

/**
 * Hash chain primitives (§9.1):
 *   hash = SHA-256(prev_hash ‖ canonical_json(payload) ‖ seq ‖ ts)
 * The genesis prev_hash is 32 zero bytes.
 */

export const GENESIS_HASH = new Uint8Array(32);

export interface LedgerEventInput {
  companyId: string | null;
  actor: string; // 'ceo' | 'worker:{taskId}' | 'system' | 'user'
  eventType: string;
  payload: unknown; // must already be redacted (§9.3)
}

export interface LedgerEvent extends LedgerEventInput {
  seq: number;
  createdAt: string; // ISO 8601, millisecond precision
  prevHash: Uint8Array;
  hash: Uint8Array;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function computeHash(
  prevHash: Uint8Array,
  payload: unknown,
  seq: number,
  createdAt: string,
): Uint8Array {
  const h = createHash("sha256");
  h.update(prevHash);
  h.update(canonicalJson(payload));
  h.update(String(seq));
  h.update(createdAt);
  return new Uint8Array(h.digest());
}

export function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  /** seq of the first corrupt event, if any */
  brokenAt?: number;
  reason?: "hash_mismatch" | "chain_broken" | "seq_gap";
}

/** Verify a contiguous slice of the chain. `prevHash` anchors the first event. */
export function verifyChain(
  events: Iterable<LedgerEvent>,
  anchor: Uint8Array = GENESIS_HASH,
): VerifyResult {
  let prev = anchor;
  let lastSeq: number | null = null;
  let checked = 0;
  for (const ev of events) {
    if (lastSeq !== null && ev.seq !== lastSeq + 1) {
      return { ok: false, checked, brokenAt: ev.seq, reason: "seq_gap" };
    }
    if (!hashesEqual(ev.prevHash, prev)) {
      return { ok: false, checked, brokenAt: ev.seq, reason: "chain_broken" };
    }
    const expected = computeHash(ev.prevHash, ev.payload, ev.seq, ev.createdAt);
    if (!hashesEqual(ev.hash, expected)) {
      return { ok: false, checked, brokenAt: ev.seq, reason: "hash_mismatch" };
    }
    prev = ev.hash;
    lastSeq = ev.seq;
    checked++;
  }
  return { ok: true, checked };
}
