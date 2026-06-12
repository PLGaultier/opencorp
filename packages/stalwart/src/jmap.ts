/**
 * Minimal JMAP mail client for Stalwart (§3: "JMAP is ideal for programmatic
 * send/receive"). No SDK: two small flows — submit an email, read the inbox —
 * speaking RFC 8620/8621 directly. Auth is HTTP Basic with the company's
 * mailbox address + derived password (derive.ts).
 */

export interface JmapOutbound {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, e.g. the mandatory List-Unsubscribe (§7.3). */
  headers?: Record<string, string>;
}

export interface InboundMessage {
  jmapId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  receivedAt: string;
}

interface Session {
  apiUrl: string;
  accountId: string;
  identityId: string;
  mailboxes: { inbox?: string; drafts?: string; sent?: string };
}

const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];

type MethodCall = [string, Record<string, unknown>, string];
type MethodResponse = [string, Record<string, unknown>, string];

export class StalwartJmapClient {
  private auth: string;
  private session: Session | null = null;

  constructor(
    private baseUrl: string,
    private account: string,
    password: string,
  ) {
    this.auth = `Basic ${Buffer.from(`${account}:${password}`).toString("base64")}`;
  }

  /** Session discovery + identity/mailbox bootstrap, cached for the client's life. */
  private async connect(): Promise<Session> {
    if (this.session) return this.session;
    const res = await fetch(`${this.baseUrl}/.well-known/jmap`, {
      headers: { authorization: this.auth },
    });
    if (!res.ok) throw new Error(`jmap session failed: ${res.status} ${await res.text()}`);
    const s = (await res.json()) as {
      apiUrl: string;
      primaryAccounts: Record<string, string>;
    };
    const accountId = s.primaryAccounts["urn:ietf:params:jmap:mail"];
    if (!accountId) throw new Error("jmap session has no mail account");
    // Keep the advertised path but pin the origin we actually reached: behind
    // Docker/k8s/reverse proxies Stalwart advertises its *internal* hostname
    // (e.g. http://<container-id>:8080), which is unreachable from outside.
    const advertised = new URL(s.apiUrl, this.baseUrl);
    const apiUrl = new URL(advertised.pathname + advertised.search, this.baseUrl).toString();

    const bootstrap = await this.call(apiUrl, [
      ["Identity/get", { accountId }, "i"],
      ["Mailbox/get", { accountId, properties: ["id", "role", "name"] }, "m"],
    ]);
    const identities = bootstrap.find(([name]) => name === "Identity/get");
    const mailboxes = bootstrap.find(([name]) => name === "Mailbox/get");
    if (!identities || !mailboxes) throw new Error("jmap bootstrap missing responses");
    const idList = (identities[1].list ?? []) as { id: string; email: string }[];
    let identity =
      idList.find((i) => i.email.toLowerCase() === this.account.toLowerCase()) ?? idList[0];
    if (!identity) {
      // Fresh Stalwart accounts have no submission identity yet — create one
      // for the mailbox address (RFC 8621 Identity/set).
      const created = await this.call(apiUrl, [
        [
          "Identity/set",
          { accountId, create: { i1: { name: this.account, email: this.account } } },
          "ic",
        ],
      ]);
      const newId = ((created[0]?.[1].created ?? {}) as Record<string, { id: string }>).i1;
      if (!newId) {
        // Surface the server's reason: e.g. Stalwart rejects identities whose
        // domain has no public-suffix-list TLD (so `.test`/`.local` mail
        // domains cannot send — use a real TLD even in dev).
        throw new Error(
          `cannot create jmap identity for ${this.account}: ${JSON.stringify(created[0]?.[1].notCreated)}`,
        );
      }
      identity = { id: newId.id, email: this.account };
    }
    const byRole: Session["mailboxes"] = {};
    for (const mb of (mailboxes[1].list ?? []) as { id: string; role: string | null }[]) {
      if (mb.role === "inbox") byRole.inbox = mb.id;
      if (mb.role === "drafts") byRole.drafts = mb.id;
      if (mb.role === "sent") byRole.sent = mb.id;
    }
    this.session = { apiUrl, accountId, identityId: identity.id, mailboxes: byRole };
    return this.session;
  }

