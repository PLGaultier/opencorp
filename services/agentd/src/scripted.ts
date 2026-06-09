import { callTool } from "@opencorp/mcp-client";
import type { WorkerTaskInput, WorkerTaskResult } from "./loop";

/**
 * Deterministic worker policy used when no LLM endpoint is configured
 * (LITELLM_URL unset). Exercises the full real pipeline — gateway, tools,
 * ledger, deploy — with scripted decisions, so the M2 exit test and demos
 * run without any API key. A task titled with "[fail]" throws, to exercise
 * the auto-refund path.
 */
export async function scriptedPolicy(input: WorkerTaskInput): Promise<WorkerTaskResult> {
  const call = (server: string, tool: string, args: unknown) =>
    callTool(input.gatewayUrl, input.token, server, tool, args);

  if (input.task.title.toLowerCase().includes("[fail]")) {
    throw new Error("scripted failure (testing auto-refund)");
  }

  input.onStep?.({ n: 1, thought: "Reading mission for context", tool: "org.read_mission" });
  const mission = await call("org", "read_mission", {});

  // M3 sell-a-product flow: list a product, get its payment link, publish a
  // storefront that links to it, and announce the launch by email — every step
  // on the public ledger, zero human action (§14 M3 exit).
  if (/sell|product|launch|store|monetiz|revenue|pricing/i.test(input.task.title)) {
    input.onStep?.({ n: 2, thought: "Creating a digital product", tool: "payments.create_product" });
    const product = await call("payments", "create_product", {
      name: `${input.company.name} — Starter`,
      priceCents: 1900,
      currency: "eur",
    });
    if (!product.ok) throw new Error(`create_product failed: ${JSON.stringify(product)}`);
    const { productId, paymentLink } = product.result as { productId: string; paymentLink: string };

    input.onStep?.({ n: 3, thought: "Publishing the storefront", tool: "web.deploy_site" });
    const html = storefront(input.company, input.task.title, paymentLink);
    const deploy = await call("web", "deploy_site", { files: { "index.html": html } });
    if (!deploy.ok) throw new Error(`deploy failed: ${JSON.stringify(deploy)}`);

    input.onStep?.({ n: 4, thought: "Announcing the launch by email", tool: "email.send_email" });
    await call("email", "send_email", {
      to: ["press@example.com"],
      subject: `${input.company.name} is live`,
      body: `${input.company.mission}\n\nOur first product is available now: ${paymentLink}\n\nUnsubscribe anytime.`,
    });

    return {
      summary: `Launched product ${productId} for "${input.task.title}", published storefront, and announced it. Payment link: ${paymentLink}.`,
      steps: 4,
    };
  }

  input.onStep?.({ n: 2, thought: "Writing work report", tool: "docs.create_document" });
  await call("docs", "create_document", {
    title: `Report: ${input.task.title}`,
    content: `Task: ${input.task.title}\n\n${input.task.description}\n\nMission context: ${JSON.stringify(mission.result)}\n\nCompleted by scripted worker policy (no LLM configured).`,
  });

  // tasks that touch the site redeploy it with a v2 marker
  if (/landing|site|page|website/i.test(input.task.title)) {
    input.onStep?.({ n: 3, thought: "Improving and redeploying the site", tool: "web.deploy_site" });
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.company.name)}</title>
<style>body{font-family:system-ui;max-width:680px;margin:4rem auto;padding:0 1.5rem;line-height:1.6}</style>
</head><body>
<h1>${esc(input.company.name)}</h1>
<p>${esc(input.company.mission)}</p>
<p><em>Improved autonomously by a worker agent — task: ${esc(input.task.title)} (v2).</em></p>
<footer><small>Every action on the <a href="/c/${esc(input.company.slug)}">public ledger</a>.</small></footer>
</body></html>`;
    const deploy = await call("web", "deploy_site", { files: { "index.html": html } });
    if (!deploy.ok) throw new Error(`deploy failed: ${JSON.stringify(deploy)}`);
    return { summary: `Updated and redeployed the site for task "${input.task.title}".`, steps: 3 };
  }

  return { summary: `Completed "${input.task.title}": report written to the knowledge base.`, steps: 2 };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function storefront(
  company: { name: string; mission: string; slug: string },
  task: string,
  paymentLink: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(company.name)} — Store</title>
<style>body{font-family:system-ui;max-width:680px;margin:4rem auto;padding:0 1.5rem;line-height:1.6}
.buy{display:inline-block;margin:1rem 0;padding:.75rem 1.5rem;background:#111;color:#fff;border-radius:8px;text-decoration:none}</style>
</head><body>
<h1>${esc(company.name)}</h1>
<p>${esc(company.mission)}</p>
<h2>${esc(company.name)} — Starter</h2>
<p>€19.00 — instant access.</p>
<a class="buy" href="${esc(paymentLink)}">Buy now</a>
<p><em>Listed autonomously by a worker agent — task: ${esc(task)}.</em></p>
<footer><small>Every action on the <a href="/c/${esc(company.slug)}">public ledger</a>.</small></footer>
</body></html>`;
}
