import { randomUUID } from "node:crypto";
import { z } from "zod";
import postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import type { SecretStore } from "./secrets";
import { paymentsFor } from "./providers/payments";
import { adsFor, withinMonthlyCap } from "./providers/ads";
import { monthlyAdSpendCents } from "./ads";
import { emailFor, isValidAddress, listUnsubscribeHeader, syncInbox } from "./providers/email";
import { getAnalytics } from "./providers/analytics";
import { FetchBrowser } from "./providers/browser";

/**
 * Tool registry (§7.1): org, docs, db, web (M2) + payments, email, browser,
 * analytics, finance (M3). Each tool: Zod input schema + handler. The gateway
 * wraps every call with authz, rate limiting, safety gating, and ledger audit —
 * handlers only do the work and may append domain-specific ledger events.
 */

export interface ToolContext {
  sql: postgres.Sql; // control DB
  companyId: string;
  taskId: string;
  companyDb: (companyId: string) => Promise<postgres.Sql>;
  deploydUrl: string;
  ledger: Ledger;
  secrets: SecretStore;
  checkoutBase: string;
  browser: FetchBrowser;
}

export interface ToolDef {
  schema: z.ZodType;
  write: boolean;
  /** Irreversible / money-out action: requires autonomy_level=full (§7.3). */
  gated?: boolean;
  /**
   * Makes `bounded` autonomy meaningful for a gated tool (§14): when the company
   * is `bounded`, run this check — `true` auto-approves (within the owner's
   * budget cap), `false` parks for approval like `supervised`. `full` always
   * runs; `supervised` always parks. Omitted → `bounded` behaves like
   * `supervised` for this tool.
   */
  budgetGate?: (ctx: ToolContext, args: never) => Promise<boolean>;
  /**
   * Executed inside the worker's own sandbox, not here (§7.1 code-mcp). The
   * gateway still authorizes + rate-limits + audits the call; the handler only
   * grants permission and agentd runs it locally.
   */
  local?: boolean;
  /** Shrink the audited args (e.g. drop file contents from the ledger, §9.3). */
  summarizeArgs?: (args: never) => unknown;
  handler: (ctx: ToolContext, args: never) => Promise<unknown>;
}

type Registry = Record<string, Record<string, ToolDef>>;

/** Resolve a company's conglomerate + connected Meta ad account (for ads-mcp). */
async function adsContext(ctx: ToolContext): Promise<{ conglomerateId: string; metaAccount: string | null }> {
  const [c] = await ctx.sql<{ conglomerate_id: string; meta_ad_account_id: string | null }[]>`
    SELECT cm.conglomerate_id, cg.meta_ad_account_id
    FROM companies cm JOIN conglomerates cg ON cg.id = cm.conglomerate_id
    WHERE cm.id = ${ctx.companyId}`;
  return { conglomerateId: c!.conglomerate_id, metaAccount: c?.meta_ad_account_id ?? null };
}

/** True when this company's month-to-date ad spend + a new budget fits the cap. */
async function withinCapForBudget(ctx: ToolContext, budgetCents: number): Promise<boolean> {
  const [c] = await ctx.sql<{ ad_monthly_budget_cap_cents: string }[]>`
    SELECT ad_monthly_budget_cap_cents FROM companies WHERE id = ${ctx.companyId}`;
  const cap = Number(c?.ad_monthly_budget_cap_cents ?? 0);
  const spent = await monthlyAdSpendCents(ctx.sql, ctx.companyId);
  return withinMonthlyCap(spent, budgetCents, cap);
}

const TaskPatch = z.object({
  taskId: z.string().uuid(),
  status: z.enum(["pending", "queued", "deleted"]).optional(),
  priority: z.number().int().optional(),
  description: z.string().optional(),
});

