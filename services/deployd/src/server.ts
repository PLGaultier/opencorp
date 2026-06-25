import { Hono } from "hono";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { renderLanding } from "./template";
import { publishSite, sitesDir } from "./publish";
import { renderOgPng, OG_FILENAME } from "./og";
import { sanitizeSiteHtml } from "./lint";

/** deployd HTTP API — called by Temporal activities (and later web-mcp). */

/**
 * Where published sites are reachable. In prod Caddy serves {slug}.{domain};
 * locally there's no Caddy, so deployd serves them itself path-based at
 * {PUBLIC_SITE_URL or DEPLOYD_URL}/sites/{slug}/ (no wildcard DNS needed).
 */
function siteUrl(slug: string): string {
  // Prod: Caddy serves each company at {slug}.{SITE_DOMAIN} over the shared sites
  // volume with wildcard TLS, so report the real subdomain URL.
  const domain = process.env.SITE_DOMAIN;
  if (domain) return `https://${slug}.${domain}/`;
  // Local: no Caddy/wildcard DNS, so deployd serves the files path-based itself.
  const base = (
    process.env.PUBLIC_SITE_URL ??
    process.env.DEPLOYD_URL ??
    `http://localhost:${process.env.PORT ?? 3002}`
  ).replace(/\/$/, "");
  return `${base}/sites/${slug}/`;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const DeployLanding = z.object({
  slug: z.string(),
  companyName: z.string(),
  emailAddress: z.string().optional(),
  umamiSiteId: z.string().optional(),
  copy: z.object({
    headline: z.string(),
    subheadline: z.string(),
    cta: z.string(),
    sections: z.array(z.object({ title: z.string(), body: z.string() })),
  }),
});

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true, service: "deployd" }));

// Caddy on-demand-TLS authorization (§12): mint a cert for {host} when it is a
// control-plane subdomain (api/gw/llm) or a {slug}.{domain} whose company has a
// published site — so the wildcard can't be used to issue certs for arbitrary
// subdomains. Caddy calls this with ?domain=<host>. Control-plane names are
// on-demand too because an on-demand wildcard (*.{domain}) overlaps them and
// suppresses proactive issuance, so they must be authorized here.
const CONTROL_PLANE_LABELS = new Set(["api", "gw", "llm"]);
app.get("/exists", (c) => {
  const host = c.req.query("domain") ?? "";
  const slug = host.split(".")[0] ?? "";
  const ok =
    CONTROL_PLANE_LABELS.has(slug) ||
    (/^[a-z0-9-]{1,63}$/.test(slug) && existsSync(join(sitesDir(), slug)));
  return ok ? c.text("ok", 200) : c.text("unknown site", 404);
});

app.post("/deploy/landing", async (c) => {
  const body = DeployLanding.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const d = body.data;
  const files: Record<string, string | Uint8Array> = {};
  // Branded share card (best-effort — a render hiccup must not block the deploy).
  let ogImageUrl: string | undefined;
  try {
    files[OG_FILENAME] = renderOgPng({ title: d.companyName, subtitle: d.copy.subheadline });
    ogImageUrl = `${siteUrl(d.slug)}${OG_FILENAME}`;
  } catch (err) {
    console.warn(`og render failed for ${d.slug}:`, err instanceof Error ? err.message : err);
  }
  files["index.html"] = renderLanding({
    companyName: d.companyName,
    slug: d.slug,
    emailAddress: d.emailAddress,
    umamiSiteId: d.umamiSiteId,
    umamiUrl: process.env.UMAMI_URL,
    copy: d.copy,
    ogImageUrl,
  });
  const { root } = await publishSite({ slug: d.slug, files });
  return c.json({ ok: true, root, url: siteUrl(d.slug) });
});

// Serve published sites path-based so they're reachable on a plain laptop
// (no Caddy / wildcard DNS). {slug} → SITES_DIR/{slug}/{path or index.html}.
app.get("/sites/:slug", (c) => c.redirect(`/sites/${c.req.param("slug")}/`));
app.get("/sites/:slug/*", async (c) => {
  const slug = c.req.param("slug");
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return c.text("not found", 404);
  let rel = c.req.path.slice(`/sites/${slug}/`.length);
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel.includes("..")) return c.text("bad path", 400);
  try {
    const data = await readFile(join(sitesDir(), slug, rel));
    return new Response(data, {
      headers: { "content-type": MIME[extname(rel).toLowerCase()] ?? "application/octet-stream" },
    });
  } catch {
    return c.text("not found", 404);
  }
});

// raw file deploy (used by worker agents in M2+ via web-mcp deploy_site)
app.post("/deploy/files", async (c) => {
  const body = z
    .object({ slug: z.string(), files: z.record(z.string()) })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const { slug, files: incoming } = body.data;

  // Render a share card from the homepage's title + description, then sanitize
  // each page (fix drift, guarantee the stylesheet, wire og:image). Best-effort.
  const out: Record<string, string | Uint8Array> = {};
  let ogImageUrl: string | undefined;
  const home = incoming["index.html"];
  if (home) {
    const title = (home.match(/<title>([^<]*)<\/title>/i)?.[1] ?? slug).trim();
    const desc = (home.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] ?? "").trim();
    try {
      out[OG_FILENAME] = renderOgPng({ title, subtitle: desc || title });
      ogImageUrl = `${siteUrl(slug)}${OG_FILENAME}`;
    } catch (err) {
      console.warn(`og render failed for ${slug}:`, err instanceof Error ? err.message : err);
    }
  }
  for (const [rel, content] of Object.entries(incoming)) {
    if (rel.toLowerCase().endsWith(".html")) {
      const { html, warnings } = sanitizeSiteHtml(content, { ogImageUrl });
      if (warnings.length) console.log(`deploy ${slug}/${rel}: ${warnings.join("; ")}`);
      out[rel] = html;
    } else {
      out[rel] = content;
    }
  }
  const { root } = await publishSite({ slug, files: out });
  return c.json({ ok: true, root });
});

const port = Number(process.env.PORT ?? 3002);
console.log(`deployd listening on :${port}, sites dir: ${process.env.SITES_DIR ?? "/srv/sites"}`);
export default { port, fetch: app.fetch };
