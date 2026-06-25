import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundled binary assets dropped into every site (like design-system.css). The
 * Inter font files (OFL) are loaded once at startup — the same buffers are
 * served to pages via @font-face AND fed to resvg for the OG card, so the share
 * image and the live page share one typeface.
 */

const ASSETS = join(import.meta.dir, "..", "assets");

const read = (name: string) => readFileSync(join(ASSETS, name));

export const FONT_REGULAR = read("inter-400.ttf");
export const FONT_BOLD = read("inter-700.ttf");

/** Files served at the site root (filename → bytes). */
export const FONT_FILES: Record<string, Uint8Array> = {
  "font-400.ttf": FONT_REGULAR,
  "font-700.ttf": FONT_BOLD,
};
