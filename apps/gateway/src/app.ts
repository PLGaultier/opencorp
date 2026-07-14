import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { z } from "zod";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { verifyToken } from "@opencorp/mcp-client";
import { registry, type ToolContext } from "./tools";
import { PgRateLimiter } from "@opencorp/ratelimit";
import { secretStoreFromEnv, infisicalEnv, InfisicalClient, InfisicalAdmin } from "./secrets";
import { makeBrowser } from "./providers/browser";
import { paymentsFor } from "./providers/payments";
import { recordPayment } from "./revenue";
import { processWithdrawal } from "./payout";
import { ensureConnectOnboarding } from "./connect";
import { metaConnectStart, metaConnectCallback } from "./meta-connect";
import { syncCompanyAdSpend, optimizeCompanyAds } from "./ads";
import { verifyStripeSignature, parseCheckoutCompleted, fetchStripeFeeCents } from "./providers/stripe-webhook";
import { creditWallet, activateSubscription, createBillingCheckout, localRef } from "./billing-checkout";
import { requestApproval, resolveApproval, notifyOwnerOfApproval } from "./approvals";

/**
 * MCP tool gateway (§7): every capability call from agents terminates here.
 * Pipeline per call: token scope check → rate limit (counts failures too) →
 * Zod validation → handler → audit to the transparency ledger.
 */

