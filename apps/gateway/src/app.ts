import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { z } from "zod";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { verifyToken } from "@opencorp/mcp-client";
import { registry, type ToolContext } from "./tools";
import { MemoryRateLimiter } from "./ratelimit";
import { secretStoreFromEnv } from "./secrets";
import { FetchBrowser } from "./providers/browser";
import { recordPayment } from "./revenue";

/**
 * MCP tool gateway (§7): every capability call from agents terminates here.
 * Pipeline per call: token scope check → rate limit (counts failures too) →
 * Zod validation → handler → audit to the transparency ledger.
 */

export function createGateway(opts?: {
  databaseUrl?: string;
  deploydUrl?: string;
  checkoutBase?: string;
}) {
  const databaseUrl =
    opts?.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgres://opencorp:opencorp@localhost:5432/opencorp";
  const sql = postgres(databaseUrl, { max: 10 });
  const ledger = new Ledger(new PgStore(databaseUrl));
  const limiter = new MemoryRateLimiter();
  const secrets = secretStoreFromEnv();
  const browser = new FetchBrowser();
  const checkoutBase =
    opts?.checkoutBase ?? process.env.CHECKOUT_BASE_URL ?? "http://localhost:3002/checkout";

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

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, service: "mcp-gateway" }));

  app.post("/tools/:server/:tool", async (c) => {
    const scope = verifyToken(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!scope) return c.json({ error: "unauthorized" }, 401);

    const { server, tool } = c.req.param();
    const def = registry[server]?.[tool];
    if (!def) return c.json({ error: "unknown_tool", server, tool }, 404);

    const limited = def.write ? limiter.check(scope.companyId, tool) : null;
    if (limited) {
      await ledger.append({
        companyId: scope.companyId,
        actor: `worker:${scope.taskId}`,
        eventType: "tool_call",
        payload: { server, tool, outcome: "rate_limited" },
      });
      return c.json(limited, 429);
    }

    // Safety gate (§7.3): irreversible / money-out tools need autonomy_level=full
    // (or a human approval signal, which lands with the dashboard in M4).
    if (def.gated) {
      const [comp] = await sql<{ autonomy_level: string }[]>`
        SELECT autonomy_level FROM companies WHERE id = ${scope.companyId}`;
      if (comp?.autonomy_level !== "full") {
        await ledger.append({
          companyId: scope.companyId,
          actor: `worker:${scope.taskId}`,
          eventType: "tool_call",
          payload: { server, tool, outcome: "approval_required" },
        });
        return c.json(
          {
            error: "approval_required",
            tool,
            message: `${tool} is an irreversible action; it requires human approval unless autonomy_level=full.`,
          },
          403,
        );
      }
    }

    const parsed = def.schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    }

    const ctx: ToolContext = {
      sql,
      companyId: scope.companyId,
      taskId: scope.taskId,
      companyDb,
      deploydUrl: opts?.deploydUrl ?? process.env.DEPLOYD_URL ?? "http://localhost:3002",
      ledger,
      secrets,
      checkoutBase,
      browser,
    };

    try {
      const result = await def.handler(ctx, parsed.data as never);
      await ledger.append({
        companyId: scope.companyId,
        actor: `worker:${scope.taskId}`,
        eventType: "tool_call",
        payload: { server, tool, args: parsed.data, outcome: "ok" },
      });
      return c.json(result ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ledger.append({
        companyId: scope.companyId,
        actor: `worker:${scope.taskId}`,
        eventType: "tool_call",
        payload: { server, tool, args: parsed.data, outcome: "error", message },
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

  app.post("/webhooks/payment", async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header("x-opencorp-sig") ?? "";
    const expected = createHmac("sha256", process.env.GATEWAY_SECRET ?? "dev-gateway-secret")
      .update(raw)
      .digest("hex");
    const ok =
      sig.length === expected.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return c.json({ error: "bad_signature" }, 401);

    const parsed = PaymentBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);

    const result = await recordPayment(sql, ledger, parsed.data);
    return c.json(result);
  });

  return { app, sql, ledger };
}
