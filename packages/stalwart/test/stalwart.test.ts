import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deriveMailboxPassword } from "../src/derive";
import { stalwartEnv } from "../src/env";
import { StalwartAdmin } from "../src/admin";
import { StalwartJmapClient } from "../src/jmap";

describe("mailbox password derivation", () => {
  test("deterministic, per-address, case-insensitive on address", () => {
    const a = deriveMailboxPassword("master", "acme@opencorp.test");
    expect(deriveMailboxPassword("master", "acme@opencorp.test")).toBe(a);
    expect(deriveMailboxPassword("master", "ACME@opencorp.test")).toBe(a);
    expect(deriveMailboxPassword("master", "other@opencorp.test")).not.toBe(a);
    expect(deriveMailboxPassword("other-master", "acme@opencorp.test")).not.toBe(a);
    expect(a).toHaveLength(40);
    expect(a).not.toContain("master");
  });
});

describe("stalwart env config", () => {
  test("null when STALWART_URL unset (local mode contract)", () => {
    expect(stalwartEnv({})).toBeNull();
  });
  test("defaults + trailing-slash strip", () => {
    const cfg = stalwartEnv({ STALWART_URL: "http://mail:8080/", MAIL_DOMAIN: "opencorp.test" });
    expect(cfg).toMatchObject({ url: "http://mail:8080", domain: "opencorp.test", adminUser: "admin" });
  });
});

// ── Fake Stalwart (admin + JMAP) ────────────────────────────────────────────