export function createGateway(opts?: {
  databaseUrl?: string;
  deploydUrl?: string;
  checkoutBase?: string;
  poolMax?: number;
}) {
  const databaseUrl =
    opts?.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgres://opencorp:opencorp@localhost:5432/opencorp";
  // Prod fronts Postgres with PgBouncer (§11.6); the pool size is tunable so a
  // single dev gateway can absorb a concurrency burst without starving sockets.
  const poolMax = opts?.poolMax ?? Number(process.env.GATEWAY_PG_POOL ?? 10);
  const sql = postgres(databaseUrl, { max: poolMax });
  const ledger = new Ledger(new PgStore(databaseUrl, poolMax));
  const limiter = new PgRateLimiter(sql);
  const secrets = secretStoreFromEnv();
  const browser = makeBrowser();
  // The gateway serves the local checkout page itself (it owns the DB + ledger
  // + recordPayment), so the default base is the gateway's own /checkout, not
  // deployd's. Stripe-mode links come from Stripe and ignore this entirely.
  const checkoutBase =
    opts?.checkoutBase ?? process.env.CHECKOUT_BASE_URL ?? "http://localhost:3004/checkout";

  // lazy per-company DB connections (PgBouncer takes over in prod)
  const companyDbs = new Map<string, postgres.Sql>();
  async function companyDb(companyId: string): Promise<postgres.Sql> {
    let db = companyDbs.get(companyId);
    if (!db) {
      const [c] = await sql<{ db_name: string }[]>`
        SELECT db_name FROM companies WHERE id = ${companyId}`;
      if (!c?.db_name) throw new Error("company db not provisioned");
      const u = new URL(databaseUrl);
      u.pathname = `/${c.db_name}`;
      db = postgres(u.toString(), { max: 2 });
      companyDbs.set(companyId, db);
    }
    return db;
  }

  // Build a tool execution context. Shared by the live /tools route and the
  // approval-resolution route (which re-runs a gated handler on owner approval).
  const buildCtx = (companyId: string, taskId: string): ToolContext => ({
    sql,
    companyId,
    taskId,
    companyDb,
    deploydUrl: opts?.deploydUrl ?? process.env.DEPLOYD_URL ?? "http://localhost:3002",
    ledger,
    secrets,
    checkoutBase,
    browser,
  });

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, service: "mcp-gateway" }));

  app.post("/tools/:server/:tool", async (c) => {
    const scope = verifyToken(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!scope) return c.json({ error: "unauthorized" }, 401);

    const { server, tool } = c.req.param();
    const def = registry[server]?.[tool];
    if (!def) return c.json({ error: "unknown_tool", server, tool }, 404);

    const limited = def.write ? await limiter.check(scope.companyId, tool) : null;
    if (limited) {
      await ledger.append({
        companyId: scope.companyId,
        actor: `worker:${scope.taskId}`,
        eventType: "tool_call",
        payload: { server, tool, outcome: "rate_limited" },
      });
      return c.json(limited, 429);
    }

    const parsed = def.schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    }

    // B3 — a paused company must not keep acting. Enforce it at the tool choke
    // point (not just at dispatch): pausing then halts an in-flight worker within
    // one step, with no external side effects, regardless of sandbox transport.
    // `should_stop` tells the worker loop to end cleanly instead of retrying.
    {
      const [comp] = await sql<{ status: string }[]>`
        SELECT status FROM companies WHERE id = ${scope.companyId}`;
      if (comp?.status === "paused") {
        return c.json(
          {
            error: "company_paused",
            should_stop: true,
            message: "The company is paused by its owner. Stop now; do not retry.",
          },
          409,
        );
      }
    }

    // Safety gate (§7.3): irreversible / money-out tools below autonomy_level=
    // full don't execute — they park as a pending approval and the agent moves
    // on. An owner approves it later (the gateway then runs the handler).
    // `bounded` is the middle ground (§14): a gated tool with a budgetGate runs
    // autonomously when it stays within the owner's cap, else parks like
    // `supervised`.
    if (def.gated) {
      const [comp] = await sql<{ autonomy_level: string }[]>`
        SELECT autonomy_level FROM companies WHERE id = ${scope.companyId}`;
      let allowed = comp?.autonomy_level === "full";
      if (!allowed && comp?.autonomy_level === "bounded" && def.budgetGate) {
        allowed = await def.budgetGate(buildCtx(scope.companyId, scope.taskId), parsed.data as never).catch(() => false);
      }
      if (!allowed) {
        const { approvalId, reused } = await requestApproval(sql, ledger, {
          companyId: scope.companyId,
          taskId: scope.taskId,
          server,
          tool,
          args: parsed.data,
        });
        // Email the owner out-of-band the first time an action is parked (a
        // retry reuses the request, so it doesn't re-notify). Never blocks the
        // agent's response.
        if (!reused) {
          await notifyOwnerOfApproval(sql, ledger, secrets, {
            companyId: scope.companyId,
            approvalId,
            server,
            tool,
          }).catch(() => {});
        }
        return c.json(
          {
            error: "approval_required",
            tool,
            approvalId,
            message: `${tool} is an irreversible action; it awaits human approval (id ${approvalId}). Do not wait; move on.`,
          },
          403,
        );
      }
    }

    const ctx = buildCtx(scope.companyId, scope.taskId);

    // Keep heavy/sensitive inputs (file contents, long commands) off the ledger.
    const auditArgs = def.summarizeArgs ? def.summarizeArgs(parsed.data as never) : parsed.data;
    try {
      const result = await def.handler(ctx, parsed.data as never);
      await ledger.append({
        companyId: scope.companyId,
        actor: `worker:${scope.taskId}`,
        eventType: "tool_call",
        payload: { server, tool, args: auditArgs, outcome: "ok" },
      });
      return c.json(result ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ledger.append({
        companyId: scope.companyId,
        actor: `worker:${scope.taskId}`,
        eventType: "tool_call",
        payload: { server, tool, args: auditArgs, outcome: "error", message },
      });
      return c.json({ error: "tool_failed", message }, 500);
    }
  });

  // Payment confirmation (§9.4, §10). In prod a Stripe webhook; in local mode
  // the dev checkout POSTs here when a customer "pays". Authenticated with an
  // HMAC of the raw body under GATEWAY_SECRET so it can't be spammed — the
  // platform (not the agent) signs it, keeping the company free of human action.
  const PaymentBody = z.object({
    companyId: z.string().uuid(),
    productId: z.string().uuid().nullable().default(null),
    amountCents: z.number().int().positive(),
    currency: z.string().min(3).max(3),
    providerRef: z.string().min(1),
    feeCents: z.number().int().min(0).optional(),
  });

  // Both money endpoints are signed by the platform (not agents) with an HMAC
  // of the raw body under GATEWAY_SECRET, so they cannot be spammed.
  const signedBody = (raw: string, sig: string): boolean => {
    const expected = createHmac("sha256", process.env.GATEWAY_SECRET ?? "dev-gateway-secret")
      .update(raw)
      .digest("hex");
    return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  };

  app.post("/webhooks/payment", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = PaymentBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    return c.json(await recordPayment(sql, ledger, parsed.data));
  });

  // Provision the external product for a starter (§6, §10). The founding worker
  // — not an agent — calls this, signed under GATEWAY_SECRET, so the company's
  // Stripe key stays server-side here. When the company has a Stripe key this
  // mints a real buy.stripe.com payment link (money then arrives only via the
  // signed /webhooks/stripe mirror); otherwise it returns the local checkout
  // link. It creates ONLY the external product — the worker owns the DB rows.
  const ProvisionProductBody = z.object({
    companyId: z.string().uuid(),
    productId: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1).max(200),
    priceCents: z.number().int().positive(),
    currency: z.enum(["eur", "usd", "gbp"]).default("eur"),
  });

  app.post("/internal/products/provision", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = ProvisionProductBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    const p = parsed.data;
    const provider = await paymentsFor(p.companyId, secrets, checkoutBase);
    const { providerRef, paymentLink } = await provider.createProduct({
      productId: p.productId,
      companyId: p.companyId,
      slug: p.slug,
      name: p.name,
      priceCents: p.priceCents,
      currency: p.currency,
    });
    return c.json({ providerRef, paymentLink, provider: provider.kind });
  });

  // ── Local checkout page (§10, MVP) ────────────────────────────────────────
  // In local mode the payment link points here. There's no real acquirer, so
  // this is the human-clickable "buy" page: GET renders it, POST records the
  // sale straight through recordPayment (in-process — no HMAC hop needed). This
  // is the only money path that touches a person; Stripe mode never hits it.
  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

  const checkoutPage = (opts: {
    title: string;
    company: string;
    body: string;
  }) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title} — ${opts.company}</title>
