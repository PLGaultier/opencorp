import type postgres from "postgres";
import type { SecretStore } from "./secrets";

/**
 * Stripe Connect onboarding (§10). The platform owns one Stripe account; each
 * *conglomerate* (owner) gets one connected Express account — KYC and the
 * payout bank account live on the human, not the AI companies (which aren't
 * legal entities). Per-company revenue is split in our ledger via payment-link
 * metadata, never by separate Stripe accounts. The connected account id is a
 * plain identifier (not a secret), so it lives on the `conglomerates` row, not
 * the vault. Onboarding is idempotent: an existing account is reused.
 */

/** The platform Stripe key initiates Connect calls; one key for all accounts. */
const platformKey = (secrets: SecretStore) =>
  // "platform" is a sentinel scope with no per-scope override, so the store
  // returns the platform-wide default (§3 lookup order: scoped → default).
  secrets.get("platform", "STRIPE_SECRET_KEY");

async function stripe(
  key: string,
  path: string,
  form: Record<string, string>,
): Promise<{ id: string; [k: string]: unknown }> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const body = (await res.json()) as { id: string; error?: { message: string } };
  if (!res.ok) throw new Error(`stripe ${path} failed: ${body.error?.message ?? res.status}`);
  return body;
}

/** Has the connected account finished KYC (can it receive payouts)? */
async function accountDetailsSubmitted(key: string, accountId: string): Promise<boolean> {
  const res = await fetch(`https://api.stripe.com/v1/accounts/${accountId}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) return false;
  const acct = (await res.json()) as { details_submitted?: boolean };
  return Boolean(acct.details_submitted);
}

export interface OnboardRequest {
  conglomerateId: string;
  /** Where Stripe sends the owner after finishing / to retry onboarding. */
  returnUrl: string;
  refreshUrl: string;
}

export type OnboardResult =
  | { mode: "stripe"; accountId: string; onboardingUrl: string; detailsSubmitted: boolean }
  | { mode: "local"; accountId: null; onboardingUrl: null; message: string };

/**
 * Ensure the conglomerate has a Connect Express account and return a one-time
 * onboarding link for the owner to complete KYC. With no platform Stripe key
 * (the dev default), Connect is off and we return a local stub so the dashboard
 * still renders — withdrawals then use the local no-op payout rail.
 */
export async function ensureConnectOnboarding(
  sql: postgres.Sql,
  secrets: SecretStore,
  req: OnboardRequest,
): Promise<OnboardResult> {
  const key = await platformKey(secrets);
  if (!key) {
    return {
      mode: "local",
      accountId: null,
      onboardingUrl: null,
      message: "Stripe Connect is off (no platform STRIPE_SECRET_KEY); using local payout rail.",
    };
  }

  const [cg] = await sql<{ stripe_connect_account_id: string | null }[]>`
    SELECT stripe_connect_account_id FROM conglomerates WHERE id = ${req.conglomerateId}`;
  if (!cg) throw new Error("conglomerate_not_found");

  let accountId = cg.stripe_connect_account_id;
  if (!accountId) {
    const account = await stripe(key, "accounts", { type: "express" });
    accountId = account.id;
    await sql`UPDATE conglomerates SET stripe_connect_account_id = ${accountId}
              WHERE id = ${req.conglomerateId}`;
  }

  const link = await stripe(key, "account_links", {
    account: accountId,
    type: "account_onboarding",
    return_url: req.returnUrl,
    refresh_url: req.refreshUrl,
  });

  // Surface whether the account can already receive payouts (KYC complete).
  const detailsSubmitted = await accountDetailsSubmitted(key, accountId).catch(() => false);

  return { mode: "stripe", accountId, onboardingUrl: link.url as string, detailsSubmitted };
}

/** The conglomerate's connected-account id, or null if not yet onboarded. */
export async function connectAccountFor(
  sql: postgres.Sql,
  conglomerateId: string,
): Promise<string | null> {
  const [cg] = await sql<{ stripe_connect_account_id: string | null }[]>`
    SELECT stripe_connect_account_id FROM conglomerates WHERE id = ${conglomerateId}`;
  return cg?.stripe_connect_account_id ?? null;
}
