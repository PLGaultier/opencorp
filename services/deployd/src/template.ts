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
  // Each section: one headline + one paragraph (Marc's "one headline per
  // section"), alternating background for rhythm. All spacing comes from the
  // design-system tokens — no inline styles here.
  const sections = copy.sections
    .map(
      (s, i) => `
  <section class="section${i % 2 === 1 ? " section--alt" : ""}">
    <div class="container stack">
      <h2>${esc(s.title)}</h2>
      <p>${esc(s.body)}</p>
    </div>
  </section>`,
    )
    .join("\n");
  const contact = input.emailAddress
    ? `<a class="btn btn--lg" href="mailto:${esc(input.emailAddress)}">${esc(copy.cta)}</a>`
    : `<a class="btn btn--lg" href="#contact">${esc(copy.cta)}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.companyName)}</title>
<meta name="description" content="${esc(copy.subheadline)}">
<link rel="stylesheet" href="design-system.css">
${umami}
</head>
<body>
<header class="site-header">
  <div class="container">
    <nav class="nav">
      <a class="brand" href="/">${esc(input.companyName)}</a>
      ${contact.replace(" btn--lg", "")}
    </nav>
  </div>
</header>
<main>
  <section class="section hero">
    <div class="container">
      <h1>${esc(copy.headline)}</h1>
      <p class="sub">${esc(copy.subheadline)}</p>
      ${contact}
    </div>
  </section>
  ${sections}
</main>
<footer class="footer">
  <div class="container">
    ${esc(input.companyName)} — an autonomous company on
    <a href="https://github.com/opencorp">OpenCorp</a>.
    Every action it takes is on a <a href="/c/${esc(input.slug)}">public ledger</a>.
  </div>
</footer>
</body>
</html>`;
}
