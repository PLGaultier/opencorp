import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { z } from "zod";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { verifyToken } from "@opencorp/mcp-client";
import { registry, type ToolContext } from "./tools";
import { MemoryRateLimiter } from "./ratelimit";
import { secretStoreFromEnv, infisicalEnv, InfisicalClient, InfisicalAdmin } from "./secrets";
import { FetchBrowser } from "./providers/browser";
import { recordPayment } from "./revenue";
import { processWithdrawal } from "./payout";
import { requestApproval, resolveApproval } from "./approvals";

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

    const parsed = def.schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_input", detail: parsed.error.message }, 400);
    }

    // Safety gate (§7.3): irreversible / money-out tools below autonomy_level=
    // full don't execute — they park as a pending approval and the agent moves
    // on. An owner approves it later (the gateway then runs the handler).
    if (def.gated) {
      const [comp] = await sql<{ autonomy_level: string }[]>`
        SELECT autonomy_level FROM companies WHERE id = ${scope.companyId}`;
      if (comp?.autonomy_level !== "full") {
        const { approvalId } = await requestApproval(sql, ledger, {
          companyId: scope.companyId,
          taskId: scope.taskId,
          server,
          tool,
          args: parsed.data,
        });
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

    const result = await processWithdrawal(sql, ledger, secrets, {
      ...parsed.data,
      conglomerateId: co.conglomerate_id,
    });
    return c.json(result, result.status === "failed" ? 422 : 200);
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
