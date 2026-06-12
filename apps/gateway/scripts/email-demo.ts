/**
 * Real-email exit test (§14 M3 hardening): send/receive through a live Stalwart
 * mail server — no mocks, zero external accounts. Requires the dev stack:
 *
 *   docker compose -f infra/compose/docker-compose.dev.yml up -d postgres stalwart
 *   bun apps/gateway/scripts/email-demo.ts
 *
 * Flow:
 *   1. CreateCompany's real `provisionMailbox` activity creates the company's
 *      mailbox on Stalwart (domain + account, derived password, ledger event)
 *   2. an external customer (own Stalwart mailbox) emails the company
 *   3. the agent's `list_emails` tool syncs the inbox over JMAP → mirror +
 *      `email_received` on the ledger
 *   4. the agent replies (`reply_email`) and prospects (`send_email`) — both
 *      land in the customer's real inbox via JMAP submission
 *   5. sync is idempotent; the hash chain verifies.
 */
process.env.STALWART_URL ??= "http://localhost:8081";
// Real TLD required: Stalwart validates identity addresses against the public
// suffix list, so `.test`/`.local` domains cannot send. The domain stays local
// to this Stalwart instance — nothing leaves the dev box.
process.env.MAIL_DOMAIN ??= "opencorp.dev";

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { signToken } from "@opencorp/mcp-client";
import {
  StalwartAdmin,
  StalwartJmapClient,
  deriveMailboxPassword,
  stalwartEnv,
  syncInboxFromEnv,
} from "@opencorp/stalwart";
import { createGateway } from "../src/app";
import { provisionMailbox } from "../../../workflows/src/activities";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const sql = postgres(DATABASE_URL, { max: 4 });

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

/** Poll until `fn` returns truthy (Stalwart delivers async, usually < 1 s). */
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
  console.log(`Stalwart at ${cfg.url}, mail domain ${cfg.domain}`);

  // ── 1. company + real mailbox via the actual CreateCompany activity ──────
  const slug = `mailco-${Date.now().toString(36)}`;
  const [cg] = await sql<{ id: string }[]>`
    INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap)
    VALUES ('demo-user', 'Email Demo Conglomerate', '100') RETURNING id`;
  const [co] = await sql<{ id: string }[]>`
    INSERT INTO companies (conglomerate_id, slug, name, mission, status, autonomy_level, subdomain, email_address)
    VALUES (${cg!.id}, ${slug}, 'Mailtropolis', 'Answer every customer within the hour.',
            'active', 'supervised', ${`${slug}.localhost`}, ${`${slug}@placeholder`})
    RETURNING id`;
  const companyId = co!.id;

  const address = await provisionMailbox({ companyId, slug, name: "Mailtropolis" });
  ok(address === `${slug}@${cfg.domain}`, `provisionMailbox created ${address} on Stalwart`);
  const [coRow] = await sql<{ email_address: string }[]>`
    SELECT email_address FROM companies WHERE id = ${companyId}`;
  ok(coRow!.email_address === address, "companies.email_address updated to the real mailbox");

  // ── 2. an external customer emails the company ────────────────────────────
  const admin = new StalwartAdmin(cfg.url, cfg.adminUser, cfg.adminSecret);
  const customerAddr = `customer-${Date.now().toString(36)}@${cfg.domain}`;
  await admin.ensureMailbox(customerAddr, deriveMailboxPassword(cfg.masterSecret, customerAddr), "Customer");
  const customer = new StalwartJmapClient(
    cfg.url,
    customerAddr,
    deriveMailboxPassword(cfg.masterSecret, customerAddr),
  );
  await customer.send({
    from: customerAddr,
    to: [address!],
    subject: "Question about your service",
    text: "Hi! Do you offer a free trial? — A. Customer",
  });
  console.log(`Customer ${customerAddr} → ${address}`);

  // ── 3. the agent reads its inbox through the gateway (JMAP sync inside) ───
  const { app, ledger } = createGateway({ databaseUrl: DATABASE_URL });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
  const gatewayUrl = `http://localhost:${server.port}`;
  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, company_id, title, description, status)
            VALUES (${taskId}, ${companyId}, 'Answer the inbox', 'Reply to customers.', 'running')`;
  const token = signToken({ companyId, taskId, exp: Math.floor(Date.now() / 1000) + 600 });
  const call = async (tool: string, args: unknown) => {
    const res = await fetch(`${gatewayUrl}/tools/email/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    return (await res.json()) as Record<string, unknown> & { error?: string };
  };

  const inbound = await until(async () => {
    const list = (await call("list_emails", { direction: "in" })) as unknown as {
      id: string; from_addr: string; subject: string;
    }[];
    return Array.isArray(list) && list.length ? list[0] : null;
  }, "inbound email visible to list_emails");
  ok(inbound!.from_addr === customerAddr, "inbound mirrored from the real Stalwart inbox");
  ok(inbound!.subject === "Question about your service", "subject intact through JMAP sync");

  const [recvEvent] = await sql`
    SELECT 1 FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'email_received' LIMIT 1`;
  ok(recvEvent, "email_received event on the public ledger");
  const [provEvent] = await sql`
    SELECT 1 FROM ledger_events
    WHERE company_id = ${companyId} AND event_type = 'mailbox_provisioned' LIMIT 1`;
  ok(provEvent, "mailbox_provisioned event on the public ledger");

  // ── 4. the agent replies + prospects; both reach the customer's real inbox ─
  const reply = await call("reply_email", { emailId: inbound!.id, body: "Yes — 14-day free trial. Want a link?" });
  ok(reply.sent === true && String(reply.messageId).startsWith("jmap:"), "reply_email submitted over JMAP");

  const replyInInbox = await until(async () => {
    const msgs = await customer.fetchInbox(10);
    return msgs.find((m) => m.subject === "Re: Question about your service") ?? null;
  }, "reply delivered to the customer's inbox");
  ok(replyInInbox!.from === address, "reply arrives from the company's address");
  ok(replyInInbox!.text.includes("free trial"), "reply body delivered intact");

  const outreach = await call("send_email", {
    to: [customerAddr],
    subject: "Welcome to Mailtropolis",
    body: "Here is everything you need to get started.",
  });
  ok(outreach.sent === true && outreach.transport === "stalwart", "send_email uses the stalwart transport");
  await until(async () => {
    const msgs = await customer.fetchInbox(10);
    return msgs.find((m) => m.subject === "Welcome to Mailtropolis") ?? null;
  }, "outreach delivered to the customer's inbox");
  ok(true, "outreach email delivered for real");

  // ── 5. idempotent sync + chain verification ───────────────────────────────
  const second = await syncInboxFromEnv(sql, ledger, companyId);
  ok(second.synced === 0, "second sync mirrors nothing new (idempotent on jmap_id)");

  const verdict = await ledger.verify();
  ok(verdict.ok, `hash chain verifies (head seq ${(await ledger.head())?.seq})`);

  console.log("\nEMAIL DEMO PASSED — real send/receive through Stalwart, every step on the ledger.");
  server.stop(true);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
