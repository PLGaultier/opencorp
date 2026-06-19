/**
 * Real outbound-email test (§7.1, §12): a company's mailbox sends a message that
 * actually lands in your personal inbox via the Resend relay. Proves the
 * EmailProvider seam end-to-end (resolve transport → send → mirror → ledger),
 * not just the in-app mirror.
 *
 * Prereqs:
 *   - RESEND_API_KEY set in .env (https://resend.com → API Keys)
 *   - the stack's Postgres up with at least one company (create one from the
 *     dashboard, or `bun run dev`)
 *
 * Usage:
 *   bun apps/gateway/scripts/resend-test.ts <to-email> [company-slug]
 *   # to-email defaults to your Resend account email when omitted
 *
 * Note: without RESEND_FROM, Resend's shared test sender only delivers to the
 * email you signed up to Resend with — use that address as <to-email>.
 */
import postgres from "postgres";
import { Ledger, PgStore } from "@opencorp/ledgerd";
import { secretStoreFromEnv } from "../src/secrets";
import { emailFor, listUnsubscribeHeader } from "../src/providers/email";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const to = process.argv[2];
const slug = process.argv[3];

if (!process.env.RESEND_API_KEY) {
  console.error("✖ RESEND_API_KEY not set — add it to .env first (https://resend.com).");
  process.exit(1);
}
if (!to) {
  console.error("✖ usage: bun apps/gateway/scripts/resend-test.ts <to-email> [company-slug]");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 4 });

async function main() {
  const [company] = slug
    ? await sql<{ id: string; name: string; email_address: string | null; slug: string }[]>`
        SELECT id, name, email_address, slug FROM companies WHERE slug = ${slug}`
    : await sql<{ id: string; name: string; email_address: string | null; slug: string }[]>`
        SELECT id, name, email_address, slug FROM companies ORDER BY created_at DESC LIMIT 1`;

  if (!company) throw new Error("no company found — create one from the dashboard first");
  if (!company.email_address) throw new Error(`company ${company.slug} has no mailbox`);

  console.log(`▶ company: ${company.name} <${company.email_address}>  →  ${to}`);

  const secrets = secretStoreFromEnv();
  const provider = await emailFor(company.id, secrets, company.email_address);
  console.log(`  transport: ${provider.kind}`);
  if (provider.kind !== "resend") {
    console.warn("  ⚠ transport is not 'resend' — the mail will NOT reach an external inbox.");
  }

  const subject = `Hello from ${company.name} 👋`;
  const text =
    `This email was sent autonomously by your OpenCorp company "${company.name}" ` +
    `(${company.email_address}) through the Resend relay.\n\n` +
    `If you got this in your inbox, real outbound email works. — OpenCorp`;

  const { messageId } = await provider.send({
    from: company.email_address,
    to: [to!],
    subject,
    text,
    headers: listUnsubscribeHeader(company.email_address),
  });
  console.log(`  ✓ sent — messageId ${messageId}`);

  // Mirror it like the real send_email tool does, so it shows in the dashboard
  // outbox and on the public ledger.
  await sql`
    INSERT INTO emails (company_id, direction, from_addr, to_addrs, subject, body_text, jmap_id, read)
    VALUES (${company.id}, 'out', ${company.email_address}, ${[to!]}, ${subject}, ${text}, ${messageId}, true)`;
  const ledger = new Ledger(new PgStore(DATABASE_URL, 4));
  await ledger.append({
    companyId: company.id,
    actor: "test:resend",
    eventType: "email_sent",
    payload: { to: [to], subject, transport: provider.kind },
  });
  console.log(`  ✓ mirrored to emails table + ledger`);
  console.log(`\n✅ Check ${to} — the mail should arrive within a few seconds.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
