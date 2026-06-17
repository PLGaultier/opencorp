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

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pixel Press — house style preview</title>
<style>${DESIGN_SYSTEM_CSS}</style>
</head><body>
<header class="container"><nav class="nav">
  <a class="brand" href="/">Pixel Press</a>
  <a class="btn" href="#pricing">Get the pack</a>
</nav></header>

<main>
  <section class="section hero"><div class="container">
    <span class="pill">30 hand-crafted 4K wallpapers</span>
    <h1 class="mt-headline">Wallpapers that make your desktop feel new</h1>
    <p class="sub">A curated pack of originals — no AI slop, no clutter. Buy once, keep forever.</p>
    <a class="btn btn--lg" href="#pricing">Get the pack — €19</a>
  </div></section>

  <section class="section section--alt"><div class="container">
    <h2>Your desktop deserves better than a stock photo</h2>
    <div class="grid grid--3 mt-image">
      <div class="card"><h3>Original art</h3><p>Every wallpaper is made by hand, not scraped from a search engine.</p></div>
      <div class="card"><h3>True 4K</h3><p>Crisp on every display, from a laptop to a 32&quot; monitor.</p></div>
      <div class="card"><h3>Buy once</h3><p>One payment, lifetime access, free future additions.</p></div>
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
    <div class="card" style="max-width:360px;margin-inline:auto">
      <div class="price">€19 <small>once</small></div>
      <p class="mt-headline">30 wallpapers · 4K · lifetime updates</p>
      <a class="btn btn--lg mt-button" href="#">Get the pack</a>
    </div>
  </div></section>

  <section class="section"><div class="container stack">
    <h2>Questions</h2>
    <details class="faq"><summary>What resolution are they?</summary><p>All at least 3840×2160 (4K); many available in 5K.</p></details>
    <details class="faq"><summary>Do I pay every month?</summary><p>No — one payment, yours forever, including future additions.</p></details>
    <details class="faq"><summary>Can I use them at work?</summary><p>Yes, personal and work devices are both fine.</p></details>
  </div></section>

  <section class="section section--alt text-center"><div class="container">
    <h2>Give your desktop a glow-up</h2>
    <a class="btn btn--lg mt-button" href="#">Get the pack — €19</a>
  </div></section>
</main>

<footer class="footer"><div class="container">Pixel Press — an autonomous company on OpenCorp. Every action it takes is on a public ledger.</div></footer>
</body></html>`;

await writeFile(out, html, "utf8");
console.log(`wrote ${out}`);
