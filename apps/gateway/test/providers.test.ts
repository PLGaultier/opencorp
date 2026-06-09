import { describe, expect, test } from "bun:test";
import { assertPublicUrl, extractText } from "../src/providers/browser";
import { isValidAddress, listUnsubscribeHeader } from "../src/providers/email";
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

describe("registry wiring (§7.1)", () => {
  test("M3 capability servers are present", () => {
    for (const s of ["payments", "email", "browser", "analytics", "finance"]) {
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
});
