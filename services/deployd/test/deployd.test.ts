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

  test("rejects path escapes and bad slugs", async () => {
    await expect(publishSite({ slug: "synth-co", files: { "../evil": "x" } })).rejects.toThrow();
    await expect(publishSite({ slug: "Bad Slug", files: { "a.html": "x" } })).rejects.toThrow();
  });
});
