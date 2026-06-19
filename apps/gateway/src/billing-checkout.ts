import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import type { SecretStore } from "./secrets";

/**
 * Money-in to the conglomerate wallet (§10 pillar 1, Stage 2). Two flows:
 *   • top-up  — a one-off purchase that adds cents to the wallet.
 *   • subscription — a recurring plan that grants a monthly cents allowance.
 *
 * Both credit `credit_entries` (the wallet that pays for tasks at real API cost),
 * which is distinct from a company's `real_balance_cents` (earned revenue). With
 * a platform Stripe key we create a Checkout Session and credit on the webhook;
 * without one we hand back a local checkout URL so the flow runs fully offline.
 * All credits are idempotent on a `ref` stored in the entry's meta.
 */

async function stripe(
  key: string,
  path: string,
  form: Record<string, string>,
): Promise<{ id: string; [k: string]: unknown }> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = (await res.json()) as { id: string; error?: { message: string } };
  if (!res.ok) throw new Error(`stripe ${path} failed: ${body.error?.message ?? res.status}`);
  return body;
}

/** Add cents to a conglomerate's wallet, idempotent on `ref`. */
export async function creditWallet(
  sql: postgres.Sql,
  ledger: Ledger,
  p: { conglomerateId: string; amountCents: number; ref: string; kind: "topup" | "subscription"; plan?: string },
): Promise<{ credited: boolean }> {
  const existing = await sql`SELECT 1 FROM credit_entries WHERE meta->>'ref' = ${p.ref}`;
  if (existing.length) return { credited: false };
  await sql`
    INSERT INTO credit_entries (conglomerate_id, delta, reason, meta)
    VALUES (${p.conglomerateId}, ${p.amountCents}, 'grant',
            ${sql.json({ kind: p.kind, ref: p.ref, ...(p.plan ? { plan: p.plan } : {}) })})`;
  await ledger.append({
    companyId: null,
    actor: "system",
    eventType: "credit_change",
    payload: { conglomerateId: p.conglomerateId, delta: p.amountCents, reason: "grant", kind: p.kind, ...(p.plan ? { plan: p.plan } : {}) },
  });
  return { credited: true };
}

/** Activate (or switch) a Stripe-paid subscription and grant its allowance. */
export async function activateSubscription(
  sql: postgres.Sql,
  ledger: Ledger,
  p: { conglomerateId: string; plan: string; allowanceCents: number; ref: string },
): Promise<{ activated: boolean }> {
  const existing = await sql`SELECT 1 FROM credit_entries WHERE meta->>'ref' = ${p.ref}`;
  if (existing.length) return { activated: false };
  await sql`
    INSERT INTO subscriptions (conglomerate_id, plan, status, current_period_start)
    VALUES (${p.conglomerateId}, ${p.plan}, 'active', now())
    ON CONFLICT (conglomerate_id) DO UPDATE SET
      plan = EXCLUDED.plan, status = 'active', current_period_start = EXCLUDED.current_period_start`;
  await creditWallet(sql, ledger, { conglomerateId: p.conglomerateId, amountCents: p.allowanceCents, ref: p.ref, kind: "subscription", plan: p.plan });
  return { activated: true };
}

export interface CheckoutRequest {
  kind: "topup" | "subscription";
  conglomerateId: string;
  amountCents: number; // top-up amount, or the plan's monthly price
  allowanceCents?: number; // subscription only — wallet allowance granted per cycle
  plan?: string; // subscription only
  label: string; // shown on the Stripe/local checkout
  successUrl: string;
  cancelUrl: string;
  checkoutBase: string; // gateway local checkout base, e.g. http://localhost:3004/checkout
}

/**
 * Start a checkout. With a platform Stripe key → a Stripe Checkout Session;
 * otherwise a local checkout URL the gateway serves itself. The grant happens
 * later (Stripe webhook, or the local checkout POST).
 */
export async function createBillingCheckout(
  secrets: SecretStore,
  req: CheckoutRequest,
): Promise<{ mode: "stripe" | "local"; url: string }> {
  const key = await secrets.get("platform", "STRIPE_SECRET_KEY");
  if (!key) {
    // Local top-ups get a gateway-served checkout page; local subscriptions are
    // granted immediately by the API (no redirect), so no URL is needed.
    const local =
      req.kind === "topup" ? `${req.checkoutBase}/topup/${req.conglomerateId}/${req.amountCents}` : "";
    return { mode: "local", url: local };
  }
  const form: Record<string, string> = {
    mode: req.kind === "subscription" ? "subscription" : "payment",
    success_url: req.successUrl,
    cancel_url: req.cancelUrl,
    "metadata[kind]": req.kind,
    "metadata[conglomerateId]": req.conglomerateId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][unit_amount]": String(req.amountCents),
    "line_items[0][price_data][product_data][name]": req.label,
  };
  if (req.kind === "subscription") {
    form["line_items[0][price_data][recurring][interval]"] = "month";
    form["metadata[plan]"] = req.plan ?? "";
    form["metadata[allowanceCents]"] = String(req.allowanceCents ?? 0);
    form["subscription_data[metadata][kind]"] = "subscription";
    form["subscription_data[metadata][conglomerateId]"] = req.conglomerateId;
    form["subscription_data[metadata][plan]"] = req.plan ?? "";
    form["subscription_data[metadata][allowanceCents]"] = String(req.allowanceCents ?? 0);
  }
  const session = await stripe(key, "checkout/sessions", form);
  return { mode: "stripe", url: (session.url as string) ?? "" };
}

/** A stable ref for a one-off local checkout submit. */
export const localRef = (kind: string) => `local:${kind}:${randomUUID()}`;
