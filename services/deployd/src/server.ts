import { Hono } from "hono";
import { z } from "zod";
import { renderLanding } from "./template";
import { publishSite } from "./publish";

/** deployd HTTP API — called by Temporal activities (and later web-mcp). */

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

app.post("/deploy/landing", async (c) => {
  const body = DeployLanding.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const d = body.data;
  const html = renderLanding({
    companyName: d.companyName,
    slug: d.slug,
    emailAddress: d.emailAddress,
    umamiSiteId: d.umamiSiteId,
    umamiUrl: process.env.UMAMI_URL,
    copy: d.copy,
  });
  const { root } = await publishSite({ slug: d.slug, files: { "index.html": html } });
  const domain = process.env.OPENCORP_DOMAIN ?? "localhost";
  return c.json({ ok: true, root, url: `http://${d.slug}.${domain}` });
});

// raw file deploy (used by worker agents in M2+ via web-mcp deploy_site)
app.post("/deploy/files", async (c) => {
  const body = z
    .object({ slug: z.string(), files: z.record(z.string()) })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_input", detail: body.error.message }, 400);
  const { root } = await publishSite(body.data);
  return c.json({ ok: true, root });
});

const port = Number(process.env.PORT ?? 3002);
console.log(`deployd listening on :${port}, sites dir: ${process.env.SITES_DIR ?? "/srv/sites"}`);
export default { port, fetch: app.fetch };
