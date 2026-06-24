import { describe, expect, test } from "bun:test";
import { PROMOTE_SCORE, PROMOTE_WINS, qualifiesForPromotion } from "../src/ceo";

describe("lesson promotion gate", () => {
  test("promotes only proven lessons (high score AND multiple wins)", () => {
    expect(qualifiesForPromotion({ score: PROMOTE_SCORE, wins: PROMOTE_WINS })).toBe(true);
    expect(qualifiesForPromotion({ score: PROMOTE_SCORE + 5, wins: 9 })).toBe(true);
  });

  test("a high score from a single win does not qualify", () => {
    expect(qualifiesForPromotion({ score: 9, wins: 1 })).toBe(false);
  });

  test("many wins but a faded score does not qualify", () => {
    expect(qualifiesForPromotion({ score: PROMOTE_SCORE - 0.5, wins: 5 })).toBe(false);
  });
});
