import { describe, expect, test } from "bun:test";
import { assertPublicUrl, extractText } from "../src/providers/browser";
import { isValidAddress, listUnsubscribeHeader } from "../src/providers/email";
import { paymentsFor, isTerminalStripeError } from "../src/providers/payments";
import { EnvSecretStore } from "../src/secrets";
import { registry } from "../src/tools";
import { DEFAULT_LIMITS } from "../src/ratelimit";

describe("browser egress guard (§8)", () => {
  test("allows public http(s)", () => {
    expect(assertPublicUrl("https://example.com/x").hostname).toBe("example.com");
  });

  test("blocks private, loopback, metadata, and non-http schemes", () => {
    for (const bad of [
      "http://localhost/",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.0.1/",
      "http://169.254.169.254/",
      "http://172.16.0.1/",
      "http://metadata.google.internal/",
      "file:///etc/passwd",
      "ftp://example.com/",
    ]) {
      expect(() => assertPublicUrl(bad)).toThrow();
    }
  });
});

describe("html extraction", () => {
  test("pulls title, drops scripts/styles/tags, decodes entities", () => {
    const html = `<html><head><title> Hi </title><style>x{}</style></head>
      <body><script>evil()</script><h1>Acme &amp; Co</h1><p>Buy now</p></body></html>`;
    const { title, text } = extractText(html);
    expect(title).toBe("Hi");
    expect(text).toContain("Acme & Co");
    expect(text).toContain("Buy now");
    expect(text).not.toContain("evil");
  });
});

describe("email hygiene (§7.3)", () => {
  test("address validation", () => {
    expect(isValidAddress("a@b.co")).toBe(true);
    expect(isValidAddress("no-at")).toBe(false);
    expect(isValidAddress("a@b")).toBe(false);
  });

  test("mandatory List-Unsubscribe header", () => {
    expect(listUnsubscribeHeader("acme@opencorp.app")["List-Unsubscribe"]).toContain(
      "acme@opencorp.app",
    );
  });
});

describe("payments provider (§10)", () => {
  // Explicit empty env (not process.env): keeps "no Stripe key → local mode"
  // deterministic even when a real key is present in the dev shell / .env.
  const secrets = new EnvSecretStore({});

  test("local mode without a Stripe key, payout returns a transfer id", async () => {
    const p = await paymentsFor("co-1", secrets, "http://cb");
    expect(p.kind).toBe("local");
    const { providerRef, paymentLink } = await p.createProduct({
      productId: "p1",
      companyId: "co-1",
      slug: "acme",
      name: "Starter",
      priceCents: 1900,
      currency: "eur",
    });
    expect(providerRef).toBe("local:p1");
    expect(paymentLink).toBe("http://cb/pay/acme/p1");
    const { transferId } = await p.payout({ amountCents: 1000, currency: "eur", destination: null });
    expect(transferId).toStartWith("local-payout:");
  });
});

describe("stripe payout money-out (§10)", () => {
  // A company with a Stripe key resolves to the real Stripe provider; we mock
  // global fetch so no network is hit.
  const stripeSecrets = new EnvSecretStore({ OPENCORP_SECRET__STRIPE_SECRET_KEY: "sk_test_x" });

  test("transfer carries an Idempotency-Key keyed on the withdrawal", async () => {
    const p = await paymentsFor("co-1", stripeSecrets, "");
    expect(p.kind).toBe("stripe");

    const calls: { url: string; headers: Headers }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { headers?: HeadersInit }) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      return new Response(JSON.stringify({ id: "tr_123" }), { status: 200 });
    }) as typeof fetch;
    try {
      const { transferId } = await p.payout({
        amountCents: 1000,
        currency: "eur",
        destination: "acct_1",
        idempotencyKey: "withdrawal:w-1",
      });
      expect(transferId).toBe("stripe:tr_123");
      expect(calls[0]!.url).toContain("/v1/transfers");
      expect(calls[0]!.headers.get("idempotency-key")).toBe("withdrawal:w-1");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("a 4xx rejection is terminal; a 5xx is transient (retryable)", async () => {
    const p = await paymentsFor("co-1", stripeSecrets, "");
    const orig = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "no such destination" } }), { status: 400 })) as typeof fetch;
    const terminal = await p
      .payout({ amountCents: 1000, currency: "eur", destination: "acct_x", idempotencyKey: "withdrawal:w-2" })
      .then(() => null, (err) => err);
    expect(isTerminalStripeError(terminal)).toBe(true);

    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    const transient = await p
      .payout({ amountCents: 1000, currency: "eur", destination: "acct_x", idempotencyKey: "withdrawal:w-3" })
      .then(() => null, (err) => err);
    expect(isTerminalStripeError(transient)).toBe(false);

    globalThis.fetch = orig;
  });
});

describe("registry wiring (§7.1)", () => {
  test("M3 capability servers + ads (§14) are present", () => {
    for (const s of ["payments", "email", "browser", "analytics", "finance", "ads"]) {
      expect(registry[s]).toBeDefined();
    }
  });

  test("irreversible tools are gated, and rate-limited write tools have limits", () => {
    expect(registry.payments!.delete_product!.gated).toBe(true);
    expect(registry.web!.set_custom_domain!.gated).toBe(true);
    expect(registry.browser!.submit_form!.gated).toBe(true);
    expect(DEFAULT_LIMITS.send_email).toBeDefined();
    expect(DEFAULT_LIMITS.create_product).toBeDefined();
  });

  test("ad money-out tools are gated with a budgetGate; pausing is not", () => {
    expect(registry.ads!.launch_campaign!.gated).toBe(true);
    expect(registry.ads!.launch_campaign!.budgetGate).toBeDefined();
    expect(registry.ads!.set_budget!.gated).toBe(true);
    expect(registry.ads!.set_budget!.budgetGate).toBeDefined();
    expect(registry.ads!.pause_campaign!.gated).toBeUndefined();
    expect(DEFAULT_LIMITS.launch_campaign).toBeDefined();
  });
});
