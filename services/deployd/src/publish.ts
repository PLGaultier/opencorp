import { mkdir, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * Publishes a static site into the directory Caddy serves per subdomain:
 *   {SITES_DIR}/{slug}/index.html  →  https://{slug}.{domain}
 * Writes are atomic (tmp file + rename) so a deploy never serves a torn page.
 * Idempotent: redeploys simply overwrite.
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
  for (const [rel, content] of Object.entries(input.files)) {
    if (rel.includes("..")) throw new Error(`path escape: ${rel}`);
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  }
  return { root };
}
