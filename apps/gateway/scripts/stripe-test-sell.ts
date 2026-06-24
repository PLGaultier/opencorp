/**
 * Stripe TEST-MODE end-to-end sale. Proves an autonomous company can actually
 * sell: it mints a *real* Stripe test product + payment link through the live
 * gateway (sk_test_…), then waits for you — the external customer — to pay it
 * with the test card 4242 4242 4242 4242. Stripe fires checkout.session
 * .completed → `stripe listen` forwards it to /webhooks/stripe → revenue is
 * mirrored to the company's real balance and the public ledger.
 *
 * Prereqs (all already done): OPENCORP_SECRET__STRIPE_SECRET_KEY=sk_test_… and
 * STRIPE_WEBHOOK_SECRET=whsec_… in .env, the app up (`bun run dev`), and
 * `stripe listen --forward-to localhost:3004/webhooks/stripe` running.
 *
 *   bun apps/gateway/scripts/stripe-test-sell.ts
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { signToken } from "@opencorp/mcp-client";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3004";
const PRICE_CENTS = 1900; // €19
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ── 1. provision a fresh demo company (full autonomy = no approval gates) ──
  const slug = `striptest-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('dev-user', 'Stripe Test Conglomerate', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'Pixel Press', 'Sell a polished digital wallpaper pack.',
            'active', 'full', ${`${slug}@opencorp.app`}, ${`${slug}.localhost`})
    RETURNING id`;
  await sql`INSERT INTO credit_entries (conglomerate_id, company_id, delta, reason)
            VALUES (${cg!.id}, ${co!.id}, '100', 'grant')`;
  console.log(`\nProvisioned company "${slug}" (${co!.id})`);

  // ── 2. the company creates a product over the LIVE gateway ────────────────
  // With OPENCORP_SECRET__STRIPE_SECRET_KEY set, paymentsFor() returns the real
  // Stripe provider → a genuine test product + payment link (pl_…).
  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, company_id, title, description, status)
            VALUES (${taskId}, ${co!.id}, 'Sell our first product', 'Stripe test-mode sale.', 'running')`;
  const token = signToken({ companyId: co!.id, taskId, exp: Math.floor(Date.now() / 1000) + 3600 });

  const res = await fetch(`${GATEWAY_URL}/tools/payments/create_product`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Aurora Wallpaper Pack", priceCents: PRICE_CENTS, currency: "eur" }),
  });
  const out = (await res.json()) as { productId?: string; paymentLink?: string; provider?: string; error?: string };
  ok(res.ok, `create_product accepted (${res.status})`);
  ok(out.provider === "stripe", `product minted on STRIPE (got "${out.provider}") — test key is live`);
  ok(out.paymentLink?.startsWith("https://"), "got a hosted Stripe payment link");

  console.log(`\n${"─".repeat(70)}`);
  console.log(`🛒  PAY THIS LINK to complete the sale (Stripe TEST mode):\n`);
  console.log(`    ${out.paymentLink}\n`);
  console.log(`    Card    4242 4242 4242 4242`);
  console.log(`    Expiry  any future date  ·  CVC  any 3 digits  ·  ZIP any`);
  console.log(`${"─".repeat(70)}\n`);
  console.log(`Waiting for the webhook to record the payment (Ctrl-C to abort)…`);

  // ── 3. poll for the money to land (Stripe webhook → recordPayment) ────────
  const deadline = Date.now() + 10 * 60_000; // 10 min
  for (;;) {
    const [pay] = await sql<{ amount_cents: string; fee_cents: string; net_cents: string; provider_ref: string }[]>`
      SELECT amount_cents, fee_cents, net_cents, provider_ref
      FROM payments WHERE company_id = ${co!.id} ORDER BY created_at DESC LIMIT 1`;
    if (pay) {
      console.log(`\n💸  Payment received!`);
      ok(Number(pay.amount_cents) === PRICE_CENTS, `gross = €${(Number(pay.amount_cents) / 100).toFixed(2)}`);
      console.log(`    fee  €${(Number(pay.fee_cents) / 100).toFixed(2)}  ·  net €${(Number(pay.net_cents) / 100).toFixed(2)}  ·  ref ${pay.provider_ref}`);

      const [c] = await sql<{ real_balance_cents: string }[]>`
        SELECT real_balance_cents FROM companies WHERE id = ${co!.id}`;
      ok(Number(c!.real_balance_cents) === Number(pay.net_cents),
        `company real balance credited net of fees (€${(Number(c!.real_balance_cents) / 100).toFixed(2)})`);

      const events = await sql<{ event_type: string }[]>`
        SELECT event_type FROM ledger_events WHERE company_id = ${co!.id}`;
      const types = new Set(events.map((e) => e.event_type));
      ok(types.has("product_created"), "ledger has product_created");
      ok(types.has("money_in"), "ledger has money_in");

      console.log(`\n✅ STRIPE TEST SALE PASSED — an autonomous company sold a product end-to-end on real Stripe rails.\n`);
      await sql.end();
      process.exit(0);
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for payment (10 min)");
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write(".");
  }
}

main().catch(async (err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
  await sql.end().catch(() => {});
  process.exit(1);
});