  private async call(apiUrl: string, methodCalls: MethodCall[]): Promise<MethodResponse[]> {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify({ using: USING, methodCalls }),
    });
    if (!res.ok) throw new Error(`jmap request failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { methodResponses: MethodResponse[] };
    const err = body.methodResponses.find(([name]) => name === "error");
    if (err) throw new Error(`jmap method error: ${JSON.stringify(err[1])}`);
    return body.methodResponses;
  }

  /** Email/set (draft) + EmailSubmission/set in one request; moves to Sent on success. */
  async send(msg: JmapOutbound): Promise<{ messageId: string }> {
    const s = await this.connect();
    const draft: Record<string, unknown> = {
      mailboxIds: { [s.mailboxes.drafts ?? s.mailboxes.inbox ?? ""]: true },
      keywords: { $draft: true },
      from: [{ email: msg.from }],
      to: msg.to.map((email) => ({ email })),
      subject: msg.subject,
      bodyValues: {
        txt: { value: msg.text },
        ...(msg.html ? { htm: { value: msg.html } } : {}),
      },
      textBody: [{ partId: "txt", type: "text/plain" }],
      ...(msg.html ? { htmlBody: [{ partId: "htm", type: "text/html" }] } : {}),
    };
    // RFC 8621 dynamic header properties, e.g. "header:List-Unsubscribe:asText".
    for (const [name, value] of Object.entries(msg.headers ?? {})) {
      draft[`header:${name}:asText`] = value;
    }

    const onSuccess: Record<string, unknown> = { "keywords/$draft": null, "keywords/$seen": true };
    if (s.mailboxes.sent) onSuccess[`mailboxIds/${s.mailboxes.sent}`] = true;
    if (s.mailboxes.drafts) onSuccess[`mailboxIds/${s.mailboxes.drafts}`] = null;

    const responses = await this.call(s.apiUrl, [
      ["Email/set", { accountId: s.accountId, create: { d1: draft } }, "c"],
      [
        "EmailSubmission/set",
        {
          accountId: s.accountId,
          create: { s1: { emailId: "#d1", identityId: s.identityId } },
          onSuccessUpdateEmail: { "#s1": onSuccess },
        },
        "s",
      ],
    ]);

    const setResp = responses.find(([name, , id]) => name === "Email/set" && id === "c");
    const created = (setResp?.[1].created ?? {}) as Record<string, { id: string }>;
    if (!created.d1) {
      throw new Error(`jmap draft not created: ${JSON.stringify(setResp?.[1].notCreated)}`);
    }
    const subResp = responses.find(([name, , id]) => name === "EmailSubmission/set" && id === "s");
    const subCreated = (subResp?.[1].created ?? {}) as Record<string, unknown>;
    if (!subCreated.s1) {
      throw new Error(`jmap submission failed: ${JSON.stringify(subResp?.[1].notCreated)}`);
    }
    return { messageId: created.d1.id };
  }

  /** Newest inbox messages via Email/query → Email/get (result reference). */
  async fetchInbox(limit = 30): Promise<InboundMessage[]> {
    const s = await this.connect();
    if (!s.mailboxes.inbox) return [];
    const responses = await this.call(s.apiUrl, [
      [
        "Email/query",
        {
          accountId: s.accountId,
          filter: { inMailbox: s.mailboxes.inbox },
          sort: [{ property: "receivedAt", isDescending: true }],
          limit,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: s.accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["id", "subject", "from", "to", "receivedAt", "preview", "bodyValues", "textBody"],
          fetchTextBodyValues: true,
        },
        "g",
      ],
    ]);
    const get = responses.find(([name, , id]) => name === "Email/get" && id === "g");
    const list = (get?.[1].list ?? []) as {
      id: string;
      subject: string | null;
      from: { email: string }[] | null;
      to: { email: string }[] | null;
      receivedAt: string;
      preview?: string;
      bodyValues?: Record<string, { value: string }>;
      textBody?: { partId: string }[];
    }[];
    return list.map((e) => ({
      jmapId: e.id,
      from: e.from?.[0]?.email ?? "unknown",
      to: (e.to ?? []).map((t) => t.email),
      subject: e.subject ?? "",
      text:
        (e.textBody ?? [])
          .map((p) => e.bodyValues?.[p.partId]?.value ?? "")
          .join("\n")
          .trim() ||
        e.preview ||
        "",
      receivedAt: e.receivedAt,
    }));
  }
}
