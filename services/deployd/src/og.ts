import { Resvg } from "@resvg/resvg-js";
import { FONT_BOLD, FONT_REGULAR } from "./assets";

/**
 * Social share image (§6). Sites had no og:image, so a shared link rendered as a
 * bare text rectangle on Twitter/LinkedIn/iMessage and in ad previews. We render
 * a branded 1200×630 card per company — purely from the company name + tagline,
 * no photos, no paid API. SVG → PNG via resvg with the bundled Inter font, so it
 * renders identically on a fontless prod container (loadSystemFonts: false).
 */

// The same Inter files are served to sites via @font-face, so the OG card and
// the live page share one typeface.
const FONTS = [FONT_BOLD, FONT_REGULAR];

// House palette (kept in sync with design-system.ts — SVG can't read CSS vars).
const C = {
  base100: "#ffffff",
  baseContent: "#18181b",
  baseSecondary: "#52525b",
  base300: "#e4e4e7",
  primary: "#2563eb",
  accent: "#f59e0b",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Greedy word-wrap to at most `maxLines` lines of ~`maxChars` characters.
 * Ellipsizes the last line if the text didn't fit. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i]!;
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = w;
      if (lines.length === maxLines - 1) break; // last allowed line started
    }
  }
  if (line) lines.push(line);
  const truncated = i < words.length - 1; // we broke before consuming all words
  if (truncated && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1]!.replace(/[.,;:]?$/, "")}…`;
  }
  return lines.slice(0, maxLines);
}

export interface OgInput {
  title: string; // company name
  subtitle: string; // tagline / subheadline
}

/** The branded card as SVG markup. */
export function renderOgSvg({ title, subtitle }: OgInput): string {
  const titleLines = wrap(title, 22, 2);
  const titleSize = titleLines.length > 1 ? 84 : 96;
  const subLines = wrap(subtitle, 54, 2);
  const startY = 250 - (titleLines.length - 1) * (titleSize * 0.55);

  const titleTspans = titleLines
    .map((l, i) => `<text x="90" y="${startY + i * (titleSize + 8)}" font-family="Inter" font-weight="700" font-size="${titleSize}" fill="${C.baseContent}">${esc(l)}</text>`)
    .join("");
  const subY = startY + titleLines.length * (titleSize + 8) + 24;
  const subTspans = subLines
    .map((l, i) => `<text x="90" y="${subY + i * 52}" font-family="Inter" font-weight="400" font-size="38" fill="${C.baseSecondary}">${esc(l)}</text>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="o1" cx="0%" cy="0%" r="80%">
      <stop offset="0%" stop-color="${C.primary}" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="${C.primary}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="o2" cx="100%" cy="0%" r="70%">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity="0.20"/>
      <stop offset="60%" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="${C.base100}"/>
  <rect width="1200" height="630" fill="url(#o1)"/>
  <rect width="1200" height="630" fill="url(#o2)"/>
  <rect x="90" y="${startY - titleSize - 28}" width="64" height="8" rx="4" fill="${C.primary}"/>
  ${titleTspans}
  ${subTspans}
  <line x1="90" y1="556" x2="1110" y2="556" stroke="${C.base300}" stroke-width="2"/>
  <circle cx="104" cy="588" r="9" fill="${C.primary}"/>
  <text x="126" y="597" font-family="Inter" font-weight="700" font-size="26" fill="${C.baseContent}">${esc(title)}</text>
  <text x="1110" y="597" text-anchor="end" font-family="Inter" font-weight="400" font-size="24" fill="${C.baseSecondary}">built on OpenCorp</text>
</svg>`;
}

/** Render the branded card to a PNG buffer. */
export function renderOgPng(input: OgInput): Buffer {
  const svg = renderOgSvg(input);
  const r = new Resvg(svg, {
    font: { fontBuffers: FONTS, defaultFontFamily: "Inter", loadSystemFonts: false },
    fitTo: { mode: "width", value: 1200 },
  });
  return r.render().asPng();
}

export const OG_FILENAME = "og.png";