export const registry: Registry = {
  org: {
    get_company_info: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        const [c] = await ctx.sql`
          SELECT name, slug, mission, status, daily_task_cap, subdomain, email_address
          FROM companies WHERE id = ${ctx.companyId}`;
        return c;
      },
    },
    read_mission: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        const [c] = await ctx.sql`SELECT mission FROM companies WHERE id = ${ctx.companyId}`;
        return c;
      },
    },
    update_mission: {
      schema: z.object({ mission: z.string().min(10).max(2000) }),
      write: true,
      async handler(ctx, args: z.infer<z.ZodObject<{ mission: z.ZodString }>>) {
        await ctx.sql`UPDATE companies SET mission = ${args.mission} WHERE id = ${ctx.companyId}`;
        return { updated: true };
      },
    },
    create_task: {
      schema: z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(5000).default(""),
        priority: z.number().int().default(0),
      }),
      write: true,
      async handler(ctx, args: { title: string; description: string; priority: number }) {
        const [t] = await ctx.sql<{ id: string }[]>`
          INSERT INTO tasks (company_id, title, description, status, priority)
          VALUES (${ctx.companyId}, ${args.title}, ${args.description}, 'queued', ${args.priority})
          RETURNING id`;
        return { taskId: t!.id };
      },
    },
    update_task: {
      schema: TaskPatch,
      write: true,
      async handler(ctx, args: z.infer<typeof TaskPatch>) {
        await ctx.sql`
          UPDATE tasks SET
            status = COALESCE(${args.status ?? null}, status),
            priority = COALESCE(${args.priority ?? null}, priority),
            description = COALESCE(${args.description ?? null}, description)
          WHERE id = ${args.taskId} AND company_id = ${ctx.companyId}
            AND status NOT IN ('running', 'done')`;
        return { updated: true };
      },
    },
    list_tasks: {
      schema: z.object({ status: z.string().optional() }),
      write: false,
      async handler(ctx, args: { status?: string }) {
        return ctx.sql`
          SELECT id, title, status, priority, result_summary, error, created_at
          FROM tasks WHERE company_id = ${ctx.companyId}
          ${args.status ? ctx.sql`AND status = ${args.status}` : ctx.sql``}
          ORDER BY priority DESC, created_at LIMIT 50`;
      },
    },
  },

  docs: {
    create_document: {
      schema: z.object({ title: z.string().min(1).max(200), content: z.string().max(100_000) }),
      write: true,
      async handler(ctx, args: { title: string; content: string }) {
        const [d] = await ctx.sql<{ id: string }[]>`
          INSERT INTO documents (company_id, title, content, created_by)
          VALUES (${ctx.companyId}, ${args.title}, ${args.content}, ${`worker:${ctx.taskId}`})
          RETURNING id`;
        return { documentId: d!.id };
      },
    },
    update_document: {
      schema: z.object({ documentId: z.string().uuid(), content: z.string().max(100_000) }),
      write: true,
      async handler(ctx, args: { documentId: string; content: string }) {
        await ctx.sql`
          UPDATE documents SET content = ${args.content}, updated_at = now()
          WHERE id = ${args.documentId} AND company_id = ${ctx.companyId}`;
        return { updated: true };
      },
    },
    list_documents: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        return ctx.sql`
          SELECT id, title, updated_at FROM documents
          WHERE company_id = ${ctx.companyId} ORDER BY updated_at DESC LIMIT 100`;
      },
    },
    read_document: {
      schema: z.object({ documentId: z.string().uuid() }),
      write: false,
      async handler(ctx, args: { documentId: string }) {
        const [d] = await ctx.sql`
          SELECT id, title, content FROM documents
          WHERE id = ${args.documentId} AND company_id = ${ctx.companyId}`;
        return d ?? { error: "not_found" };
      },
    },
    search_documents: {
      // keyword search for M2; pgvector similarity lands with the embedding worker
      schema: z.object({ query: z.string().min(1).max(200) }),
      write: false,
      async handler(ctx, args: { query: string }) {
        return ctx.sql`
          SELECT id, title, left(content, 300) AS excerpt FROM documents
          WHERE company_id = ${ctx.companyId} AND (title ILIKE ${"%" + args.query + "%"} OR content ILIKE ${"%" + args.query + "%"})
          ORDER BY updated_at DESC LIMIT 10`;
      },
    },
  },

  db: {
    get_schema: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        const db = await ctx.companyDb(ctx.companyId);
        return db`
          SELECT table_name, column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`;
      },
    },
    run_sql: {
      schema: z.object({ sql: z.string().min(1).max(10_000) }),
      write: false,
      async handler(ctx, args: { sql: string }) {
        const db = await ctx.companyDb(ctx.companyId);
        // read-only enforced server-side, not by prompt
        return db.begin(async (tx) => {
          await tx.unsafe("SET TRANSACTION READ ONLY");
          const rows = await tx.unsafe(args.sql);
          return rows.slice(0, 200);
        });
      },
    },
    execute_sql: {
      schema: z.object({ sql: z.string().min(1).max(10_000) }),
      write: true,
      async handler(ctx, args: { sql: string }) {
        const db = await ctx.companyDb(ctx.companyId);
        const rows = await db.unsafe(args.sql);
        return { rowCount: rows.length ?? 0 };
      },
    },
  },

  web: {
    deploy_site: {
      schema: z.object({
        files: z.record(z.string().max(500_000)).refine((f) => Object.keys(f).length <= 50, {
          message: "max 50 files",
        }),
      }),
      write: true,
      async handler(ctx, args: { files: Record<string, string> }) {
        const [c] = await ctx.sql<{ slug: string }[]>`
          SELECT slug FROM companies WHERE id = ${ctx.companyId}`;
        const res = await fetch(`${ctx.deploydUrl}/deploy/files`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: c!.slug, files: args.files }),
        });
        if (!res.ok) throw new Error(`deploy failed: ${res.status} ${await res.text()}`);
        const url = `http://${c!.slug}.${process.env.OPENCORP_DOMAIN ?? "localhost"}`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "deploy",
          payload: { kind: "site", files: Object.keys(args.files), url },
        });
        return { deployed: true, url };
      },
    },
    get_deploy_status: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        const [c] = await ctx.sql<{ slug: string; subdomain: string }[]>`
          SELECT slug, subdomain FROM companies WHERE id = ${ctx.companyId}`;
        return { live: true, url: `http://${c!.subdomain}` };
      },
    },
    set_custom_domain: {
      // gated (§7.3): a custom-domain change is hard to reverse and points DNS
      schema: z.object({ domain: z.string().min(3).max(253).regex(/^[a-z0-9.-]+$/i) }),
      write: true,
      gated: true,
      async handler(ctx, args: { domain: string }) {
        await ctx.sql`UPDATE companies SET custom_domain = ${args.domain} WHERE id = ${ctx.companyId}`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "deploy",
          payload: { kind: "custom_domain", domain: args.domain },
        });
        return { domain: args.domain, status: "pending_tls" };
      },
    },
  },

  // ── payments-mcp (§7.1, §10) ──────────────────────────────────────────────
  payments: {
    create_product: {
      schema: z.object({
        name: z.string().min(1).max(200),
        priceCents: z.number().int().min(50).max(100_000_000),
        currency: z.enum(["eur", "usd", "gbp"]).default("eur"),
      }),
      write: true,
      async handler(ctx, args: { name: string; priceCents: number; currency: "eur" | "usd" | "gbp" }) {
        const [c] = await ctx.sql<{ slug: string }[]>`
          SELECT slug FROM companies WHERE id = ${ctx.companyId}`;
        const productId = randomUUID();
        const provider = await paymentsFor(ctx.companyId, ctx.secrets, ctx.checkoutBase);
        const { providerRef, paymentLink } = await provider.createProduct({
          productId,
          companyId: ctx.companyId,
          slug: c!.slug,
          name: args.name,
          priceCents: args.priceCents,
          currency: args.currency,
        });
        await ctx.sql`
          INSERT INTO products (id, company_id, name, price_cents, currency, provider_ref, payment_link)
          VALUES (${productId}, ${ctx.companyId}, ${args.name}, ${args.priceCents}, ${args.currency}, ${providerRef}, ${paymentLink})`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "product_created",
          payload: { productId, name: args.name, priceCents: args.priceCents, currency: args.currency, provider: provider.kind },
        });
        return { productId, paymentLink, provider: provider.kind };
      },
    },
    delete_product: {
      schema: z.object({ productId: z.string().uuid() }),
      write: true,
      gated: true, // irreversible money-tool (§7.3)
      async handler(ctx, args: { productId: string }) {
        const [p] = await ctx.sql<{ provider_ref: string | null }[]>`
          SELECT provider_ref FROM products WHERE id = ${args.productId} AND company_id = ${ctx.companyId}`;
        if (!p) return { error: "not_found" };
        const provider = await paymentsFor(ctx.companyId, ctx.secrets, ctx.checkoutBase);
        if (p.provider_ref) await provider.deleteProduct(p.provider_ref);
        await ctx.sql`DELETE FROM products WHERE id = ${args.productId} AND company_id = ${ctx.companyId}`;
        return { deleted: true };
      },
    },
    list_products: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        return ctx.sql`
          SELECT id, name, price_cents, currency FROM products
          WHERE company_id = ${ctx.companyId} ORDER BY name`;
      },
    },
    get_payment_link: {
      schema: z.object({ productId: z.string().uuid() }),
      write: false,
      async handler(ctx, args: { productId: string }) {
        const [c] = await ctx.sql<{ slug: string }[]>`SELECT slug FROM companies WHERE id = ${ctx.companyId}`;
        const [p] = await ctx.sql<{ payment_link: string | null }[]>`
          SELECT payment_link FROM products WHERE id = ${args.productId} AND company_id = ${ctx.companyId}`;
        if (!p) return { error: "not_found" };
        // The stored link is authoritative (Stripe's buy.stripe.com URL, or the
        // local /checkout link). Older products predate the column → derive the
        // deterministic local link as a fallback.
        return { url: p.payment_link ?? `${ctx.checkoutBase}/pay/${c!.slug}/${args.productId}` };
      },
    },
    get_revenue: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        const [r] = await ctx.sql<{ gross: string; fees: string; net: string; count: string }[]>`
          SELECT COALESCE(SUM(amount_cents),0) AS gross, COALESCE(SUM(fee_cents),0) AS fees,
                 COALESCE(SUM(net_cents),0) AS net, count(*) AS count
          FROM payments WHERE company_id = ${ctx.companyId}`;
        const [c] = await ctx.sql<{ real_balance_cents: string }[]>`
          SELECT real_balance_cents FROM companies WHERE id = ${ctx.companyId}`;
        return {
          grossCents: Number(r!.gross),
          feeCents: Number(r!.fees),
          netCents: Number(r!.net),
          balanceCents: Number(c!.real_balance_cents),
          payments: Number(r!.count),
        };
      },
    },
  },

  // ── ads-mcp (§14 ads adapter) ─────────────────────────────────────────────
  // Budgeted Meta/Google campaigns. The provider bills the owner's payment
  // method directly; spend is mirrored to our ledger and bounded by the
  // company's monthly cap. Campaigns are created PAUSED; launch + budget raises
  // are money-out (gated): `bounded` auto-approves within the cap (budgetGate),
  // `supervised` parks for approval, `full` always runs (§7.3).
  ads: {
    create_campaign: {
      schema: z.object({
        productId: z.string().uuid(),
        name: z.string().min(1).max(200),
        objective: z.enum(["OUTCOME_SALES", "OUTCOME_TRAFFIC", "OUTCOME_AWARENESS", "OUTCOME_LEADS"]).default("OUTCOME_SALES"),
        budgetCents: z.number().int().min(100).max(100_000_000),
        budgetType: z.enum(["daily", "lifetime"]).default("daily"),
        creative: z.object({
          headline: z.string().min(1).max(200),
          body: z.string().min(1).max(2000),
          imageUrl: z.string().url().optional(),
        }),
      }),
      write: true,
      async handler(
        ctx,
        args: {
          productId: string;
          name: string;
          objective: string;
          budgetCents: number;
          budgetType: "daily" | "lifetime";
          creative: { headline: string; body: string; imageUrl?: string };
        },
      ) {
        const [p] = await ctx.sql<{ payment_link: string | null }[]>`
          SELECT payment_link FROM products WHERE id = ${args.productId} AND company_id = ${ctx.companyId}`;
        if (!p) return { error: "product_not_found" };
        const campaignId = randomUUID();
        const { conglomerateId, metaAccount } = await adsContext(ctx);
        const ads = await adsFor(conglomerateId, ctx.secrets, metaAccount);
        const linkUrl = p.payment_link ?? `${ctx.checkoutBase}/pay/${ctx.companyId}/${args.productId}`;
        const { providerRef } = await ads.createCampaign({
          campaignId,
          name: args.name,
          objective: args.objective,
          budgetCents: args.budgetCents,
          budgetType: args.budgetType,
          creative: { ...args.creative, linkUrl },
        });
        await ctx.sql`
          INSERT INTO ad_campaigns (id, company_id, product_id, provider, provider_ref, name, objective, status, budget_cents, budget_type, creative)
          VALUES (${campaignId}, ${ctx.companyId}, ${args.productId}, ${ads.kind}, ${providerRef},
                  ${args.name}, ${args.objective}, 'paused', ${args.budgetCents}, ${args.budgetType},
                  ${ctx.sql.json({ ...args.creative, linkUrl })})`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "ad_campaign_created",
          payload: { campaignId, productId: args.productId, objective: args.objective, budgetCents: args.budgetCents, budgetType: args.budgetType, provider: ads.kind },
        });
        return { campaignId, status: "paused", provider: ads.kind, note: "created paused — launch_campaign to go live (gated)" };
      },
    },
    set_budget: {
      schema: z.object({ campaignId: z.string().uuid(), budgetCents: z.number().int().min(100).max(100_000_000) }),
      write: true,
      gated: true, // money-out: a budget raise increases real spend
      async budgetGate(ctx, args: { campaignId: string; budgetCents: number }) {
        return withinCapForBudget(ctx, args.budgetCents);
      },
      async handler(ctx, args: { campaignId: string; budgetCents: number }) {
        const [c] = await ctx.sql<{ provider_ref: string | null; budget_type: "daily" | "lifetime" }[]>`
          SELECT provider_ref, budget_type FROM ad_campaigns WHERE id = ${args.campaignId} AND company_id = ${ctx.companyId}`;
        if (!c) return { error: "campaign_not_found" };
        const { conglomerateId, metaAccount } = await adsContext(ctx);
        const ads = await adsFor(conglomerateId, ctx.secrets, metaAccount);
        if (c.provider_ref) await ads.setBudget(c.provider_ref, args.budgetCents, c.budget_type);
        await ctx.sql`UPDATE ad_campaigns SET budget_cents = ${args.budgetCents} WHERE id = ${args.campaignId} AND company_id = ${ctx.companyId}`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "ad_budget_set",
          payload: { campaignId: args.campaignId, budgetCents: args.budgetCents },
        });
        return { updated: true, budgetCents: args.budgetCents };
      },
    },
    launch_campaign: {
      schema: z.object({ campaignId: z.string().uuid() }),
      write: true,
      gated: true, // money-out: PAUSED → ACTIVE starts spending
      async budgetGate(ctx, args: { campaignId: string }) {
        const [c] = await ctx.sql<{ budget_cents: string }[]>`
          SELECT budget_cents FROM ad_campaigns WHERE id = ${args.campaignId} AND company_id = ${ctx.companyId}`;
        return c ? withinCapForBudget(ctx, Number(c.budget_cents)) : false;
      },
      async handler(ctx, args: { campaignId: string }) {
        const [c] = await ctx.sql<{ provider_ref: string | null }[]>`
          SELECT provider_ref FROM ad_campaigns WHERE id = ${args.campaignId} AND company_id = ${ctx.companyId}`;
        if (!c) return { error: "campaign_not_found" };
        const { conglomerateId, metaAccount } = await adsContext(ctx);
        const ads = await adsFor(conglomerateId, ctx.secrets, metaAccount);
        if (c.provider_ref) await ads.launch(c.provider_ref);
        await ctx.sql`UPDATE ad_campaigns SET status = 'active', launched_at = now() WHERE id = ${args.campaignId} AND company_id = ${ctx.companyId}`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "ad_campaign_launched",
          payload: { campaignId: args.campaignId },
        });
        return { launched: true, status: "active" };
      },
    },
    pause_campaign: {
      schema: z.object({ campaignId: z.string().uuid() }),
      write: true, // always safe — pausing only ever reduces spend
      async handler(ctx, args: { campaignId: string }) {
        const [c] = await ctx.sql<{ provider_ref: string | null }[]>`
          SELECT provider_ref FROM ad_campaigns WHERE id = ${args.campaignId} AND company_id = ${ctx.companyId}`;
        if (!c) return { error: "campaign_not_found" };
        const { conglomerateId, metaAccount } = await adsContext(ctx);
        const ads = await adsFor(conglomerateId, ctx.secrets, metaAccount);
        if (c.provider_ref) await ads.pause(c.provider_ref);
        await ctx.sql`UPDATE ad_campaigns SET status = 'paused' WHERE id = ${args.campaignId} AND company_id = ${ctx.companyId}`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "ad_campaign_paused",
          payload: { campaignId: args.campaignId, reason: "manual" },
        });
        return { paused: true };
      },
    },
    list_campaigns: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        return ctx.sql`
          SELECT ac.id, ac.name, ac.objective, ac.status, ac.budget_cents, ac.budget_type, ac.product_id,
                 COALESCE((SELECT SUM(spend_cents) FROM ad_spend s WHERE s.campaign_id = ac.id), 0) AS spend_cents
          FROM ad_campaigns ac WHERE ac.company_id = ${ctx.companyId}
          ORDER BY ac.created_at DESC LIMIT 100`;
      },
    },
    get_campaign_insights: {
      schema: z.object({ campaignId: z.string().uuid(), rangeDays: z.number().int().min(1).max(90).default(30) }),
      write: false,
      async handler(ctx, args: { campaignId: string; rangeDays: number }) {
        const [c] = await ctx.sql<{ id: string }[]>`
          SELECT id FROM ad_campaigns WHERE id = ${args.campaignId} AND company_id = ${ctx.companyId}`;
        if (!c) return { error: "campaign_not_found" };
        const rows = await ctx.sql<{ day: string; spend_cents: string; impressions: string; clicks: string }[]>`
          SELECT day, spend_cents, impressions, clicks FROM ad_spend
          WHERE campaign_id = ${args.campaignId}
            AND day >= ${new Date(Date.now() - args.rangeDays * 86_400_000).toISOString().slice(0, 10)}
          ORDER BY day`;
        const totals = rows.reduce(
          (a, r) => ({ spendCents: a.spendCents + Number(r.spend_cents), impressions: a.impressions + Number(r.impressions), clicks: a.clicks + Number(r.clicks) }),
          { spendCents: 0, impressions: 0, clicks: 0 },
        );
        return { campaignId: args.campaignId, totals, daily: rows.map((r) => ({ day: r.day, spendCents: Number(r.spend_cents), impressions: Number(r.impressions), clicks: Number(r.clicks) })) };
      },
    },
  },

  // ── email-mcp (§7.1, §7.3 hygiene) ────────────────────────────────────────
  email: {
    send_email: {
      schema: z.object({
        to: z.array(z.string()).min(1).max(20),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(50_000),
        html: z.string().max(100_000).optional(),
      }),
      write: true,
      async handler(ctx, args: { to: string[]; subject: string; body: string; html?: string }) {
        const bad = args.to.filter((a) => !isValidAddress(a));
        if (bad.length) return { error: "invalid_recipient", addresses: bad };
        const [c] = await ctx.sql<{ email_address: string | null }[]>`
          SELECT email_address FROM companies WHERE id = ${ctx.companyId}`;
        const from = c?.email_address;
        if (!from) return { error: "company_has_no_mailbox" };

        // Per-recipient frequency cap (§7.3): max 3 messages / recipient / 24h.
        for (const rcpt of args.to) {
          const [n] = await ctx.sql<{ n: string }[]>`
            SELECT count(*) AS n FROM emails
            WHERE company_id = ${ctx.companyId} AND direction = 'out'
              AND ${rcpt} = ANY(to_addrs) AND created_at > now() - interval '24 hours'`;
          if (Number(n!.n) >= 3) return { error: "recipient_frequency_cap", recipient: rcpt };
        }

        const provider = await emailFor(ctx.companyId, ctx.secrets, from);
        const { messageId } = await provider.send({
          from,
          to: args.to,
          subject: args.subject,
          text: args.body,
          html: args.html,
          headers: listUnsubscribeHeader(from),
        });
        await ctx.sql`
          INSERT INTO emails (company_id, direction, from_addr, to_addrs, subject, body_text, body_html, jmap_id, read)
          VALUES (${ctx.companyId}, 'out', ${from}, ${args.to}, ${args.subject}, ${args.body}, ${args.html ?? null}, ${messageId}, true)`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "email_sent",
          payload: { to: args.to, subject: args.subject, transport: provider.kind },
        });
        return { sent: true, messageId, transport: provider.kind };
      },
    },
    reply_email: {
      schema: z.object({ emailId: z.string().uuid(), body: z.string().min(1).max(50_000) }),
      write: true,
      async handler(ctx, args: { emailId: string; body: string }) {
        const [orig] = await ctx.sql<{ from_addr: string; subject: string }[]>`
          SELECT from_addr, subject FROM emails
          WHERE id = ${args.emailId} AND company_id = ${ctx.companyId} AND direction = 'in'`;
        if (!orig) return { error: "not_found" };
        const [c] = await ctx.sql<{ email_address: string | null }[]>`
          SELECT email_address FROM companies WHERE id = ${ctx.companyId}`;
        const from = c?.email_address;
        if (!from) return { error: "company_has_no_mailbox" };
        const subject = orig.subject.startsWith("Re:") ? orig.subject : `Re: ${orig.subject}`;
        const provider = await emailFor(ctx.companyId, ctx.secrets, from);
        const { messageId } = await provider.send({
          from,
          to: [orig.from_addr],
          subject,
          text: args.body,
          headers: listUnsubscribeHeader(from),
        });
        await ctx.sql`
          INSERT INTO emails (company_id, direction, from_addr, to_addrs, subject, body_text, jmap_id, read)
          VALUES (${ctx.companyId}, 'out', ${from}, ${[orig.from_addr]}, ${subject}, ${args.body}, ${messageId}, true)`;
        await ctx.ledger.append({
          companyId: ctx.companyId,
          actor: `worker:${ctx.taskId}`,
          eventType: "email_sent",
          payload: { to: [orig.from_addr], subject, transport: provider.kind, inReplyTo: args.emailId },
        });
        return { sent: true, messageId };
      },
    },
    list_emails: {
      schema: z.object({ direction: z.enum(["in", "out"]).optional() }),
      write: false,
      async handler(ctx, args: { direction?: "in" | "out" }) {
        // Best-effort JMAP sync so agents always see fresh inbound mail; a
        // Stalwart hiccup degrades to the existing mirror, never blocks reads.
        await syncInbox(ctx.sql, ctx.ledger, ctx.secrets, ctx.companyId).catch(() => {});
        return ctx.sql`
          SELECT id, direction, from_addr, to_addrs, subject, read, created_at FROM emails
          WHERE company_id = ${ctx.companyId}
          ${args.direction ? ctx.sql`AND direction = ${args.direction}` : ctx.sql``}
          ORDER BY created_at DESC LIMIT 50`;
      },
    },
    read_email: {
      schema: z.object({ emailId: z.string().uuid() }),
      write: false,
      async handler(ctx, args: { emailId: string }) {
        await syncInbox(ctx.sql, ctx.ledger, ctx.secrets, ctx.companyId).catch(() => {});
        const [e] = await ctx.sql`
          SELECT id, direction, from_addr, to_addrs, subject, body_text, created_at FROM emails
          WHERE id = ${args.emailId} AND company_id = ${ctx.companyId}`;
        return e ?? { error: "not_found" };
      },
    },
    mark_email_read: {
      schema: z.object({ emailId: z.string().uuid() }),
      write: false,
      async handler(ctx, args: { emailId: string }) {
        await ctx.sql`UPDATE emails SET read = true WHERE id = ${args.emailId} AND company_id = ${ctx.companyId}`;
        return { updated: true };
      },
    },
    verify_email: {
      // best-effort MX/syntax probe; the DNS lookup is offline-tolerant
      schema: z.object({ address: z.string().min(3).max(254) }),
      write: true,
      async handler(_ctx, args: { address: string }) {
        if (!isValidAddress(args.address)) return { address: args.address, valid: false, reason: "syntax" };
        const domain = args.address.split("@")[1]!;
        try {
          const { resolveMx } = await import("node:dns/promises");
          const mx = await resolveMx(domain);
          return { address: args.address, valid: mx.length > 0, mx: mx.length };
        } catch {
          return { address: args.address, valid: true, reason: "mx_unresolved_offline" };
        }
      },
    },
  },

  // ── browser-mcp (§7.1, §8 egress) ─────────────────────────────────────────
  browser: {
    navigate: {
      schema: z.object({ url: z.string().url() }),
      write: false,
      async handler(ctx, args: { url: string }) {
        return ctx.browser.navigate(args.url);
      },
    },
    extract: {
      // navigate already returns extracted text; alias kept for the §7.1 surface
      schema: z.object({ url: z.string().url() }),
      write: false,
      async handler(ctx, args: { url: string }) {
        const { text, title } = await ctx.browser.navigate(args.url);
        return { title, text };
      },
    },
    submit_form: {
      schema: z.object({ url: z.string().url(), fields: z.record(z.string()) }),
      write: true,
      gated: true, // form submission can move money / send data (§7.3)
      async handler() {
        return { error: "not_supported", message: "Interactive browsing lands with the sandbox fleet (M4)." };
      },
    },
  },

  // ── analytics-mcp (§7.1) ──────────────────────────────────────────────────
  analytics: {
    get_analytics: {
      schema: z.object({ rangeDays: z.number().int().min(1).max(90).default(7) }),
      write: false,
      async handler(ctx, args: { rangeDays: number }) {
        const [c] = await ctx.sql<{ umami_site_id: string | null }[]>`
          SELECT umami_site_id FROM companies WHERE id = ${ctx.companyId}`;
        return getAnalytics(ctx.companyId, ctx.secrets, {
          siteId: c?.umami_site_id ?? null,
          rangeDays: args.rangeDays,
        });
      },
    },
  },

  // ── finance-mcp (§7.1, read-only to agents) ───────────────────────────────
  finance: {
    get_balance: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        const [c] = await ctx.sql<{ real_balance_cents: string; conglomerate_id: string }[]>`
          SELECT real_balance_cents, conglomerate_id FROM companies WHERE id = ${ctx.companyId}`;
        const [cr] = await ctx.sql<{ balance: string }[]>`
          SELECT COALESCE(SUM(delta),0) AS balance FROM credit_entries
          WHERE conglomerate_id = ${c!.conglomerate_id}`;
        return { realBalanceCents: Number(c!.real_balance_cents), credits: Number(cr!.balance) };
      },
    },
    get_credit_usage: {
      schema: z.object({}),
      write: false,
      async handler(ctx) {
        return ctx.sql`
          SELECT reason, COALESCE(SUM(delta),0) AS total, count(*) AS n
          FROM credit_entries WHERE company_id = ${ctx.companyId}
          GROUP BY reason`;
      },
    },
  },

  // ── code-mcp (§7.1) ───────────────────────────────────────────────────────
  // These run inside the worker's sandbox (agentd, §8), not here. The gateway
  // authorizes + rate-limits + audits each call (handlers just grant); agentd
  // executes against the sandbox filesystem/shell. `summarizeArgs` keeps file
  // contents and full command output off the public ledger (§9.3).
  code: {
    exec: {
      schema: z.object({ command: z.string().min(1).max(16_000), timeoutMs: z.number().int().positive().optional() }),
      write: true,
      local: true,
      summarizeArgs: (a: { command: string }) => ({ command: a.command.slice(0, 500) }),
      async handler() {
        return { authorized: true };
      },
    },
    write_file: {
      schema: z.object({ path: z.string().min(1).max(1024), content: z.string().max(1_000_000) }),
      write: true,
      local: true,
      summarizeArgs: (a: { path: string; content: string }) => ({ path: a.path, bytes: a.content.length }),
      async handler() {
        return { authorized: true };
      },
    },
    read_file: {
      schema: z.object({ path: z.string().min(1).max(1024) }),
      write: false,
      local: true,
      async handler() {
        return { authorized: true };
      },
    },
    list_files: {
      schema: z.object({ dir: z.string().max(1024).optional() }),
      write: false,
      local: true,
      async handler() {
        return { authorized: true };
      },
    },
    git_commit_push: {
      schema: z.object({ message: z.string().min(1).max(500) }),
      write: true,
      local: true,
      async handler() {
        return { authorized: true };
      },
    },
  },
};
