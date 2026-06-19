/**
 * Renders a self-contained showcase of the house design system (Marc Lou rules)
 * to a single openable HTML file — hero, features, social proof, pricing, FAQ,
 * final CTA — with the CSS inlined so it opens anywhere. For eyeballing the
 * style; the real sites link design-system.css instead.
 *
 *   bun services/deployd/scripts/design-preview.ts [outPath]
 */
import { writeFile } from "node:fs/promises";
import { DESIGN_SYSTEM_CSS } from "../src/design-system";

const out = process.argv[2] ?? "/tmp/opencorp-design-preview.html";

// All preview imagery is inline SVG (data URIs) so the file renders fully
// offline — no external requests, nothing to "fail to load". Real sites supply
// their own real image URLs.
const svg = (markup: string) => "data:image/svg+xml;utf8," + encodeURIComponent(markup);

const shot = svg(
  `<svg xmlns='http://www.w3.org/2000/svg' width='980' height='560'><rect width='980' height='560' fill='#eef2ff'/><rect x='40' y='40' width='420' height='40' rx='8' fill='#c7d2fe'/><rect x='40' y='110' width='900' height='180' rx='12' fill='#dbeafe'/><rect x='40' y='320' width='280' height='200' rx='12' fill='#e0e7ff'/><rect x='350' y='320' width='280' height='200' rx='12' fill='#e0e7ff'/><rect x='660' y='320' width='280' height='200' rx='12' fill='#e0e7ff'/></svg>`,
);

// A round avatar: colored circle + an initial. Self-contained.
const avatar = (bg: string, initial: string) =>
  svg(
    `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><circle cx='40' cy='40' r='40' fill='${bg}'/><text x='40' y='52' font-family='sans-serif' font-size='34' font-weight='700' fill='white' text-anchor='middle'>${initial}</text></svg>`,
  );
const heroAvatars = [
  ["#2563eb", "A"], ["#f59e0b", "S"], ["#10b981", "J"], ["#ef4444", "R"], ["#8b5cf6", "K"],
]
  .map(([bg, i]) => `<img class="avatar" src="${avatar(bg!, i!)}" alt="">`)
  .join("");
const founderPhoto = avatar("#0ea5e9", "M");

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pixel Press — house style preview</title>
<style>${DESIGN_SYSTEM_CSS}</style>
</head><body>
<header class="site-header"><div class="container"><nav class="nav">
  <a class="brand" href="/">🖼️ Pixel Press</a>
  <a class="btn" href="#pricing">Get the pack</a>
</nav></div></header>

<main>
  <section class="section hero"><div class="container stack">
    <span class="badge">🏆 Product Hunt — Pack of the Day</span>
    <h1 class="mt-headline">Wallpapers that make your desktop feel <span class="highlight">brand new</span></h1>
    <p class="sub">A curated pack of originals — no AI slop, no clutter. Buy once, keep forever.</p>
    <a class="btn btn--lg" href="#pricing">Get the pack — €19</a>
    <p class="reassure">Instant download · 30-day money-back guarantee</p>
    <div class="social-proof mt-button">
      <div class="avatars">${heroAvatars}</div>
      <span class="stars">★★★★★</span>
      <span class="count">Loved by <b>4,210</b> desktops</span>
    </div>
  </div></section>

  <section class="section"><div class="container">
    <div class="app-frame"><div class="bar"></div><img src="${shot}" alt="Preview of the wallpaper pack"></div>
  </div></section>

  <section class="section"><div class="container">
    <div class="stats text-center">
      <div class="stat"><span class="num">30</span><span class="label">original wallpapers</span></div>
      <div class="stat"><span class="num">4K+</span><span class="label">every display</span></div>
      <div class="stat"><span class="num">4,210</span><span class="label">happy desktops</span></div>
    </div>
  </div></section>

  <section class="section section--alt"><div class="container">
    <h2>Your desktop deserves better than a stock photo</h2>
    <div class="grid grid--3 mt-image">
      <div class="card"><h3>🎨 Original art</h3><p>Every wallpaper is made by hand, not scraped from a search engine.</p></div>
      <div class="card"><h3>🖥️ True 4K</h3><p>Crisp on every display, from a laptop to a 32&quot; monitor.</p></div>
      <div class="card"><h3>♾️ Buy once</h3><p>One payment, lifetime access, free future additions.</p></div>
    </div>
  </div></section>

  <section class="section"><div class="container stack">
    <h2>Loved by people with very nice desktops</h2>
    <div class="grid grid--2 mt-image">
      <div class="testimonial"><div class="stars">★★★★★</div><p>Finally a pack that isn't 200 mediocre images. Every one is a keeper.</p><div class="who">— Alex, designer</div></div>
      <div class="testimonial"><div class="stars">★★★★★</div><p>Bought it in two clicks, set one as my wallpaper before the tab even closed.</p><div class="who">— Sam, developer</div></div>
    </div>
  </div></section>

  <section class="section section--alt" id="pricing"><div class="container text-center stack">
    <h2>One price. Everything.</h2>
    <div class="card card--featured" style="max-width:380px;margin-inline:auto;margin-top:24px">
      <span class="ribbon">Best value</span>
      <div class="price">€19 <small>once</small></div>
      <p class="mt-headline">30 wallpapers · 4K · lifetime updates</p>
      <a class="btn btn--lg mt-button" href="#">Get the pack</a>
      <p class="reassure">30-day money-back guarantee</p>
    </div>
  </div></section>

  <section class="section"><div class="container">
    <div class="founder">
      <img src="${founderPhoto}" alt="">
      <div class="stack">
        <h3>Hey, I'm the maker 👋</h3>
        <p>I got tired of ugly, cluttered wallpaper sites. So I made the pack I wanted: 30 originals, one fair price, no subscriptions. If you don't love it, I'll refund you — just reply to the receipt.</p>
      </div>
    </div>
  </div></section>

  <section class="section section--alt"><div class="container stack">
    <h2>Questions</h2>
    <details class="faq"><summary>What resolution are they?</summary><p>All at least 3840×2160 (4K); many available in 5K.</p></details>
    <details class="faq"><summary>Do I pay every month?</summary><p>No — one payment, yours forever, including future additions.</p></details>
    <details class="faq"><summary>Can I use them at work?</summary><p>Yes, personal and work devices are both fine.</p></details>
  </div></section>

  <section class="section text-center"><div class="container">
    <h2>Give your desktop a <span class="text-gradient">glow-up</span></h2>
    <a class="btn btn--lg mt-button" href="#">Get the pack — €19</a>
    <p class="reassure">Instant download · 30-day money-back guarantee</p>
  </div></section>
</main>

<footer class="footer"><div class="container">Made with ☕ by Pixel Press — an autonomous company on OpenCorp. Every action it takes is on a <a href="#">public ledger</a>.</div></footer>
</body></html>`;

await writeFile(out, html, "utf8");
console.log(`wrote ${out}`);
