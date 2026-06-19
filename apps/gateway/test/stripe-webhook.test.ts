import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  verifyStripeSignature,
  parseCheckoutCompleted,
} from "../src/providers/stripe-webhook";

/** Build a valid Stripe-Signature header for a payload, the way Stripe does. */
function sign(payload: string, secret: string, t: number): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("stripe webhook signature (§9.4)", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const now = 1_700_000_000;

  test("accepts a correctly signed, fresh payload", () => {
    const header = sign(payload, secret, now);
    expect(verifyStripeSignature(payload, header, secret, { nowSec: now })).toBe(true);
  });

  test("rejects a tampered payload", () => {
    const header = sign(payload, secret, now);
    expect(verifyStripeSignature(payload + " ", header, secret, { nowSec: now })).toBe(false);
  });

  test("rejects the wrong secret", () => {
    const header = sign(payload, secret, now);
    expect(verifyStripeSignature(payload, header, "whsec_other", { nowSec: now })).toBe(false);
  });

  test("rejects a stale timestamp (replay outside tolerance)", () => {
    const header = sign(payload, secret, now - 10_000);
    expect(verifyStripeSignature(payload, header, secret, { nowSec: now })).toBe(false);
  });

  test("rejects a missing or malformed header", () => {
    expect(verifyStripeSignature(payload, undefined, secret, { nowSec: now })).toBe(false);
    expect(verifyStripeSignature(payload, "garbage", secret, { nowSec: now })).toBe(false);
  });
});

describe("stripe checkout parsing (§9.4)", () => {
  test("extracts amount, link, currency, metadata from a completed session", () => {
    const event = {
      id: "evt_123",
      type: "checkout.session.completed",
      data: {
        object: {
          payment_link: "plink_abc",
          amount_total: 1900,
          currency: "eur",
          payment_intent: "pi_xyz",
          metadata: { companyId: "co-1", productId: "p-1" },
        },
      },
    };
    const parsed = parseCheckoutCompleted(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.eventId).toBe("evt_123");
    expect(parsed!.paymentLink).toBe("plink_abc");
    expect(parsed!.amountCents).toBe(1900);
    expect(parsed!.currency).toBe("eur");
    expect(parsed!.paymentIntent).toBe("pi_xyz");
    expect(parsed!.metadata.companyId).toBe("co-1");
  });

  test("returns null for event types we don't mirror", () => {
    expect(parseCheckoutCompleted({ id: "evt_x", type: "payment_intent.created" })).toBeNull();
  });
});
