/**
 * Stalwart management API client (§6 step 2: "create Stalwart mailbox via
 * admin API"). Creates the mail domain and one individual account per company.
 * Both operations are idempotent — "already exists" is success — so the
 * CreateCompany activity can retry safely.
 */
export class StalwartAdmin {
  private auth: string;

  constructor(
    private baseUrl: string,
    user: string,
    secret: string,
  ) {
    this.auth = `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
  }

  private async createPrincipal(principal: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/principal`, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify(principal),
    });
    if (res.ok) return;
    const body = await res.text();
    // Idempotency: a principal that already exists is success (Temporal retries).
    if (/exist/i.test(body)) return;
    throw new Error(`stalwart principal create failed: ${res.status} ${body}`);
  }

  async ensureDomain(domain: string): Promise<void> {
    await this.createPrincipal({ type: "domain", name: domain, description: `OpenCorp mail domain` });
  }

  /** One mailbox per company: login name = full address, password = derived (derive.ts). */
  async ensureMailbox(address: string, password: string, displayName: string): Promise<void> {
    await this.createPrincipal({
      type: "individual",
      name: address,
      secrets: [password],
      emails: [address],
      description: displayName,
      // Stalwart ≥0.12 RBAC: without the "user" role the account cannot open a
      // JMAP session at all (403) — found the hard way against a live server.
      roles: ["user"],
    });
  }
}
