import { describe, test, expect } from "bun:test";
import { isNearDuplicateTitle } from "../src/ceo";

/**
 * Near-duplicate task dedup. Titles below are the real ones prod accumulated for
 * TerraValue between 2026-07-13 and 2026-07-21, when exact-title matching let
 * the CEO re-queue the same Stripe product five times.
 */
describe("isNearDuplicateTitle", () => {
  test("exact and case/whitespace variants match", () => {
    expect(isNearDuplicateTitle("Write the FAQ page", "Write the FAQ page")).toBe(true);
    expect(isNearDuplicateTitle("Write the FAQ page", "  write the faq PAGE ")).toBe(true);
  });

  test("catches the prod Stripe rewordings", () => {
    expect(
      isNearDuplicateTitle("Create Stripe Basic product €29", "Create Stripe Basic Plan Product (€29/mo)"),
    ).toBe(true);
    expect(
      isNearDuplicateTitle("Create Stripe Basic product at €29/month", "Create the Basic Stripe product"),
    ).toBe(true);
  });

  test("keeps genuinely different work apart", () => {
    expect(isNearDuplicateTitle("Write the FAQ page", "Link FAQ to Navigation")).toBe(false);
    expect(isNearDuplicateTitle("Draft 3 outreach emails", "List 10 first prospects")).toBe(false);
    // Different Stripe tiers are different products, not a reword.
    expect(isNearDuplicateTitle("Create Stripe Starter Tier Product", "Create the Basic Stripe product")).toBe(
      false,
    );
    // Shared filler alone must not trigger a match.
    expect(isNearDuplicateTitle("Create the pricing page", "Create the analytics dashboard")).toBe(false);
  });

  test("empty or punctuation-only titles never match", () => {
    expect(isNearDuplicateTitle("", "")).toBe(false);
    expect(isNearDuplicateTitle("---", "Write the FAQ page")).toBe(false);
  });
});