<style>
  :root{color-scheme:light dark}
  body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b0f;color:#e8e8ea}
  .card{background:#16161c;border:1px solid #26262e;border-radius:14px;padding:2rem;max-width:380px;width:90%}
  h1{font-size:1.1rem;margin:0 0 .25rem}
  .co{color:#8a8a92;font-size:.85rem;margin:0 0 1.5rem}
  .price{font-size:2rem;font-weight:700;margin:0 0 1.5rem}
  button{width:100%;padding:.85rem;border:0;border-radius:10px;background:#635bff;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#5249e0}
  .note{color:#6a6a72;font-size:.75rem;text-align:center;margin:1rem 0 0}
  .ok{color:#34d399;font-size:2.5rem;text-align:center;margin:0 0 .5rem}
</style></head><body><div class="card">${opts.body}</div></body></html>`;

  // Resolve a (slug, productId) to a payable product; shared by GET and POST.
  const resolveProduct = async (slug: string, productId: string) => {
    const [row] = await sql<
      { company_id: string; company_name: string; name: string; price_cents: string; currency: string }[]
    >`
      SELECT c.id AS company_id, c.name AS company_name, p.name, p.price_cents, p.currency
      FROM products p JOIN companies c ON c.id = p.company_id
      WHERE p.id = ${productId} AND c.slug = ${slug}`;
    return row ?? null;
  };

  // The ?c=<campaignId> tag rides from the ad creative's link through to the
  // payment row so revenue is attributed to the campaign that drove it (§14).
  const campaignTag = (c: { req: { query: (k: string) => string | undefined } }) => {
    const v = c.req.query("c");
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  };

  app.get("/checkout/pay/:slug/:productId", async (c) => {
    const { slug, productId } = c.req.param();
    const p = await resolveProduct(slug, productId);
    if (!p) return c.html(checkoutPage({ title: "Not found", company: "OpenCorp", body: `<h1>Product not found</h1>` }), 404);
    const price = money(Number(p.price_cents), p.currency);
    // Carry the campaign tag through the POST so attribution survives the click.
    const campaign = campaignTag(c);
    const action = campaign ? `?c=${campaign}` : "";
    // Per-page-load nonce: it rides in the form body so a double-submit / refresh
    // re-POSTs the SAME nonce and dedups (idempotent providerRef), while a fresh
    // page load mints a new nonce and is a genuinely new sale.
    const nonce = randomUUID();
    return c.html(
      checkoutPage({
        title: "Checkout",
        company: p.company_name,
        body: `<h1>${p.name}</h1><p class="co">${p.company_name}</p>
          <p class="price">${price}</p>
          <form method="post" action="${action}"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">Pay ${price}</button></form>
          <p class="note">Local checkout — no real card is charged.</p>`,
      }),
    );
  });

  app.post("/checkout/pay/:slug/:productId", async (c) => {
    const { slug, productId } = c.req.param();
    const p = await resolveProduct(slug, productId);
    if (!p) return c.html(checkoutPage({ title: "Not found", company: "OpenCorp", body: `<h1>Product not found</h1>` }), 404);
    // Only attribute to a campaign that actually belongs to this company.
    const tag = campaignTag(c);
    const campaignId = tag
      ? (await sql<{ id: string }[]>`SELECT id FROM ad_campaigns WHERE id = ${tag} AND company_id = ${p.company_id}`)[0]?.id ?? null
      : null;
    // The form's per-page-load nonce makes the sale idempotent: a refresh / double
    // submit re-POSTs the same nonce and recordPayment dedups on providerRef. A
    // direct POST without one falls back to a fresh uuid (no dedup, as before).
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const nonce = typeof body.nonce === "string" && /^[0-9a-f-]{36}$/i.test(body.nonce) ? body.nonce : randomUUID();
    const result = await recordPayment(sql, ledger, {
      companyId: p.company_id,
      productId,
      campaignId,
      amountCents: Number(p.price_cents),
      currency: p.currency,
      providerRef: `local:checkout:${slug}:${productId}:${nonce}`,
      feeCents: 0,
    });
    const price = money(Number(p.price_cents), p.currency);
    return c.html(
      checkoutPage({
        title: "Payment received",
        company: p.company_name,
        body: `<div class="ok">✓</div><h1>Payment received</h1>
          <p class="co">${p.company_name} — ${p.name}</p>
          <p class="price">${price}</p>
          <p class="note">${result.recorded ? "Recorded on the public ledger." : "Already recorded."}</p>`,
      }),
    );
  });

  // ── Wallet top-up (§10 pillar 1, Stage 2) ─────────────────────────────────
  // Local checkout for adding real money to the conglomerate wallet. With a
  // platform Stripe key this is bypassed (Stripe Checkout + webhook); offline it
  // mirrors the product checkout above.
  app.get("/checkout/topup/:conglomerateId/:amountCents", async (c) => {
    const amount = money(Number(c.req.param("amountCents")), "eur");
    return c.html(
      checkoutPage({
        title: "Top up",
        company: "OpenCorp",
        body: `<h1>Top up your wallet</h1><p class="co">Funds tasks at real API cost</p>
          <p class="price">${amount}</p>
          <form method="post"><button type="submit">Add ${amount}</button></form>
          <p class="note">Local checkout — no real card is charged.</p>`,
      }),
    );
  });

  app.post("/checkout/topup/:conglomerateId/:amountCents", async (c) => {
    const conglomerateId = c.req.param("conglomerateId");
    const amountCents = Number(c.req.param("amountCents"));
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return c.html(checkoutPage({ title: "Invalid", company: "OpenCorp", body: `<h1>Invalid amount</h1>` }), 400);
    }
    const { credited } = await creditWallet(sql, ledger, {
      conglomerateId,
      amountCents,
      ref: localRef("topup"),
      kind: "topup",
    });
    const amount = money(amountCents, "eur");
    return c.html(
      checkoutPage({
        title: "Wallet topped up",
        company: "OpenCorp",
        body: `<div class="ok">✓</div><h1>Wallet topped up</h1>
          <p class="price">${amount}</p>
          <p class="note">${credited ? "Added to your wallet on the ledger." : "Already recorded."}</p>`,
      }),
    );
  });

  // Create a checkout session (Stripe, or a local URL). Platform-signed: the
  // API authenticates the owner then forwards here (browser can't sign).
  const CheckoutBody = z.object({
    kind: z.enum(["topup", "subscription"]),
    conglomerateId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    allowanceCents: z.number().int().nonnegative().optional(),
    plan: z.string().optional(),
    label: z.string(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  });
  app.post("/admin/billing/checkout", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = CheckoutBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    const out = await createBillingCheckout(secrets, { ...parsed.data, checkoutBase });
    return c.json(out);
  });

  // ── Stripe webhook (§9.4, §10) ────────────────────────────────────────────
  // The real-money mirror. Stripe POSTs checkout.session.completed here; we
  // verify its signature against STRIPE_WEBHOOK_SECRET, map the session back to
  // our company/product (via the originating payment link, metadata as backup),
  // pull the real processing fee, and record it. Idempotent on the event id.
  app.post("/webhooks/stripe", async (c) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "stripe_webhook_not_configured" }, 503);
    const raw = await c.req.text();
    if (!verifyStripeSignature(raw, c.req.header("stripe-signature"), secret)) {
      return c.json({ error: "bad_signature" }, 401);
    }
    const checkout = parseCheckoutCompleted(JSON.parse(raw || "{}"));
    if (!checkout) return c.json({ ignored: true }); // 200 so Stripe stops retrying

    // Money-in to the wallet (§10 pillar 1, Stage 2) is keyed by our metadata,
    // distinct from product sales (which credit a company's real balance).
    if (checkout.metadata.kind === "topup" && checkout.metadata.conglomerateId) {
      return c.json(
        await creditWallet(sql, ledger, {
          conglomerateId: checkout.metadata.conglomerateId,
          amountCents: checkout.amountCents,
          ref: `stripe:evt:${checkout.eventId}`,
          kind: "topup",
        }),
      );
    }
    if (checkout.metadata.kind === "subscription" && checkout.metadata.conglomerateId) {
      return c.json(
        await activateSubscription(sql, ledger, {
          conglomerateId: checkout.metadata.conglomerateId,
          plan: checkout.metadata.plan ?? "builder",
          allowanceCents: Number(checkout.metadata.allowanceCents ?? 0),
          ref: `stripe:evt:${checkout.eventId}`,
        }),
      );
    }

    // Map the payment back to us: prefer the originating payment link
    // (provider_ref = stripe:{productId}:{linkId}), fall back to metadata.
    let companyId = checkout.metadata.companyId ?? null;
    let productId: string | null = checkout.metadata.productId ?? null;
    if (checkout.paymentLink) {
      const [row] = await sql<{ id: string; company_id: string }[]>`
        SELECT id, company_id FROM products
        WHERE provider_ref LIKE ${"stripe:%:" + checkout.paymentLink}`;
      if (row) {
        productId = row.id;
        companyId = row.company_id;
      }
    }
    if (!companyId) return c.json({ error: "unmapped_payment" }, 422);

    const key = await secrets.get(companyId, "STRIPE_SECRET_KEY");
    const feeCents = checkout.paymentIntent && key
      ? await fetchStripeFeeCents(checkout.paymentIntent, key)
      : 0;

    const result = await recordPayment(sql, ledger, {
      companyId,
      productId,
      amountCents: checkout.amountCents,
      currency: checkout.currency,
      providerRef: `stripe:evt:${checkout.eventId}`,
      feeCents,
    });
    return c.json(result);
  });

  // Money-out (§10). User-initiated from the dashboard; the durable Withdrawal
  // workflow calls this so retries are safe (idempotent on withdrawalId).
  const WithdrawBody = z.object({
    withdrawalId: z.string().uuid(),
    companyId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    currency: z.string().min(3).max(3).default("eur"),
  });

  app.post("/admin/withdraw", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = WithdrawBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);

    const [co] = await sql<{ conglomerate_id: string }[]>`
      SELECT conglomerate_id FROM companies WHERE id = ${parsed.data.companyId}`;
    if (!co) return c.json({ error: "company_not_found" }, 404);

    // A thrown error here is transient (Stripe 5xx / network): return 5xx so the
    // durable Withdrawal workflow retries. A terminal failure comes back as a
    // result with status 'failed' (422), which the workflow treats as final.
    try {
      const result = await processWithdrawal(sql, ledger, secrets, {
        ...parsed.data,
        conglomerateId: co.conglomerate_id,
      });
      return c.json(result, result.status === "failed" ? 422 : 200);
    } catch (err) {
      return c.json({ error: "withdraw_transient", message: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // Connect Express onboarding (§10). One connected account per conglomerate
  // (per owner) — KYC + bank account live on the human. Owner-initiated from
  // the dashboard; signed by the platform like the other admin routes. Returns
  // a one-time Stripe onboarding URL (or a local stub when Connect is off).
  const ConnectBody = z.object({
    conglomerateId: z.string().uuid(),
    returnUrl: z.string().url(),
    refreshUrl: z.string().url(),
  });

  app.post("/admin/connect/onboard", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = ConnectBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    try {
      return c.json(await ensureConnectOnboarding(sql, secrets, parsed.data));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "onboard_failed", message }, message === "conglomerate_not_found" ? 404 : 502);
    }
  });

  // Meta Ads connect (§14). Owner-initiated OAuth: `start` (signed like the
  // other admin routes) hands back the Facebook dialog URL; Facebook then
  // redirects the browser to the public `callback`, which exchanges the code,
  // links the ad account + Page, and writes the token to the vault. The
  // redirect URI must be byte-identical across both, so both resolve it from
  // META_OAUTH_REDIRECT_URI (falling back to this route's own origin).
  const metaRedirectUri = (c: { req: { url: string } }) =>
    process.env.META_OAUTH_REDIRECT_URI ?? `${new URL(c.req.url).origin}/connect/meta/callback`;

  app.post("/admin/connect/meta/start", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = z.object({ conglomerateId: z.string().uuid() }).safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    try {
      return c.json(await metaConnectStart(secrets, { conglomerateId: parsed.data.conglomerateId, redirectUri: metaRedirectUri(c) }));
    } catch (err) {
      return c.json({ error: "meta_start_failed", message: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/connect/meta/callback", async (c) => {
    // Where we bounce the owner's browser back to after linking (the dashboard).
    const returnBase = process.env.META_CONNECT_RETURN_URL ?? "/";
    const done = (params: Record<string, string>) =>
      c.redirect(`${returnBase}${returnBase.includes("?") ? "&" : "?"}${new URLSearchParams(params)}`);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return done({ meta: "error", reason: c.req.query("error_description") ?? "missing_code" });

    // Write the long-lived token to the conglomerate's vault folder — same
    // scope adsFor reads it from. Null when the vault backend is off (dev).
    const cfg = infisicalEnv();
    const saveToken = cfg
      ? async (conglomerateId: string, token: string) => {
          const admin = new InfisicalAdmin(new InfisicalClient(cfg));
          await admin.ensureCompanyFolder(conglomerateId);
          await admin.setCompanySecret(conglomerateId, "META_ACCESS_TOKEN", token);
        }
      : null;
    try {
      const r = await metaConnectCallback(sql, secrets, { code, state, redirectUri: metaRedirectUri(c) }, saveToken);
      return done({ meta: r.tokenStored ? "connected" : "linked", account: r.adAccountId, page: r.pageId });
    } catch (err) {
      return done({ meta: "error", reason: err instanceof Error ? err.message : String(err) });
    }
  });

  // Ad-spend sync + budget-cap auto-pause (§14). Called by the CompanyHeartbeat
  // activity each cycle; signed by the platform like the other admin routes.
  // Idempotent (upsert on campaign+day), so Temporal retries are safe.
  app.post("/admin/ads/sync", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = z.object({ companyId: z.string().uuid() }).safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    try {
      return c.json(await syncCompanyAdSpend(sql, ledger, secrets, parsed.data.companyId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "sync_failed", message }, message === "company_not_found" ? 404 : 502);
    }
  });

  // ROAS-driven budget reallocation (§14). Runs after the spend sync each
  // heartbeat: shifts budget toward campaigns earning revenue, away from those
  // that aren't — within the monthly cap. Signed like the other admin routes.
  app.post("/admin/ads/optimize", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = z.object({ companyId: z.string().uuid() }).safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    try {
      return c.json(await optimizeCompanyAds(sql, ledger, secrets, parsed.data.companyId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "optimize_failed", message }, message === "company_not_found" ? 404 : 502);
    }
  });

  // Set a per-company secret in the vault (§3). Owner-initiated from the
  // dashboard; signed by the platform (not agents) like the other admin routes.
  // The value is written to Infisical under /companies/{id} and never touches
  // the ledger payload (only the key name + a redaction marker, §9.3).
  const SecretBody = z.object({
    companyId: z.string().uuid(),
    key: z.string().min(1).max(128).regex(/^[A-Z0-9_]+$/, "key must be UPPER_SNAKE_CASE"),
    value: z.string().min(1).max(10_000),
  });

  app.post("/admin/secrets", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = SecretBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);

    const cfg = infisicalEnv();
    if (!cfg) return c.json({ error: "secrets_backend_unconfigured" }, 503);
    const [co] = await sql`SELECT 1 FROM companies WHERE id = ${parsed.data.companyId}`;
    if (!co) return c.json({ error: "company_not_found" }, 404);

    const admin = new InfisicalAdmin(new InfisicalClient(cfg));
    await admin.ensureCompanyFolder(parsed.data.companyId);
    await admin.setCompanySecret(parsed.data.companyId, parsed.data.key, parsed.data.value);
    await ledger.append({
      companyId: parsed.data.companyId,
      actor: "user",
      eventType: "secret_set",
      payload: { key: parsed.data.key, value: "[redacted]" },
    });
    return c.json({ ok: true, key: parsed.data.key });
  });

  // Resolve a pending approval (§7.3). Owner-initiated from the dashboard; the
  // API authenticates the owner and forwards here, signed by the platform like
  // the other admin routes. Approve runs the stored handler gateway-side.
  const ApprovalResolveBody = z.object({
    decision: z.enum(["approve", "reject"]),
    decidedBy: z.string().optional(),
  });

  app.post("/admin/approvals/:id/resolve", async (c) => {
    const raw = await c.req.text();
    if (!signedBody(raw, c.req.header("x-opencorp-sig") ?? "")) return c.json({ error: "bad_signature" }, 401);
    const parsed = ApprovalResolveBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    const out = await resolveApproval(sql, ledger, buildCtx, {
      id: c.req.param("id"),
      ...parsed.data,
    });
    if ("error" in out && out.error === "not_found") return c.json(out, 404);
    return c.json(out);
  });

  return { app, sql, ledger };
}
