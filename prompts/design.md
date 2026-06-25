# Website Design Brief — House Style (v1)

The canonical design rules for every company website. Distilled from Marc Lou's
"Design beautiful websites to sell your product" series. Philosophy: **forget
creativity, design is about rules.** These rules are encoded in
`design-system.css` (served at the root of every site) — build with its classes,
don't reinvent them.

> This file is the human-readable source of truth. The worker agent gets a
> condensed version in its system prompt (`services/agentd/src/loop.ts`); the
> machine-enforced part is `services/deployd/src/design-system.ts`, which
> `publishSite` drops into every deploy.

## Always
- Link the design system: `<link rel="stylesheet" href="design-system.css">`.
- Use the tokens/classes; **never** hardcode colors/spacing or ship big inline
  `<style>` blocks. If something's missing, get as close as you can with existing
  classes rather than inventing a new palette.

## Spacing — 4-point grid
- Every margin/padding is divisible by 4.
- Relationship = distance. Use the semantic gaps:
  - paragraph → headline: `16px` (`--gap-headline`, `.stack`, `.mt-headline`)
  - button → text block: `32px` (`.mt-button`)
  - image → text block: `48px` (`.mt-image`)
  - section → section: huge — `--gap-section` (≈256px desktop). Use `.section`.
- When unsure, add **more** whitespace, not less.

## Headlines
- One headline per section — not zero, not two. Pair it with one paragraph, one
  image, one button.
- Sizes come from tokens: H1 ≈ 60px desktop / 32–40px mobile, H2 ≈ 48px (fluid).
- One heading weight everywhere (800). Tight line-height, slight negative
  letter-spacing (in the tokens). Keep to ≤ 2 lines / ~70 characters.
- Color: `--base-content` (strongest contrast). Don't color headlines with the
  primary — only for highlighting a number.

## Paragraphs / body
- 16px, weight 400; emphasis uses weight 600 + `--base-content` (`<strong>` or
  `.emphasis`).
- Loose line-height (1.7) so it breathes. Left-aligned. Cap line length (~500px,
  `--measure`) — `<p>` does this automatically.
- Short: ≤ 3 sentences per paragraph; prefer bullets over walls of text.

## Color — max 4 roles
- "Colors are like beers — messy after 3 or 4." Roles: `--primary` (the single
  CTA color), `--primary-content`, `--base-100` (bg), `--base-content` (headlines),
  with `--base-200/300` and `--base-content-secondary` for hierarchy.
- Only **one** call-to-action color. Never pure black (the tokens use zinc/night).

## Page structure (landing)
hero → problem/pain → solution/features → social proof (testimonials, stars,
avatars) → pricing → FAQ → final CTA. One repeated primary CTA throughout.

## Make it appealing (DataFast easy-wins)
These punch above their weight — use them:
- **Highlight one keyword** in the H1: `<span class="highlight">word</span>` (marker
  swipe) or `.text-gradient`. One word, not the whole line.
- **Reassurance microcopy** under the hero CTA: `<p class="reassure">No card required</p>`.
- **Social proof row** in the hero: `.social-proof` = `.stars` + a real "Loved by
  N users" count. Only with **real** numbers — never fabricate proof. Skip the
  `.avatars` (faces) unless you have **real** user photos — no placeholder faces.
- **Framed screenshot**: put product images in `.app-frame` (faux browser bar + big
  soft shadow) — instantly looks like a real product.
- **Stat callouts** (`.stats` / `.stat`), **badges** (`.badge` for "Featured on"/awards),
  and a **featured pricing card** (`.card--featured` + `.ribbon` "Most popular").
- Soft shadows, the sticky blurred header (`.site-header`), and the hero glow are
  automatic — don't fight them.

## Visuals without photos (no image APIs)
Every page needs visual anchors — never ship a wall of text. We don't use photo
APIs, so lean on these (all free, all in the design system):
- **Icons** — the sprite `icons.svg` is dropped into every site. Reference an icon
  with `<svg class="icon"><use href="icons.svg#zap"/></svg>`. Ids: `zap` `sparkles`
  `shield` `check` `check-circle` `star` `clock` `heart` `trending-up` `lock`
  `globe` `mail` `package` `users`. Give each feature card an icon badge:
  `<div class="card feature"><span class="feature-icon"><svg class="icon"><use href="icons.svg#zap"/></svg></span><h3>…</h3><p>…</p></div>`.
- **Hero art** — emit an inline `<svg>` of abstract shapes (no photo) in
  `<div class="hero-art">`. The hero already has an automatic glow + orbs + dot grid.
- **Ambient colour** — drop a `<div class="blob">` / `.blob--accent` in a
  `position:relative` section for a soft gradient.
- The agent never hardcodes colours/spacing and never uses `style="…"` inline.
- **Automatic on deploy** (don't build these): the self-hosted **Inter** font, a
  branded **social share image** (`og.png` + og/twitter meta) rendered from the
  `<title>` + description, and a publish-time linter that fixes the stylesheet
  link + malformed `grid--N/M` classes. Just write a clean `<title>` and
  `<meta name="description">`.

## Components available
`.container` `.site-header` `.nav` `.section` `.section--alt` `.hero` `.btn` `.btn--lg`
`.btn--ghost` `.card` `.card--featured` `.ribbon` `.grid` `.grid--2` `.grid--3`
`.highlight` `.text-gradient` `.badge` `.social-proof` `.avatars` `.avatar` `.stars`
`.reassure` `.stats` `.stat` `.app-frame` `.testimonial` `.price` `.founder` `.faq`
`.footer` `.pill` `.stack` `.mt-headline` `.mt-button` `.mt-image` `.icon`
`.feature` `.feature-icon` `.blob` `.blob--accent` `.hero-art`.
