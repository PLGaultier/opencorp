import { randomUUID } from "node:crypto";
import type { SecretStore } from "../secrets";

/**
 * Payments arm (§7.1 payments-mcp, §10). `PaymentsProvider` is the external
 * acquirer seam: Stripe in prod, a local DB-backed checkout in dev. The DB
 * (`products`/`payments`) and the credit/ledger are always the source of truth
 * for revenue — providers only mint products and payment links and (for Stripe)
 * verify the customer actually paid. Selection is per company: a company with a
 * `STRIPE_SECRET_KEY` secret uses Stripe; everyone else uses local mode, so the
 * "sell a product end-to-end" exit test runs with no Stripe account.
 */
export interface NewProduct {
  productId: string;
  slug: string;
  name: string;
  priceCents: number;
  currency: string;
}

export interface PayoutRequest {
  amountCents: number;
  currency: string;
  /** Stripe Connect account id (acct_...) for the destination; null in local mode. */
  destination: string | null;
}

export interface PaymentsProvider {
  readonly kind: "stripe" | "local";
  /** Create the external product + a reusable payment link. */
  createProduct(p: NewProduct): Promise<{ providerRef: string; paymentLink: string }>;
  /** Deactivate the external product (gated tool — see §7.3). */
  deleteProduct(providerRef: string): Promise<void>;
  /** Move funds out to a connected account (§10 withdrawals; money-out). */
  payout(req: PayoutRequest): Promise<{ transferId: string }>;
}

// ── Local (dev / self-host without Stripe) ─────────────────────────────────
class LocalPayments implements PaymentsProvider {
  readonly kind = "local";
  constructor(private checkoutBase: string) {}

  async createProduct(p: NewProduct) {
    // The dev checkout URL is handled by deployd; paying it POSTs the webhook.
    const paymentLink = `${this.checkoutBase}/pay/${p.slug}/${p.productId}`;
    return { providerRef: `local:${p.productId}`, paymentLink };
  }

  async deleteProduct(): Promise<void> {
    /* nothing external to deactivate */
  }

  async payout(): Promise<{ transferId: string }> {
    // No real banking rail in dev; the ledger + withdrawals row are the record.
    return { transferId: `local-payout:${randomUUID()}` };
  }
}

// ── Stripe (real acquirer) ─────────────────────────────────────────────────
class StripePayments implements PaymentsProvider {
  readonly kind = "stripe";
  constructor(private key: string) {}

  async createProduct(p: NewProduct) {
    const product = await this.call("products", { name: p.name });
    const price = await this.call("prices", {
      product: product.id,
      unit_amount: String(p.priceCents),
      currency: p.currency,
    });
    const link = await this.call("payment_links", {
      "line_items[0][price]": price.id,
      "line_items[0][quantity]": "1",
    });
    return { providerRef: `stripe:${product.id}:${link.id}`, paymentLink: link.url as string };
  }

  async deleteProduct(providerRef: string) {
    const productId = providerRef.split(":")[1];
    if (productId) await this.call(`products/${productId}`, { active: "false" });
  }

  async payout(req: PayoutRequest) {
    if (!req.destination) throw new Error("stripe payout needs a connected account (STRIPE_CONNECT_ACCOUNT)");
    const transfer = await this.call("transfers", {
      amount: String(req.amountCents),
      currency: req.currency,
      destination: req.destination,
    });
    return { transferId: `stripe:${transfer.id}` };
  }

  private async call(path: string, form: Record<string, string>): Promise<{ id: string; [k: string]: unknown }> {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
    });
    const body = (await res.json()) as { id: string; error?: { message: string } };
    if (!res.ok) throw new Error(`stripe ${path} failed: ${body.error?.message ?? res.status}`);
    return body;
  }
}

export async function paymentsFor(
  companyId: string,
  secrets: SecretStore,
  checkoutBase: string,
): Promise<PaymentsProvider> {
  const key = await secrets.get(companyId, "STRIPE_SECRET_KEY");
  return key ? new StripePayments(key) : new LocalPayments(checkoutBase);
}
