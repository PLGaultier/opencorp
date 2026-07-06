import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLanding } from "../src/template";
import { publishSite } from "../src/publish";

const copy = {
  headline: "Vintage Synth Weekly",
  subheadline: 'The newsletter for collectors of <classic> "synths"',
  cta: "Subscribe",
  sections: [{ title: "What we do", body: "Weekly deep dives & price guides" }],
};

describe("renderLanding", () => {
  test("escapes copy and embeds ledger link", () => {
    const html = renderLanding({ companyName: "Synth Co", slug: "synth-co", copy });
    expect(html).toContain("Vintage Synth Weekly");
    expect(html).not.toContain("<classic>");
    expect(html).toContain("&#60;classic&#62;");
    expect(html).toContain("/c/synth-co");
  });

  test("links the house design system and uses its classes, not inline styles", () => {
    const html = renderLanding({ companyName: "Synth Co", slug: "synth-co", copy });
    expect(html).toContain('<link rel="stylesheet" href="design-system.css">');
    expect(html).toContain('class="section hero"');
    expect(html).toContain('class="btn btn--lg"');
    expect(html).not.toContain("<style>"); // styling lives in the design system
  });

  test("wires the buy link + price as the CTA when a checkout URL is given", () => {
    const html = renderLanding({
      companyName: "Synth Co",
      slug: "synth-co",
      copy,
      emailAddress: "synth-co@opencorp.app",
      buyUrl: "https://gw.opencorp.app/checkout/pay/synth-co/abc",
      priceCents: 2900,
    });
    // Primary CTA points at checkout, not a mailto, and shows the price.
    expect(html).toContain('href="https://gw.opencorp.app/checkout/pay/synth-co/abc"');
    expect(html).toContain("Subscribe — €29.00");
    expect(html).not.toContain('class="btn btn--lg" href="mailto:');
    // Email stays reachable as a secondary support line.
    expect(html).toContain("mailto:synth-co@opencorp.app");
  });

  test("falls back to the mailto CTA when no checkout URL is given", () => {
    const html = renderLanding({
      companyName: "Synth Co",
      slug: "synth-co",
      copy,
      emailAddress: "synth-co@opencorp.app",
    });
    expect(html).toContain('class="btn btn--lg" href="mailto:synth-co@opencorp.app"');
    expect(html).not.toContain("checkout/pay");
  });

  test("includes umami snippet only when configured", () => {
    const without = renderLanding({ companyName: "X", slug: "x-co", copy });
    expect(without).not.toContain("data-website-id");
    const withUmami = renderLanding({
      companyName: "X",
      slug: "x-co",
      copy,
      umamiSiteId: "abc",
      umamiUrl: "http://localhost:3003",
    });
    expect(withUmami).toContain('data-website-id="abc"');
  });
});

describe("publishSite", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencorp-sites-"));
    process.env.SITES_DIR = dir;
  });

  test("writes files under the slug dir, redeploy overwrites", async () => {
    await publishSite({ slug: "synth-co", files: { "index.html": "v1" } });
    await publishSite({ slug: "synth-co", files: { "index.html": "v2" } });
    expect(await readFile(join(dir, "synth-co", "index.html"), "utf8")).toBe("v2");
  });

  test("always drops the canonical design system into every site", async () => {
    await publishSite({ slug: "synth-co", files: { "index.html": "v1" } });
    const css = await readFile(join(dir, "synth-co", "design-system.css"), "utf8");
    expect(css).toContain("--primary");
    expect(css).toContain(".btn");
    // an agent-supplied copy can't override the house style
    await publishSite({ slug: "synth-co", files: { "design-system.css": "/* hijack */" } });
    expect(await readFile(join(dir, "synth-co", "design-system.css"), "utf8")).not.toContain("hijack");
  });

  test("rejects path escapes and bad slugs", async () => {
    await expect(publishSite({ slug: "synth-co", files: { "../evil": "x" } })).rejects.toThrow();
    await expect(publishSite({ slug: "Bad Slug", files: { "a.html": "x" } })).rejects.toThrow();
  });
});
