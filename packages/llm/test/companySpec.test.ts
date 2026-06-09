import { describe, expect, test } from "bun:test";
import { CompanySpec, fallbackSpec, extractCompanySpec } from "../src/companySpec";

describe("company spec extraction", () => {
  test("fallback spec passes schema validation", () => {
    const spec = fallbackSpec("a newsletter about vintage synthesizers for collectors");
    expect(CompanySpec.safeParse(spec).success).toBe(true);
    expect(spec.slug).toBe("a-newsletter-about");
    expect(spec.initial_tasks.length).toBeGreaterThanOrEqual(3);
  });

  test("fallback handles hostile prompts", () => {
    for (const p of ["!!!", "a", "x ".repeat(500), "ÉMOJI 🚀 prompt"]) {
      const spec = fallbackSpec(p);
      const r = CompanySpec.safeParse(spec);
      expect(r.success).toBe(true);
    }
  });

  test("extractCompanySpec without llm config uses fallback", async () => {
    const spec = await extractCompanySpec(null, "sell handmade ceramic mugs online");
    expect(spec.slug).toBe("sell-handmade-ceramic");
  });

  test("schema rejects bad slugs", () => {
    const base = fallbackSpec("sell handmade ceramic mugs online");
    expect(CompanySpec.safeParse({ ...base, slug: "Has Spaces" }).success).toBe(false);
    expect(CompanySpec.safeParse({ ...base, slug: "-leading" }).success).toBe(false);
  });
});
