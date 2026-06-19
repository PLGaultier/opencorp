import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe webhook verification + parsing (§9.4, §10). We don't pull the Stripe
 * SDK — the payments provider already speaks Stripe over plain fetch, so we
 * verify the `Stripe-Signature` header by hand the same way `stripe.webhooks
 * .constructEvent` does: HMAC-SHA256 over `${timestamp}.${rawBody}` under the
 * endpoint's signing secret, compared in constant time, within a freshness
 * window so a captured payload can't be replayed indefinitely.
 */

const DEFAULT_TOLERANCE_SEC = 300; // Stripe's own default replay window

/** Parse a `Stripe-Signature` header (`t=...,v1=...,v1=...`). */
function parseSigHeader(header: string): { t: number; v1: string[] } {
  let t = 0;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, val] = part.split("=", 2);
    if (k === "t" && val) t = Number(val);
    else if (k === "v1" && val) v1.push(val);
  }
  return { t, v1 };
}

/**
 * True iff `header` is a valid signature for `payload` under `secret` and the
 * timestamp is within `toleranceSec`. `payload` MUST be the exact raw request
 * body (not re-serialized JSON) — a single byte of drift breaks the HMAC.
 */
export function verifyStripeSignature(
  payload: string,
  header: string | undefined | null,
  secret: string,
  opts?: { toleranceSec?: number; nowSec?: number },
): boolean {
  if (!header) return false;
  const { t, v1 } = parseSigHeader(header);
  if (!t || v1.length === 0) return false;

  const now = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts?.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - t) > tolerance) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const expectedBuf = Buffer.from(expected);
  // Any of the provided v1 signatures matching is acceptance (Stripe rotates).
  return v1.some(
    (sig) => sig.length === expected.length && timingSafeEqual(Buffer.from(sig), expectedBuf),
  );
}

/** The slice of a Stripe event we act on. */
export interface StripeCheckout {
  eventId: string;
  type: string;
  /** pl_... id of the originating payment link, if any (our company/product map). */
  paymentLink: string | null;
  amountCents: number;
  currency: string;
  /** companyId/productId if we stamped them onto the link/session metadata. */
  metadata: Record<string, string>;
  /** pi_... so we can fetch the real Stripe fee out-of-band. */
  paymentIntent: string | null;
}

/**
 * Extract what we need from a verified `checkout.session.completed` event.
 * Returns null for event types we don't mirror (so the endpoint can 200 and
 * let Stripe stop retrying).
 */
export function parseCheckoutCompleted(event: unknown): StripeCheckout | null {
  const e = event as {
    id?: string;
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  if (e.type !== "checkout.session.completed") return null;
  const s = e.data?.object ?? {};
  return {
    eventId: e.id ?? "",
    type: e.type,
    paymentLink: typeof s.payment_link === "string" ? s.payment_link : null,
    amountCents: typeof s.amount_total === "number" ? s.amount_total : 0,
    currency: typeof s.currency === "string" ? s.currency : "eur",
    metadata: (s.metadata as Record<string, string>) ?? {},
    paymentIntent: typeof s.payment_intent === "string" ? s.payment_intent : null,
  };
}

/**
 * Best-effort real processing fee for a PaymentIntent, in cents. Stripe doesn't
 * include the fee on the checkout event, so we follow PI → latest_charge →
 * balance_transaction. Any failure returns 0 (we still record gross revenue);
 * the fee is a refinement, never a blocker.
 */
export async function fetchStripeFeeCents(
  paymentIntentId: string,
  apiKey: string,
): Promise<number> {
  try {
    const get = async (path: string) => {
      const res = await fetch(`https://api.stripe.com/v1/${path}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    };
    const pi = await get(`payment_intents/${paymentIntentId}`);
    const chargeId = pi?.latest_charge as string | undefined;
    if (!chargeId) return 0;
    const charge = await get(`charges/${chargeId}`);
    const txnId = charge?.balance_transaction as string | undefined;
    if (!txnId) return 0;
    const txn = await get(`balance_transactions/${txnId}`);
    return typeof txn?.fee === "number" ? txn.fee : 0;
  } catch {
    return 0;
  }
}
