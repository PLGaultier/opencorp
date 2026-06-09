import { randomUUID } from "node:crypto";
import type { SecretStore } from "../secrets";

/**
 * Email arm (§7.1 email-mcp, §7.3 hygiene, §12 deliverability). `EmailProvider`
 * is the transport seam: Stalwart over JMAP in prod, a local no-op in dev. The
 * `emails` table is always the mirror of record (powers read_email/list_emails
 * and the public ledger). Outbound hygiene — List-Unsubscribe header, per-
 * recipient frequency caps — is enforced here and in the tool handler, never by
 * the agent prompt.
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
  readonly kind: "stalwart" | "local";
  send(msg: OutboundEmail): Promise<{ messageId: string }>;
}

class LocalEmail implements EmailProvider {
  readonly kind = "local";
  async send(): Promise<{ messageId: string }> {
    // No real SMTP in dev — the emails table is the mirror; nothing leaves.
    return { messageId: `local:${randomUUID()}` };
  }
}

class StalwartEmail implements EmailProvider {
  readonly kind = "stalwart";
  constructor(
    private jmapUrl: string,
    private token: string,
  ) {}

  async send(msg: OutboundEmail): Promise<{ messageId: string }> {
    // JMAP Email/set + EmailSubmission/set in one request (§3 Stalwart).
    const res = await fetch(this.jmapUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
        methodCalls: [
          [
            "Email/set",
            {
              accountId: msg.from,
              create: {
                draft: {
                  from: [{ email: msg.from }],
                  to: msg.to.map((email) => ({ email })),
                  subject: msg.subject,
                  bodyValues: { body: { value: msg.text } },
                  textBody: [{ partId: "body", type: "text/plain" }],
                  header: Object.entries(msg.headers ?? {}).map(([name, value]) => ({ name, value })),
                },
              },
            },
            "0",
          ],
          ["EmailSubmission/set", { accountId: msg.from, create: { sub: { emailId: "#draft" } } }, "1"],
        ],
      }),
    });
    if (!res.ok) throw new Error(`stalwart jmap send failed: ${res.status} ${await res.text()}`);
    return { messageId: `jmap:${randomUUID()}` };
  }
}

export async function emailFor(companyId: string, secrets: SecretStore): Promise<EmailProvider> {
  const url = await secrets.get(companyId, "STALWART_JMAP_URL");
  const token = await secrets.get(companyId, "STALWART_JMAP_TOKEN");
  return url && token ? new StalwartEmail(url, token) : new LocalEmail();
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
