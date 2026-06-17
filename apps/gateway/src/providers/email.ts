import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Ledger } from "@opencorp/ledgerd";
import {
  StalwartJmapClient,
  deriveMailboxPassword,
  mirrorInbox,
  stalwartEnv,
  type InboundMessage,
} from "@opencorp/stalwart";
import type { SecretStore } from "../secrets";

/**
 * Email arm (§7.1 email-mcp, §7.3 hygiene, §12 deliverability). `EmailProvider`
 * is the transport seam: Stalwart over JMAP (real send/receive) when configured,
 * a local no-op otherwise. The `emails` table is always the mirror of record
 * (powers read_email/list_emails and the public ledger); `syncInbox` pulls new
 * inbound mail into it on every read. Outbound hygiene — List-Unsubscribe
 * header, per-recipient frequency caps — is enforced here and in the tool
 * handler, never by the agent prompt.
 */
export interface OutboundEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface EmailProvider {
  readonly kind: "stalwart" | "resend" | "local";
  send(msg: OutboundEmail): Promise<{ messageId: string }>;
  fetchInbox(limit?: number): Promise<InboundMessage[]>;
}

class LocalEmail implements EmailProvider {
  readonly kind = "local";
  async send(): Promise<{ messageId: string }> {
    // No real transport in dev — the emails table is the mirror; nothing leaves.
    return { messageId: `local:${randomUUID()}` };
  }
  async fetchInbox(): Promise<InboundMessage[]> {
    return [];
  }
}

class StalwartEmail implements EmailProvider {
  readonly kind = "stalwart";
  private client: StalwartJmapClient;

  constructor(url: string, account: string, password: string) {
    this.client = new StalwartJmapClient(url, account, password);
  }

  async send(msg: OutboundEmail): Promise<{ messageId: string }> {
    const { messageId } = await this.client.send(msg);
    return { messageId: `jmap:${messageId}` };
  }

  fetchInbox(limit = 30): Promise<InboundMessage[]> {
    return this.client.fetchInbox(limit);
  }
}

/**
 * Resend HTTP relay (§12 deliverability). Send-only (inbound stays on
 * Stalwart/local). Two modes:
 *  - RESEND_FROM set: sends from that address, company address as Reply-To.
 *    Use when the sending domain is not verified in Resend (e.g. shared test
 *    sender "onboarding@resend.dev" — only delivers to your own Resend email).
 *  - RESEND_FROM unset: sends from msg.from directly (e.g. slug@yourdomain.com).
 *    Requires the domain to be verified once in the Resend dashboard. Gives each
 *    company its own real address visible to recipients.
 */
class ResendEmail implements EmailProvider {
  readonly kind = "resend";
  constructor(
    private apiKey: string,
    private sender?: string, // undefined = use msg.from (verified domain required)
  ) {}

  async send(msg: OutboundEmail): Promise<{ messageId: string }> {
    const from = this.sender
      ? `${msg.from.split("@")[0] || "OpenCorp"} <${this.sender}>`
      : msg.from;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        ...(this.sender ? { reply_to: msg.from } : {}),
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: msg.headers,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };
    if (!res.ok || !data.id) {
      throw new Error(`resend send failed: ${res.status} ${data.message ?? data.name ?? ""}`.trim());
    }
    return { messageId: `resend:${data.id}` };
  }

  async fetchInbox(): Promise<InboundMessage[]> {
    return [];
  }
}

/**
 * Resolve the company's transport. Priority: Resend relay (real external
 * delivery) → Stalwart JMAP (self-hosted) → local mirror (nothing leaves). The
 * mailbox password is derived from the platform master secret (never stored,
 * see @opencorp/stalwart derive.ts); per-company SecretStore entries can
 * override platform URL/master/keys for BYO-mail setups.
 */
export async function emailFor(
  companyId: string,
  secrets: SecretStore,
  accountEmail: string,
): Promise<EmailProvider> {
  const resendKey = (await secrets.get(companyId, "RESEND_API_KEY")) ?? process.env.RESEND_API_KEY;
  if (resendKey) {
    const sender =
      (await secrets.get(companyId, "RESEND_FROM")) ?? process.env.RESEND_FROM;
    return new ResendEmail(resendKey, sender); // sender undefined → sends from msg.from directly
  }
  const env = stalwartEnv();
  const url = (await secrets.get(companyId, "STALWART_URL")) ?? env?.url;
  const master = (await secrets.get(companyId, "STALWART_MASTER_SECRET")) ?? env?.masterSecret;
  if (!url || !master || !accountEmail) return new LocalEmail();
  return new StalwartEmail(url, accountEmail, deriveMailboxPassword(master, accountEmail));
}

/**
 * Pull new inbound mail into the mirror (+ `email_received` ledger events).
 * Called best-effort before list/read so agents always see fresh mail; failures
 * degrade to the existing mirror, never block the read.
 */
export async function syncInbox(
  sql: postgres.Sql,
  ledger: Ledger,
  secrets: SecretStore,
  companyId: string,
): Promise<{ synced: number; transport: EmailProvider["kind"] }> {
  const [c] = await sql<{ email_address: string | null }[]>`
    SELECT email_address FROM companies WHERE id = ${companyId}`;
  if (!c?.email_address) return { synced: 0, transport: "local" };
  const provider = await emailFor(companyId, secrets, c.email_address);
  if (provider.kind !== "stalwart") return { synced: 0, transport: provider.kind };
  const { synced } = await mirrorInbox(
    sql,
    ledger,
    { id: companyId, email: c.email_address },
    () => provider.fetchInbox(),
  );
  return { synced, transport: provider.kind };
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

/** RFC5322-lite syntactic check; the DNS MX probe happens in verify_email. */
export function isValidAddress(addr: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addr);
}

/** Mandatory List-Unsubscribe header (§7.3) for every autonomous send. */
export function listUnsubscribeHeader(companyEmail: string): Record<string, string> {
  return { "List-Unsubscribe": `<mailto:${companyEmail}?subject=unsubscribe>` };
}
