/**
 * Out-of-band approval notification exit test (§7.3): when an agent parks a
 * gated action, the owner is emailed at their account address via Stalwart —
 * not only shown the in-app brief. Requires the dev stack with Stalwart:
 *
 *   docker compose -f infra/compose/docker-compose.dev.yml up -d postgres stalwart
 *   bun apps/gateway/scripts/approval-notify-demo.ts
 */
process.env.STALWART_URL ??= "http://localhost:8081";
process.env.MAIL_DOMAIN ??= "opencorp.dev"; // real PSL TLD (Stalwart rejects .test/.local)

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { signToken } from "@opencorp/mcp-client";
import {
  StalwartAdmin,
  StalwartJmapClient,
  deriveMailboxPassword,
  stalwartEnv,
} from "@opencorp/stalwart";
import { createGateway } from "../src/app";
import { provisionMailbox } from "../../../workflows/src/activities";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
async function until<T>(fn: () => Promise<T>, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null as T);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const cfg = stalwartEnv()!;
  const admin = new StalwartAdmin(cfg.url, cfg.adminUser, cfg.adminSecret);
  await admin.ensureDomain(cfg.domain);

  // ── owner: a real user row + a real mailbox we can read ───────────────────
  const ownerEmail = `owner-${Date.now().toString(36)}@${cfg.domain}`;
  await admin.ensureMailbox(ownerEmail, deriveMailboxPassword(cfg.masterSecret, ownerEmail), "Owner");
  const ownerInbox = new StalwartJmapClient(cfg.url, ownerEmail, deriveMailboxPassword(cfg.masterSecret, ownerEmail));
  const userId = `user_${randomUUID()}`;
  await sql`INSERT INTO "user" (id, name, email) VALUES (${userId}, 'Demo Owner', ${ownerEmail})`;

  // ── company owned by that user, supervised (gated tools need approval) ────
  const slug = `notifyco-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES (${userId}, 'Notify Demo', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, subdomain, email_address)
    VALUES (${cg!.id}, ${slug}, 'NotifyCo', 'Sell mugs.', 'active', 'supervised', ${`${slug}.localhost`}, ${`${slug}@placeholder`})
    RETURNING id`;
  const companyId = co!.id;
  await provisionMailbox({ companyId, slug, name: "NotifyCo" }); // real {slug}@domain mailbox

  // ── trigger a gated action as the worker ──────────────────────────────────
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
  const gatewayUrl = `http://localhost:${server.port}`;
  const seqBefore = (await ledger.head())?.seq ?? 0;

  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, company_id, title, description, status)
            VALUES (${taskId}, ${companyId}, 'Tidy catalogue', 'Remove a product.', 'running')`;
  const token = signToken({ companyId, taskId, exp: Math.floor(Date.now() / 1000) + 600 });
  const callTool = async (s: string, t: string, args: unknown) => {
    const res = await fetch(`${gatewayUrl}/tools/${s}/${t}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  const created = await callTool("payments", "create_product", { name: "Mug", priceCents: 1500 });
  const attempt = await callTool("payments", "delete_product", { productId: created.body.productId });
  ok(attempt.status === 403 && attempt.body.approvalId, "gated delete_product parked for approval");

  // ── the owner got an email about it ───────────────────────────────────────
  const mail = await until(async () => {
    const inbox = await ownerInbox.fetchInbox(10);
    return inbox.find((m) => m.subject.startsWith("Approval needed")) ?? null;
  }, "approval notification in the owner's inbox");
  ok(mail!.from === `${slug}@${cfg.domain}`, "email is from the company's mailbox");
  ok(mail!.subject.includes("delete_product"), "subject names the action awaiting approval");
  ok(/Approve or reject/.test(mail!.text) && mail!.text.includes(`/c/${slug}`), "body links to the dashboard to decide");

  const [notified] = await sql`
    SELECT payload FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'approval_notified' AND seq > ${seqBefore}`;
  ok(notified && (notified as any).payload.channel === "email", "approval_notified event on the ledger (channel=email)");

  // ── a retry of the same action reuses the approval and does NOT re-email ──
  await callTool("payments", "delete_product", { productId: created.body.productId });
  const [{ n: notifyCount }] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'approval_notified'`;
  ok(Number(notifyCount) === 1, "identical retry reuses the approval — owner not emailed twice");

  const verdict = await ledger.verify();
  ok(verdict.ok, `hash chain verifies (head seq ${(await ledger.head())?.seq})`);

  console.log("\nAPPROVAL NOTIFY PASSED — the owner is emailed out-of-band when an action needs them, once per request.");
  server.stop(true);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
