import { DESIGN_SYSTEM_FILENAME } from "./design-system";

/**
 * Publish-time guardrail (§6). The design system + prompt push the agent toward
 * the house style, but nothing stopped a page from drifting — inline styles,
 * hardcoded colours, or the malformed `grid--2/3` class the prompt used to leak.
 * `sanitizeSiteHtml` applies the few SAFE auto-fixes and reports the rest, so a
 * deploy is always at least on-brand and we can see when a page misbehaves.
 *
 * Deliberately conservative: it never strips inline styles (that would break
 * legitimate inline <svg> hero art) — it fixes the unambiguous bug, guarantees
 * the stylesheet link, optionally wires the og:image meta, and counts the rest.
 */

const LINK_TAG = `<link rel="stylesheet" href="${DESIGN_SYSTEM_FILENAME}">`;

export interface SanitizeOptions {
  /** Absolute URL of the generated share card — injects og/twitter meta if absent. */
  ogImageUrl?: string;
}

export interface SanitizeResult {
  html: string;
  /** Human-readable notes for logs/audits (not fatal). */
  warnings: string[];
}

export function sanitizeSiteHtml(input: string, opts: SanitizeOptions = {}): SanitizeResult {
  let html = input;
  const warnings: string[] = [];

  // 1. Unambiguous bug: `grid--2/3` (and any `grid--N/M`) is never a real class —
  //    the agent meant one column count. Default to two.
  const badGrid = html.match(/grid--\d+\/\d+/g);
  if (badGrid) {
    html = html.replace(/grid--(\d+)\/\d+/g, "grid--$1");
    warnings.push(`fixed ${badGrid.length} malformed grid class (grid--N/M → grid--N)`);
  }

  // 2. Guarantee the house stylesheet is linked.
  if (!html.includes(DESIGN_SYSTEM_FILENAME)) {
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `  ${LINK_TAG}\n</head>`);
    else html = `${LINK_TAG}\n${html}`;
    warnings.push("design-system.css link was missing — injected");
  }

  // 3. Wire the share card if one was generated and the page has no og:image.
  if (opts.ogImageUrl && !/property=["']og:image["']/i.test(html)) {
    const meta = ogMeta(opts.ogImageUrl);
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${meta}\n</head>`);
    warnings.push("og:image was missing — injected");
  }

  // 4. Report (don't strip) off-brand patterns so drift is visible.
  const inlineStyles = (html.match(/\sstyle=/gi) ?? []).length;
  if (inlineStyles) warnings.push(`${inlineStyles} inline style="…" attribute(s) — should use design-system classes`);
  const hardColors = (html.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).filter(
    // ignore colours inside an inline <svg> (legit) is hard without a parser;
    // count all and let the number flag egregious cases.
    () => true,
  ).length;
  if (hardColors > 6) warnings.push(`${hardColors} hardcoded hex colour(s) — prefer the palette tokens`);

  return { html, warnings };
}

/** og:image + Twitter card meta for a share image URL. */
export function ogMeta(url: string): string {
  const u = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `  <meta property="og:image" content="${u}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${u}">`;
}
