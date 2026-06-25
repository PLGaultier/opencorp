import { describe, expect, test } from "bun:test";
import { sanitizeSiteHtml } from "../src/lint";

describe("sanitizeSiteHtml", () => {
  test("fixes the malformed grid--2/3 class the agent used to leak", () => {
    const { html, warnings } = sanitizeSiteHtml('<div class="grid grid--2/3">x</div>');
    expect(html).toContain("grid--2");
    expect(html).not.toContain("grid--2/3");
    expect(warnings.join(" ")).toContain("malformed grid");
  });

  test("injects the design-system link when missing", () => {
    const { html, warnings } = sanitizeSiteHtml("<head><title>x</title></head><body></body>");
    expect(html).toContain('href="design-system.css"');
    expect(warnings.join(" ")).toContain("design-system.css");
  });

  test("leaves an existing stylesheet link alone", () => {
    const src = '<head><link rel="stylesheet" href="design-system.css"></head>';
    const { html, warnings } = sanitizeSiteHtml(src);
    expect((html.match(/design-system\.css/g) ?? []).length).toBe(1);
    expect(warnings.join(" ")).not.toContain("missing");
  });

  test("wires og:image when a card url is given and none is present", () => {
    const { html } = sanitizeSiteHtml("<head></head>", { ogImageUrl: "https://x.test/og.png" });
    expect(html).toContain('property="og:image"');
    expect(html).toContain("summary_large_image");
  });

  test("does not duplicate og:image if the page already has one", () => {
    const src = '<head><meta property="og:image" content="a.png"></head>';
    const { html } = sanitizeSiteHtml(src, { ogImageUrl: "https://x.test/og.png" });
    expect((html.match(/og:image/g) ?? []).length).toBe(1);
  });

  test("reports inline styles without stripping them (keeps inline SVG safe)", () => {
    const { html, warnings } = sanitizeSiteHtml('<p style="color:red">x</p>');
    expect(html).toContain('style="color:red"'); // not stripped
    expect(warnings.join(" ")).toContain("inline style");
  });
});
