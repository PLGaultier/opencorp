import { describe, expect, test } from "bun:test";
import {
  DistilledLessons,
  distillLessons,
  fallbackLessons,
  renderLessonsBlock,
  DEPARTMENT_CATEGORIES,
  type LessonTip,
  type ReflectionInput,
} from "../src/lessons";

const baseInput: ReflectionInput = {
  company: { name: "Mug Co", mission: "Sell handmade ceramic mugs online." },
  recentReports: [
    { title: "Cold outreach batch", status: "failed", summary: "rate_limited" },
    { title: "Launch storefront", status: "done", summary: "Live with payment link." },
  ],
  revenueCents24h: 2900,
  salesCount: 1,
  repliesReceived: 0,
  existingLessons: [],
};

describe("lessons distiller fallback", () => {
  test("fallback output passes the distilled schema", () => {
    const lessons = fallbackLessons(baseInput);
    expect(DistilledLessons.safeParse({ lessons }).success).toBe(true);
  });

  test("a failure teaches 'change approach', a sale teaches 'repeat the play'", () => {
    const lessons = fallbackLessons(baseInput);
    expect(lessons).toHaveLength(2);
    expect(lessons[0]!.text).toContain("Cold outreach batch");
    expect(lessons[0]!.category).toBe("outreach");
    expect(lessons[1]!.text).toContain("Launch storefront");
  });

  test("no failure and no sales → nothing learned (no filler)", () => {
    const quiet = fallbackLessons({
      ...baseInput,
      salesCount: 0,
      recentReports: [{ title: "Wrote FAQ", status: "done", summary: "saved" }],
    });
    expect(quiet).toHaveLength(0);
  });

  test("candidates duplicating an existing lesson are dropped", () => {
    const lessons = fallbackLessons(baseInput);
    const again = fallbackLessons({ ...baseInput, existingLessons: lessons.map((l) => l.text) });
    expect(again).toHaveLength(0);
  });

  test("distillLessons without llm config uses the fallback", async () => {
    const lessons = await distillLessons(null, baseInput);
    expect(lessons.length).toBeGreaterThan(0);
  });
});

describe("tips digest rendering stays bounded + scoped", () => {
  const tips: LessonTip[] = [
    { text: "Lead outreach with the price.", category: "outreach", scope: "company" },
    { text: "Ship the FAQ before the blog.", category: "product", scope: "company" },
    { text: "Bundle pricing converts best.", category: "pricing", scope: "conglomerate" },
    { text: "Watch the credit runway weekly.", category: "finance", scope: "company" },
  ];

  test("renders nothing for an empty sheet", () => {
    expect(renderLessonsBlock([])).toBe("");
  });

  test("hard caps the number of lines", () => {
    const many: LessonTip[] = Array.from({ length: 30 }, (_, i) => ({
      text: `tip ${i}`,
      category: "general",
      scope: "company" as const,
    }));
    const lines = renderLessonsBlock(many, { max: 5 }).split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(5);
  });

  test("CMO sees only its category slice; CTO never sees finance", () => {
    const cmo = renderLessonsBlock(tips, { categories: DEPARTMENT_CATEGORIES.cmo });
    expect(cmo).toContain("Lead outreach");
    expect(cmo).toContain("Bundle pricing"); // pricing is in the CMO slice
    expect(cmo).not.toContain("credit runway"); // finance is not

    const cto = renderLessonsBlock(tips, { categories: DEPARTMENT_CATEGORIES.cto });
    expect(cto).toContain("Ship the FAQ");
    expect(cto).not.toContain("credit runway");
  });

  test("conglomerate tips are labelled 'shared'", () => {
    const block = renderLessonsBlock(tips);
    expect(block).toContain("[shared] Bundle pricing converts best.");
  });
});
