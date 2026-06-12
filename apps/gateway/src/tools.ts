import { randomUUID } from "node:crypto";
import { z } from "zod";
import postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import type { SecretStore } from "./secrets";
import { paymentsFor } from "./providers/payments";
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
  handler: (ctx: ToolContext, args: never) => Promise<unknown>;
}

type Registry = Record<string, Record<string, ToolDef>>;

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
          slug: c!.slug,
          name: args.name,
          priceCents: args.priceCents,
          currency: args.currency,
        });
        await ctx.sql`
          INSERT INTO products (id, company_id, name, price_cents, currency, provider_ref)
          VALUES (${productId}, ${ctx.companyId}, ${args.name}, ${args.priceCents}, ${args.currency}, ${providerRef})`;
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
        const [p] = await ctx.sql<{ provider_ref: string | null }[]>`
          SELECT provider_ref FROM products WHERE id = ${args.productId} AND company_id = ${ctx.companyId}`;
        if (!p) return { error: "not_found" };
        // Stripe links are stored in provider_ref; local links are deterministic.
        const url =
          p.provider_ref?.startsWith("stripe:")
            ? undefined
            : `${ctx.checkoutBase}/pay/${c!.slug}/${args.productId}`;
        return { url: url ?? `${ctx.checkoutBase}/pay/${c!.slug}/${args.productId}` };
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
};
