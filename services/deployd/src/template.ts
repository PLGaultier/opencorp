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

// House icons (from icons.svg, dropped into every site by publishSite) cycled
// across the feature cards so a text-only first site still has visual anchors.
const FEATURE_ICONS = ["zap", "shield", "sparkles", "trending-up", "heart", "package"];
const icon = (id: string) => `<svg class="icon"><use href="icons.svg#${id}"/></svg>`;

export function renderLanding(input: LandingInput): string {
  const { copy } = input;
  const umami =
    input.umamiSiteId && input.umamiUrl
      ? `<script defer src="${esc(input.umamiUrl)}/script.js" data-website-id="${esc(input.umamiSiteId)}"></script>`
      : "";
  // Features render as a grid of icon cards (Marc's "pair a headline with one
  // image" — here the icon is the image). 2-up by default, 3-up when there are
  // exactly three. All spacing/colour from the design-system tokens — no inline
  // styles. The icon badge is what lifts this above a wall of text.
  const cols = copy.sections.length === 3 ? "grid--3" : "grid--2";
  const cards = copy.sections
    .map(
      (s, i) => `
      <div class="card feature">
        <span class="feature-icon">${icon(FEATURE_ICONS[i % FEATURE_ICONS.length]!)}</span>
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.body)}</p>
      </div>`,
    )
    .join("");
  const sections = copy.sections.length
    ? `
  <section class="section section--alt">
    <div class="container">
      <div class="grid ${cols}">${cards}
      </div>
    </div>
  </section>`
    : "";
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
      <span class="badge">${icon("sparkles")} Autonomous company</span>
      <h1 class="mt-headline">${esc(copy.headline)}</h1>
      <p class="sub">${esc(copy.subheadline)}</p>
      ${contact}
    </div>
  </section>
  ${sections}
  <section class="section">
    <div class="container text-center stack">
      <h2>${esc(copy.cta)}</h2>
      <p>${esc(copy.subheadline)}</p>
      ${contact}
    </div>
  </section>
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
