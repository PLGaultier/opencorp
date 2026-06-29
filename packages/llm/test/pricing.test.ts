import { describe, expect, test } from "bun:test";
import { priceFor, costMicroCents } from "../src/pricing";
import { modelForBundle } from "../src/client";

describe("GLM bundle pricing (OPE-6)", () => {
  test("priceFor resolves the glm-{tier} alias LiteLLM echoes back", () => {
    // glm-frontier → glm-5.2 ($1.4 / $4.4)
    expect(priceFor("glm-frontier")).toEqual({ inputPerMTokUsd: 1.4, outputPerMTokUsd: 4.4 });
    // glm-standard → glm-4.7 ($0.6 / $2.2)
    expect(priceFor("glm-standard")).toEqual({ inputPerMTokUsd: 0.6, outputPerMTokUsd: 2.2 });
    // glm-mini → glm-4.5-air ($0.2 / $1.1)
    expect(priceFor("glm-mini")).toEqual({ inputPerMTokUsd: 0.2, outputPerMTokUsd: 1.1 });
  });

  test("priceFor resolves a bare resolved id (e.g. zai/glm-5.2) via substring match", () => {
    expect(priceFor("zai/glm-5.2")).toEqual({ inputPerMTokUsd: 1.4, outputPerMTokUsd: 4.4 });
    expect(priceFor("glm-4.5-air")).toEqual({ inputPerMTokUsd: 0.2, outputPerMTokUsd: 1.1 });
  });

  test("GLM is metered at its real (cheap) cost, not the Haiku fallback", () => {
    const usage = { input: 1_000_000, output: 1_000_000 };
    // glm-mini: $0.2 in + $1.1 out = $1.30 = 130 cents = 130_000 micro-cents
    expect(costMicroCents("glm-mini", usage)).toBe(130_000);
    // The fallback (Haiku, $1 + $5) would be 600_000 — make sure we're NOT that.
    expect(costMicroCents("glm-mini", usage)).not.toBe(600_000);
  });

  test("anthropic tiers are unchanged by the GLM additions", () => {
    expect(priceFor("frontier")).toEqual({ inputPerMTokUsd: 5, outputPerMTokUsd: 25 });
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual({ inputPerMTokUsd: 1, outputPerMTokUsd: 5 });
  });
});

describe("modelForBundle (OPE-6)", () => {
  test("glm bundle prefixes the tier", () => {
    expect(modelForBundle("frontier", "glm")).toBe("glm-frontier");
    expect(modelForBundle("standard", "glm")).toBe("glm-standard");
    expect(modelForBundle("mini", "glm")).toBe("glm-mini");
  });

  test("anthropic / undefined keeps the bare tier name (byte-for-byte default)", () => {
    expect(modelForBundle("frontier", "anthropic")).toBe("frontier");
    expect(modelForBundle("standard", undefined)).toBe("standard");
  });
});
