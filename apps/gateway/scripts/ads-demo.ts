/**
 * Ads adapter exit test (§14, Phase 1): an autonomous company runs budgeted ad
 * campaigns end-to-end, fully on the ledger, with zero external accounts.
 *
 * Drives the real gateway against the live dev DB:
 *   1. provision a `bounded` company with a €50/month ad budget cap
 *   2. create a campaign (PAUSED) and launch it — `bounded` auto-approves
 *      because it's within the cap (the §7.3 budgetGate path)
 *   3. try to launch a second campaign whose budget exceeds the cap → it parks
 *      for owner approval (approval_required)
 *   4. seed a paused campaign's earlier-this-month spend, then run the spend
 *      sync → month-to-date crosses the cap → every active campaign auto-pauses
 *   5. assert the ledger has the ad_* events and the hash chain still verifies
 *
 * Run with the dev stack up:  bun apps/gateway/scripts/ads-demo.ts
 * (Uses the offline LocalAds mock — no META_ACCESS_TOKEN needed.)
 */
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import { createGateway } from "../src/app";
import { signToken } from "@opencorp/mcp-client";
import { monthStartDay } from "../src/providers/ads";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
const sql = postgres(DATABASE_URL, { max: 4 });

const CAP_CENTS = 5000; // €50/month
const A_BUDGET = 2000; // €20/day — within the cap, auto-approved
const B_BUDGET = 8000; // €80 — exceeds the cap, must park
const C_SEED = 4000; // €40 a paused campaign already spent this month

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ── 1. provision a fresh bounded company with an ad budget cap ────────────
  const slug = `adsdemo-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo-user', 'Ads Demo Conglomerate', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, ad_monthly_budget_cap_cents, email_address, subdomain)
    VALUES (${cg!.id}, ${slug}, 'Pixel Press', 'Sell a polished digital wallpaper pack.',
            'active', 'bounded', ${CAP_CENTS}, ${`${slug}@opencorp.app`}, ${`${slug}.localhost`})
    RETURNING id`;
  await sql`INSERT INTO credit_entries (conglomerate_id, company_id, delta, reason)
            VALUES (${cg!.id}, ${co!.id}, '100', 'grant')`;
  // A product to advertise.
  const productId = randomUUID();
  await sql`
    INSERT INTO products (id, company_id, name, price_cents, currency, provider_ref, payment_link)
    VALUES (${productId}, ${co!.id}, 'Wallpaper Pack', 1900, 'eur', ${`local:${productId}`},
            ${`http://localhost:3004/checkout/pay/${slug}/${productId}`})`;
  console.log(`Provisioned bounded company ${slug} (${co!.id}); ad cap €${(CAP_CENTS / 100).toFixed(0)}/mo`);

  // ── 2. gateway in-process against the live DB ─────────────────────────────
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const gatewayUrl = `http://localhost:${server.port}`;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, company_id, title, description, status)
            VALUES (${taskId}, ${co!.id}, 'Advertise the wallpaper pack', 'Run Meta ads within budget.', 'running')`;
  const token = signToken({ companyId: co!.id, taskId, exp: Math.floor(Date.now() / 1000) + 600 });

  const call = async (toolServer: string, tool: string, args: unknown) => {
    const res = await fetch(`${gatewayUrl}/tools/${toolServer}/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // ── 3. create + launch a campaign within the cap (bounded auto-approves) ───
  const createA = await call("ads", "create_campaign", {
    productId,
    name: "Wallpaper — summer push",
    objective: "OUTCOME_SALES",
    budgetCents: A_BUDGET,
    budgetType: "daily",
    creative: { headline: "Beautiful wallpapers", body: "30 hand-crafted 4K wallpapers for €19." },
  });
  ok(createA.status === 200 && createA.body.status === "paused", "campaign A created PAUSED");
  const campaignA = createA.body.campaignId as string;

  const launchA = await call("ads", "launch_campaign", { campaignId: campaignA });
  ok(launchA.status === 200 && launchA.body.launched === true, "campaign A launched (bounded auto-approved within cap)");
  const [aRow] = await sql<{ status: string }[]>`SELECT status FROM ad_campaigns WHERE id = ${campaignA}`;
  ok(aRow!.status === "active", "campaign A is active in the DB");

  // ── 4. a campaign whose budget exceeds the cap must park for approval ──────
  const createB = await call("ads", "create_campaign", {
    productId,
    name: "Wallpaper — big spend",
    objective: "OUTCOME_SALES",
    budgetCents: B_BUDGET,
    budgetType: "daily",
    creative: { headline: "Go big", body: "Massive reach." },
  });
  const campaignB = createB.body.campaignId as string;
  const launchB = await call("ads", "launch_campaign", { campaignId: campaignB });
  ok(launchB.status === 403 && launchB.body.error === "approval_required", "over-cap launch parks for owner approval");
  const [bRow] = await sql<{ status: string }[]>`SELECT status FROM ad_campaigns WHERE id = ${campaignB}`;
  ok(bRow!.status === "paused", "campaign B stayed PAUSED (not launched)");

  // ── 5. seed a paused campaign's earlier-this-month spend (€40) ────────────
  // It ran earlier this month and was paused; its spend still counts toward the
  // monthly cap. The sync only re-simulates ACTIVE campaigns, so this survives.
  const createC = await call("ads", "create_campaign", {
    productId,
    name: "Wallpaper — earlier run",
    objective: "OUTCOME_TRAFFIC",
    budgetCents: A_BUDGET,
    budgetType: "daily",
    creative: { headline: "Earlier", body: "Already ran this month." },
  });
  const campaignC = createC.body.campaignId as string;
  await sql`
    INSERT INTO ad_spend (company_id, campaign_id, day, spend_cents, impressions, clicks)
    VALUES (${co!.id}, ${campaignC}, ${monthStartDay()}, ${C_SEED}, 1200, 40)`;
  console.log(`  · seeded €${(C_SEED / 100).toFixed(0)} of earlier-this-month spend on a paused campaign`);

  // ── 6. spend sync → month-to-date crosses the cap → auto-pause ────────────
  const raw = JSON.stringify({ companyId: co!.id });
  const sig = createHmac("sha256", GATEWAY_SECRET).update(raw).digest("hex");
  const syncRes = await fetch(`${gatewayUrl}/admin/ads/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencorp-sig": sig },
    body: raw,
  });
  const sync = (await syncRes.json()) as { monthToDateCents: number; capCents: number; autoPaused: number };
  ok(syncRes.ok, `ad sync accepted (${syncRes.status})`);
  ok(sync.monthToDateCents >= CAP_CENTS, `month-to-date €${(sync.monthToDateCents / 100).toFixed(2)} ≥ cap €${(CAP_CENTS / 100).toFixed(0)}`);
  ok(sync.autoPaused >= 1, `auto-paused ${sync.autoPaused} active campaign(s) at the cap`);
  const [aAfter] = await sql<{ status: string }[]>`SELECT status FROM ad_campaigns WHERE id = ${campaignA}`;
  ok(aAfter!.status === "paused", "campaign A was auto-paused");

  // ── 7. insights + listing reflect the spend ───────────────────────────────
  const insights = await call("ads", "get_campaign_insights", { campaignId: campaignA, rangeDays: 31 });
  const totals = insights.body.totals as { spendCents: number };
  ok(totals.spendCents > 0, `campaign A insights show spend (€${(totals.spendCents / 100).toFixed(2)})`);
  const list = await call("ads", "list_campaigns", {});
  ok(Array.isArray(list.body) && (list.body as unknown[]).length === 3, "list_campaigns returns all three campaigns");

  // ── 8. ledger transparency + chain integrity ──────────────────────────────
  const events = await sql<{ event_type: string }[]>`
    SELECT event_type FROM ledger_events WHERE company_id = ${co!.id} AND seq > ${seqBefore}`;
  const types = new Set(events.map((e) => e.event_type));
  for (const t of ["ad_campaign_created", "ad_campaign_launched", "ad_spend", "ad_campaign_paused", "ad_budget_exceeded"])
    ok(types.has(t), `ledger has a ${t} event`);

  const verify = await ledger.verify(1);
  ok(verify.ok, `hash chain verifies (${verify.checked} events)`);

  server.stop();
  await sql.end();
  console.log("\nADS exit test PASSED — budgeted campaigns ran end-to-end, auto-paused at the cap, fully on the ledger.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
