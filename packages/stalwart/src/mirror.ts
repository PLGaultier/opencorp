import type postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import { StalwartJmapClient, type InboundMessage } from "./jmap";
import { deriveMailboxPassword } from "./derive";
import { stalwartEnv } from "./env";

/**
 * Inbound mirror (§4 emails table: "synced from Stalwart via JMAP"). Pulls the
 * newest inbox messages and inserts the ones not yet mirrored (deduped on
 * jmap_id), each with an `email_received` ledger event — the redactor hashes
 * third-party addresses on append (§9.3). The mirror is the read path for
 * list_emails/read_email and the dashboard inbox; agents never talk JMAP.
 */
export async function mirrorInbox(
  sql: postgres.Sql,
  ledger: Ledger,
  company: { id: string; email: string },
  fetchInbox: () => Promise<InboundMessage[]>,
): Promise<{ synced: number }> {
  const messages = await fetchInbox();
  let synced = 0;
  for (const m of messages) {
    // Skip our own outbound (sent copies can surface in queries) and dedupe.
    if (m.from.toLowerCase() === company.email.toLowerCase()) continue;
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO emails (company_id, direction, from_addr, to_addrs, subject, body_text, jmap_id, read)
      SELECT ${company.id}, 'in', ${m.from}, ${m.to}, ${m.subject}, ${m.text}, ${m.jmapId}, false
      WHERE NOT EXISTS (
        SELECT 1 FROM emails WHERE company_id = ${company.id} AND jmap_id = ${m.jmapId}
      )
      RETURNING id`;
    if (!inserted.length) continue;
    synced++;
    await ledger.append({
      companyId: company.id,
      actor: "system",
      eventType: "email_received",
      payload: { from: m.from, subject: m.subject, emailId: inserted[0]!.id },
    });
  }
  return { synced };
}

/**
 * Convenience for the heartbeat (§5.2 step 1 "unread-inbox digest"): sync the
 * company's inbox from platform env config before the CEO gathers context.
 * No-op (synced: 0) when Stalwart is unconfigured or the company has no mailbox
 * on the platform domain.
 */
export async function syncInboxFromEnv(
  sql: postgres.Sql,
  ledger: Ledger,
  companyId: string,
): Promise<{ synced: number }> {
  const cfg = stalwartEnv();
  if (!cfg) return { synced: 0 };
  const [c] = await sql<{ email_address: string | null }[]>`
    SELECT email_address FROM companies WHERE id = ${companyId}`;
  const email = c?.email_address;
  if (!email || !email.toLowerCase().endsWith(`@${cfg.domain.toLowerCase()}`)) return { synced: 0 };
  const client = new StalwartJmapClient(cfg.url, email, deriveMailboxPassword(cfg.masterSecret, email));
  return mirrorInbox(sql, ledger, { id: companyId, email }, () => client.fetchInbox());
}
