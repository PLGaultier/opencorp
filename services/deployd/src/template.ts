/**
 * Fast-path landing template (§6 step 3): rendered server-side with no agent
 * involvement so prompt → live site stays well under the 60 s target.
 */

export interface LandingCopy {
  headline: string;
  subheadline: string;
  cta: string;
  sections: { title: string; body: string }[];
}

export interface LandingInput {
  companyName: string;
  slug: string;
  emailAddress?: string;
  copy: LandingCopy;
  umamiSiteId?: string;
  umamiUrl?: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderLanding(input: LandingInput): string {
  const { copy } = input;
  const umami =
    input.umamiSiteId && input.umamiUrl
      ? `<script defer src="${esc(input.umamiUrl)}/script.js" data-website-id="${esc(input.umamiSiteId)}"></script>`
      : "";
  const sections = copy.sections
    .map(
      (s) => `
      <section>
        <h2>${esc(s.title)}</h2>
        <p>${esc(s.body)}</p>
      </section>`,
    )
    .join("\n");
  const contact = input.emailAddress
    ? `<a class="cta" href="mailto:${esc(input.emailAddress)}">${esc(copy.cta)}</a>`
    : `<a class="cta" href="#contact">${esc(copy.cta)}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.companyName)}</title>
<meta name="description" content="${esc(copy.subheadline)}">
${umami}
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; line-height: 1.6; }
  main { max-width: 720px; margin: 0 auto; padding: 4rem 1.5rem; }
  h1 { font-size: 2.5rem; margin-bottom: .5rem; }
  .sub { font-size: 1.2rem; opacity: .8; }
  .cta { display: inline-block; margin: 1.5rem 0; padding: .75rem 1.5rem;
         background: #111; color: #fff; border-radius: 8px; text-decoration: none; }
  @media (prefers-color-scheme: dark) { .cta { background: #fff; color: #111; } }
  section { margin-top: 2.5rem; }
  footer { margin-top: 4rem; font-size: .85rem; opacity: .6; }
</style>
</head>
<body>
<main>
  <h1>${esc(copy.headline)}</h1>
  <p class="sub">${esc(copy.subheadline)}</p>
  ${contact}
  ${sections}
  <footer>
    <p>${esc(input.companyName)} — an autonomous company on
    <a href="https://github.com/opencorp">OpenCorp</a>.
    Every action it takes is on a <a href="/c/${esc(input.slug)}">public ledger</a>.</p>
  </footer>
</main>
</body>
</html>`;
}
