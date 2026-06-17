import { mkdir, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DESIGN_SYSTEM_CSS, DESIGN_SYSTEM_FILENAME } from "./design-system";

/**
 * Publishes a static site into the directory Caddy serves per subdomain:
 *   {SITES_DIR}/{slug}/index.html  →  https://{slug}.{domain}
 * Writes are atomic (tmp file + rename) so a deploy never serves a torn page.
 * Idempotent: redeploys simply overwrite.
 *
 * Every publish also drops the canonical design system (§6) at the site root, so
 * pages can `<link rel="stylesheet" href="design-system.css">` and inherit the
 * house style — whether the page came from the landing template or an agent
 * deploy. The agent can't override the house tokens: we always write our copy.
 */

export interface PublishInput {
  slug: string;
  files: Record<string, string>; // relative path -> content
}

export function sitesDir(): string {
  return process.env.SITES_DIR ?? "/srv/sites";
}

export async function publishSite(input: PublishInput): Promise<{ root: string }> {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(input.slug)) {
    throw new Error(`invalid slug: ${input.slug}`);
  }
  const root = join(sitesDir(), input.slug);
  // The house design system is always ours — overwrite any agent-supplied copy.
  const files: Record<string, string> = { ...input.files, [DESIGN_SYSTEM_FILENAME]: DESIGN_SYSTEM_CSS };
  for (const [rel, content] of Object.entries(files)) {
    if (rel.includes("..")) throw new Error(`path escape: ${rel}`);
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  }
  return { root };
}
