/**
 * House icon set (§6) — a tiny offline SVG sprite dropped into every site, like
 * the design system. Icons from Lucide (https://lucide.dev, ISC/MIT — free, no
 * API, no network). Pages reference them with:
 *   <svg class="icon"><use href="icons.svg#zap"/></svg>
 * Stroke/size/colour come from the `.icon` class in the design system, so an icon
 * always matches the surrounding text colour and the house line weight.
 *
 * Keep this set small and generic — feature bullets, trust cues, contact. The
 * agent is told (loop.ts) to pick from these ids, so adding one here makes it
 * available everywhere; renaming one breaks pages that used the old id.
 */

export const ICON_SPRITE_FILENAME = "icons.svg";

/** Bump when the sprite changes so caches/audits can tell versions apart. */
export const ICON_SPRITE_VERSION = "1.0.0";

/** Lucide path bodies (viewBox 0 0 24 24, drawn by the `.icon` stroke style). */
const ICONS: Record<string, string> = {
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  sparkles:
    '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4"/><path d="M21 5h-4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "check-circle":
    '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m22 4-10 10.01L9 11"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  heart:
    '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  "trending-up":
    '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
  package:
    '<path d="M16.5 9.4 7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};

/** The list of usable icon ids, for the agent prompt + audits. */
export const ICON_IDS = Object.keys(ICONS);

export const ICON_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
${ICON_IDS.map((id) => `  <symbol id="${id}" viewBox="0 0 24 24">${ICONS[id]}</symbol>`).join("\n")}
</svg>
`;
