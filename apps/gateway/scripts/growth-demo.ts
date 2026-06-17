/**
 * Closed-loop growth exit test (§14): an autonomous company attributes revenue
 * to its ad campaigns and reallocates budget by ROAS — scaling the winner up
 * and pausing the loser — all within the owner's monthly cap, on the ledger.
 *
 * Drives the real gateway against the live dev DB:
 *   1. bounded company, €100/month ad cap, one product
 *   2. launch two campaigns (within cap → auto-approved)
 *   3. record spend (ad sync), then simulate customers paying via the WINNER's
 *      tagged checkout link (?c=) — last-click attribution into payments
 *   4. optimize → winner's budget scales up, the loser (no revenue) is paused
 *   5. assert ROAS surfaces on the tools and ad_reallocation is on the chain
 *
 * Run with the dev stack up:  bun apps/gateway/scripts/growth-demo.ts
 * (Offline LocalAds mock + local checkout — no Meta/Stripe accounts needed.)
 */
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import { createGateway } from "../src/app";
import { signToken } from "@opencorp/mcp-client";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
const sql = postgres(DATABASE_URL, { max: 4 });

const CAP_CENTS = 10000; // €100/month — plenty of headroom to scale a winner
const BUDGET = 2000; // €20/day each
const PRICE = 1900; // €19 product
const SALES = 3; // 3 sales attributed to the winner → ROAS ≈ 3

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ── 1. provision a bounded company + product ──────────────────────────────
  const slug = `growthdemo-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo-user', 'Growth Demo Conglomerate', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, ad_monthly_budget_cap_cents, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'Pixel Press', 'Sell a polished digital wallpaper pack.',
            'active', 'bounded', ${CAP_CENTS}, ${`${slug}@opencorp.app`}, ${`${slug}.localhost`})
    RETURNING id`;
  await sql`INSERT INTO credit_entries (conglomerate_id, company_id, delta, reason)
            VALUES (${cg!.id}, ${co!.id}, '100', 'grant')`;
  const productId = randomUUID();
  await sql`
    INSERT INTO products (id, company_id, name, price_cents, currency, provider_ref, payment_link)
    VALUES (${productId}, ${co!.id}, 'Wallpaper Pack', ${PRICE}, 'eur', ${`local:${productId}`},
            ${`http://localhost:3004/checkout/pay/${slug}/${productId}`})`;
  console.log(`Provisioned bounded company ${slug}; ad cap €${(CAP_CENTS / 100).toFixed(0)}/mo`);

  // ── 2. gateway in-process ─────────────────────────────────────────────────
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const gatewayUrl = `http://localhost:${server.port}`;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, company_id, title, description, status)
            VALUES (${taskId}, ${co!.id}, 'Grow with ads', 'Run and optimize ad campaigns.', 'running')`;
  const token = signToken({ companyId: co!.id, taskId, exp: Math.floor(Date.now() / 1000) + 600 });

  const call = async (s: string, tool: string, args: unknown) => {
    const res = await fetch(`${gatewayUrl}/tools/${s}/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const signedPost = async (path: string) => {
    const raw = JSON.stringify({ companyId: co!.id });
    const sig = createHmac("sha256", GATEWAY_SECRET).update(raw).digest("hex");
    const res = await fetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencorp-sig": sig },
      body: raw,
    });
    return (await res.json()) as Record<string, number>;
  };

  // ── 3. launch two campaigns (within cap → bounded auto-approves) ──────────
  const mk = async (name: string) => {
    const c = await call("ads", "create_campaign", {
      productId, name, objective: "OUTCOME_SALES", budgetCents: BUDGET, budgetType: "daily",
      creative: { headline: "Beautiful 4K wallpapers", body: "30 hand-crafted wallpapers for €19." },
    });
    const id = c.body.campaignId as string;
    const l = await call("ads", "launch_campaign", { campaignId: id });
    ok(l.status === 200 && l.body.launched === true, `campaign "${name}" launched within cap`);
    return id;
  };
  const winner = await mk("Winner — converting audience");
  const loser = await mk("Loser — wrong audience");

  // ── 4. record spend, then attribute sales to the WINNER via its tag ───────
  const sync1 = await signedPost("/admin/ads/sync");
  ok(sync1.monthToDateCents > 0, `ad spend mirrored (€${(sync1.monthToDateCents / 100).toFixed(2)} month-to-date)`);

  // The winner's checkout link carries ?c=<winner>; paying it attributes the
  // sale to that campaign (last-click). The loser gets no sales.
  for (let i = 0; i < SALES; i++) {
    const res = await fetch(`${gatewayUrl}/checkout/pay/${slug}/${productId}?c=${winner}`, { method: "POST" });
    ok(res.ok, `customer ${i + 1} paid through the winner's ad (${res.status})`);
  }
  const [att] = await sql<{ n: string; rev: string }[]>`
    SELECT count(*) AS n, COALESCE(SUM(amount_cents),0) AS rev FROM payments WHERE campaign_id = ${winner}`;
  ok(Number(att!.n) === SALES, `${SALES} payments attributed to the winning campaign`);
  ok(Number(att!.rev) === PRICE * SALES, `attributed revenue is €${((PRICE * SALES) / 100).toFixed(2)}`);

  // ── 5. optimize → scale the winner up, pause the loser ────────────────────
  const opt = await signedPost("/admin/ads/optimize");
  ok(opt.reallocated >= 2, `optimizer reallocated ${opt.reallocated} budgets by ROAS`);

  const [w] = await sql<{ status: string; budget_cents: string }[]>`
    SELECT status, budget_cents FROM ad_campaigns WHERE id = ${winner}`;
  ok(w!.status === "active" && Number(w!.budget_cents) > BUDGET, `winner scaled up (€${(Number(w!.budget_cents) / 100).toFixed(0)}/day, still active)`);
  const [l] = await sql<{ status: string }[]>`SELECT status FROM ad_campaigns WHERE id = ${loser}`;
  ok(l!.status === "paused", "loser (no revenue) was auto-paused");

  // ── 6. ROAS surfaces on the read tools ────────────────────────────────────
  const list = (await call("ads", "list_campaigns", {})).body as unknown as { id: string; roas: number | null }[];
  const wRow = list.find((r) => r.id === winner)!;
  ok(wRow.roas !== null && wRow.roas >= 2, `list_campaigns shows the winner's ROAS (${wRow.roas}×)`);
  const insights = await call("ads", "get_campaign_insights", { campaignId: winner, rangeDays: 31 });
  const totals = insights.body.totals as { revenueCents: number; roas: number | null };
  ok(totals.revenueCents === PRICE * SALES, "get_campaign_insights reports attributed revenue");

  // ── 7. ledger transparency + chain integrity ──────────────────────────────
  const events = await sql<{ event_type: string }[]>`
    SELECT event_type FROM ledger_events WHERE company_id = ${co!.id} AND seq > ${seqBefore}`;
  const types = new Set(events.map((e) => e.event_type));
  for (const t of ["ad_campaign_launched", "ad_spend", "money_in", "ad_reallocation"])
    ok(types.has(t), `ledger has a ${t} event`);

  const verify = await ledger.verify(1);
  ok(verify.ok, `hash chain verifies (${verify.checked} events)`);

  server.stop();
  await sql.end();
  console.log("\nGROWTH exit test PASSED — revenue attributed, budget reallocated by ROAS, fully on the ledger.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