interface Recorded {
  principals: Record<string, unknown>[];
  jmapBodies: { using: string[]; methodCalls: [string, Record<string, unknown>, string][] }[];
  sessionAuth?: string;
}
const rec: Recorded = { principals: [], jmapBodies: [] };
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/principal") {
        const body = (await req.json()) as Record<string, unknown>;
        if (body.name === "dup.test") return new Response("principal already exists", { status: 409 });
        if (body.name === "boom.test") return new Response("internal error", { status: 500 });
        rec.principals.push(body);
        return Response.json({ data: rec.principals.length });
      }
      if (url.pathname === "/.well-known/jmap") {
        rec.sessionAuth = req.headers.get("authorization") ?? undefined;
        return Response.json({
          apiUrl: "/jmap",
          primaryAccounts: { "urn:ietf:params:jmap:mail": "acct1" },
        });
      }
      if (url.pathname === "/jmap") {
        const body = (await req.json()) as Recorded["jmapBodies"][0];
        rec.jmapBodies.push(body);
        const responses = body.methodCalls.map(([name, , id]) => {
          if (name === "Identity/get")
            return [name, { list: [{ id: "ident1", email: "acme@opencorp.test" }] }, id];
          if (name === "Mailbox/get")
            return [
              name,
              {
                list: [
                  { id: "mb-in", role: "inbox" },
                  { id: "mb-dr", role: "drafts" },
                  { id: "mb-se", role: "sent" },
                ],
              },
              id,
            ];
          if (name === "Email/set") return [name, { created: { d1: { id: "M123" } } }, id];
          if (name === "EmailSubmission/set") return [name, { created: { s1: { id: "S1" } } }, id];
          if (name === "Email/query") return [name, { ids: ["e1", "e2"] }, id];
          if (name === "Email/get")
            return [
              name,
              {
                list: [
                  {
                    id: "e1",
                    subject: "Hello",
                    from: [{ email: "customer@ext.test" }],
                    to: [{ email: "acme@opencorp.test" }],
                    receivedAt: "2026-06-12T10:00:00Z",
                    bodyValues: { p1: { value: "Bonjour!" } },
                    textBody: [{ partId: "p1" }],
                  },
                  {
                    id: "e2",
                    subject: "No body",
                    from: [{ email: "x@ext.test" }],
                    to: [{ email: "acme@opencorp.test" }],
                    receivedAt: "2026-06-12T09:00:00Z",
                    preview: "preview text",
                  },
                ],
              },
              id,
            ];
          return ["error", { type: "unknownMethod" }, id];
        });
        return Response.json({ methodResponses: responses });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

describe("stalwart admin client (§6)", () => {
  test("creates domain + mailbox principals", async () => {
    const admin = new StalwartAdmin(base, "admin", "secret");
    await admin.ensureDomain("opencorp.test");
    await admin.ensureMailbox("acme@opencorp.test", "pw123", "Acme");
    expect(rec.principals).toEqual([
      expect.objectContaining({ type: "domain", name: "opencorp.test" }),
      expect.objectContaining({
        type: "individual",
        name: "acme@opencorp.test",
        secrets: ["pw123"],
        emails: ["acme@opencorp.test"],
        roles: ["user"], // RBAC: no role → no JMAP session (403)
      }),
    ]);
  });

  test("already-exists is success (idempotent under Temporal retries); real errors throw", async () => {
    const admin = new StalwartAdmin(base, "admin", "secret");
    await admin.ensureDomain("dup.test"); // 409 "already exists" → ok
    await expect(admin.ensureDomain("boom.test")).rejects.toThrow("principal create failed: 500");
  });
});

describe("jmap client (§7.1 email-mcp)", () => {
  test("send: drafts via Email/set + submits with identity, custom headers as JMAP properties", async () => {
    rec.jmapBodies.length = 0;
    const client = new StalwartJmapClient(base, "acme@opencorp.test", "pw");
    const { messageId } = await client.send({
      from: "acme@opencorp.test",
      to: ["customer@ext.test"],
      subject: "Hi",
      text: "Hello there",
      headers: { "List-Unsubscribe": "<mailto:acme@opencorp.test?subject=unsubscribe>" },
    });
    expect(messageId).toBe("M123");
    expect(rec.sessionAuth).toStartWith("Basic ");

    const send = rec.jmapBodies.at(-1)!;
    const [setName, setArgs] = send.methodCalls[0]!;
    expect(setName).toBe("Email/set");
    const draft = (setArgs.create as Record<string, Record<string, unknown>>).d1!;
    expect(draft.subject).toBe("Hi");
    expect(draft["header:List-Unsubscribe:asText"]).toContain("unsubscribe");
    expect(draft.mailboxIds).toEqual({ "mb-dr": true });

    const [subName, subArgs] = send.methodCalls[1]!;
    expect(subName).toBe("EmailSubmission/set");
    const sub = (subArgs.create as Record<string, Record<string, unknown>>).s1!;
    expect(sub.emailId).toBe("#d1");
    expect(sub.identityId).toBe("ident1");
    // on success: out of drafts, into sent
    const onSuccess = (subArgs.onSuccessUpdateEmail as Record<string, Record<string, unknown>>)["#s1"]!;
    expect(onSuccess["mailboxIds/mb-se"]).toBe(true);
    expect(onSuccess["mailboxIds/mb-dr"]).toBeNull();
  });

  test("fetchInbox: query→get with result reference, maps text body + preview fallback", async () => {
    const client = new StalwartJmapClient(base, "acme@opencorp.test", "pw");
    const inbox = await client.fetchInbox(10);
    expect(inbox).toHaveLength(2);
    expect(inbox[0]).toMatchObject({
      jmapId: "e1",
      from: "customer@ext.test",
      subject: "Hello",
      text: "Bonjour!",
    });
    expect(inbox[1]!.text).toBe("preview text"); // no textBody → preview fallback

    const fetchReq = rec.jmapBodies.at(-1)!;
    const [qName, qArgs] = fetchReq.methodCalls[0]!;
    expect(qName).toBe("Email/query");
    expect(qArgs.filter).toEqual({ inMailbox: "mb-in" });
    const [gName, gArgs] = fetchReq.methodCalls[1]!;
    expect(gName).toBe("Email/get");
    expect(gArgs["#ids"]).toEqual({ resultOf: "q", name: "Email/query", path: "/ids" });
  });
});
