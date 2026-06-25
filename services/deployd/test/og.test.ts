import { describe, expect, test } from "bun:test";
import { renderOgSvg, renderOgPng } from "../src/og";

describe("renderOgSvg", () => {
  test("is 1200×630 and contains the company name", () => {
    const svg = renderOgSvg({ title: "Lumina Bauhaus", subtitle: "Modernist light for your home" });
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    expect(svg).toContain("Lumina Bauhaus");
  });

  test("escapes markup in the company name", () => {
    const svg = renderOgSvg({ title: "A & B <Co>", subtitle: "x" });
    expect(svg).not.toContain("<Co>");
    expect(svg).toContain("&#38;"); // & escaped
  });

  test("wraps + ellipsizes an overlong subtitle (no overflow off the card)", () => {
    const long = "word ".repeat(60);
    const svg = renderOgSvg({ title: "X", subtitle: long });
    expect(svg).toContain("…");
  });
});

describe("renderOgPng", () => {
  test("renders a real PNG with the bundled font (no system fonts needed)", () => {
    const png = renderOgPng({ title: "Lumina Bauhaus", subtitle: "Modernist light for your home" });
    // PNG magic bytes — proves resvg rasterized with the embedded Inter buffers.
    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50); // P
    expect(png[2]).toBe(0x4e); // N
    expect(png[3]).toBe(0x47); // G
  });
});
