/**
 * OpenCorp design system (§6, §14) — the house style every company site inherits.
 *
 * Distilled from Marc Lou's "Design beautiful websites to sell your product"
 * series (spacing / headlines / paragraphs / colors). The philosophy is his:
 * "forget creativity, design is about rules." We encode those rules once as
 * tokens + components so agent-built pages are always on-brand without a build
 * step. `publishSite` drops this file into every site and pages link it.
 *
 * Token vocabulary follows his (DaisyUI's) semantics: primary / primary-content
 * / base-100..300 / base-content / base-content-secondary.
 */

export const DESIGN_SYSTEM_FILENAME = "design-system.css";

/** Bump when the CSS changes so caches and audits can tell versions apart. */
export const DESIGN_SYSTEM_VERSION = "1.1.0";

export const DESIGN_SYSTEM_CSS = `/* OpenCorp design system v${DESIGN_SYSTEM_VERSION} — house style (Marc Lou rules). Do not redefine tokens; use the classes. */
:root {
  /* Colors — max 4 roles (Marc: "colors are like beers, messy after 3-4").
     Never pure black; zinc/night tones. One CTA color only. */
  --primary: #2563eb;            /* the single call-to-action color */
  --primary-hover: #1d4ed8;
  --primary-content: #ffffff;    /* text on primary */
  --accent: #f59e0b;             /* warm spark: highlights, stars, marker (not a 2nd CTA) */
  --base-100: #ffffff;           /* page background */
  --base-200: #f4f4f5;           /* cards / alternating sections */
  --base-300: #e4e4e7;           /* borders / dividers */
  --base-content: #18181b;       /* headlines & emphasis (strongest contrast) */
  --base-content-secondary: #52525b; /* body text (softer, builds hierarchy) */

  /* Elevation — soft shadows make a flat page feel premium (the easy win). */
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, .06), 0 1px 3px rgba(15, 23, 42, .08);
  --shadow: 0 4px 16px rgba(15, 23, 42, .08);
  --shadow-lg: 0 24px 60px -16px rgba(15, 23, 42, .28);
  /* Soft tinted glow behind the hero. */
  --hero-glow: radial-gradient(60% 60% at 50% 0%, color-mix(in srgb, var(--primary) 16%, transparent), transparent 70%);

  /* Spacing — 4-point grid; every gap is divisible by 4. */
  --space-1: 4px;  --space-2: 8px;  --space-3: 16px; --space-4: 32px;
  --space-5: 48px; --space-6: 64px; --space-7: 96px; --space-8: 128px;
  /* Semantic spacing (Marc's relationships). */
  --gap-headline: 16px;          /* paragraph -> headline */
  --gap-button: 32px;            /* button -> text block */
  --gap-image: 48px;             /* image -> text block */
  --gap-section: clamp(96px, 18vw, 256px); /* section -> section (big breathing room) */

  /* Type — H1 60 / H2 48 desktop, fluid down to mobile; body 16, leading 1.7. */
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --h1: clamp(2rem, 6vw, 3.75rem);    /* 32 -> 60px */
  --h2: clamp(1.75rem, 4.5vw, 3rem);  /* 28 -> 48px */
  --h3: 1.5rem;
  --text: 1rem;                       /* 16px body */
  --weight-head: 800;                 /* one heading weight, 700-900 */
  --leading-head: 1.05;               /* tight for headlines */
  --leading-body: 1.7;                /* loose for paragraphs (breathe) */
  --measure: 33ch;                    /* ~500px readable line length */

  --radius: 12px;
  --radius-sm: 8px;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --primary: #3b82f6; --primary-hover: #60a5fa; --primary-content: #0b0b0f;
    --accent: #fbbf24;
    --base-100: #18181b; --base-200: #27272a; --base-300: #3f3f46;
    --base-content: #fafafa; --base-content-secondary: #a1a1aa;
    --shadow-lg: 0 24px 60px -16px rgba(0, 0, 0, .6);
  }
}

/* Reset */
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--font);
  font-size: var(--text);
  line-height: var(--leading-body);
  color: var(--base-content-secondary);
  background: var(--base-100);
  -webkit-font-smoothing: antialiased;
}
img, svg, video { display: block; max-width: 100%; height: auto; }
a { color: inherit; }

/* Headlines — Base Content, one weight, tight leading, negative tracking,
   max ~2 lines / 70 chars. */
h1, h2, h3 {
  color: var(--base-content);
  font-weight: var(--weight-head);
  line-height: var(--leading-head);
  letter-spacing: -0.025em;
  text-wrap: balance;
}
h1 { font-size: var(--h1); }
h2 { font-size: var(--h2); }
h3 { font-size: var(--h3); letter-spacing: -0.01em; }

/* Paragraphs — 16px, left-aligned, capped line length, secondary color.
   Emphasis bumps weight + uses the stronger Base Content color. */
p { max-width: var(--measure); }
p strong, p b, .emphasis { color: var(--base-content); font-weight: 600; }

/* Layout */
.container { width: 100%; max-width: 1080px; margin-inline: auto; padding-inline: var(--space-3); }
.section { padding-block: var(--gap-section); }
.section--alt { background: var(--base-200); }

/* Vertical rhythm helpers — encode Marc's semantic gaps so agents don't guess. */
.stack > * + * { margin-top: var(--gap-headline); }   /* default related spacing */
.stack--loose > * + * { margin-top: var(--space-4); }
.mt-headline { margin-top: var(--gap-headline); }
.mt-button { margin-top: var(--gap-button); }
.mt-image { margin-top: var(--gap-image); }

/* Hero — one headline, one sub, one CTA, centered, generous space, soft glow. */
.hero { text-align: center; position: relative; background: var(--hero-glow); }
.hero .sub { font-size: 1.25rem; max-width: 40ch; margin-inline: auto; margin-top: var(--gap-headline); }
.hero .btn { margin-top: var(--gap-button); }

/* Button — the single primary CTA. High contrast, rounded, bold. */
.btn {
  display: inline-block; cursor: pointer; border: 0;
  background: var(--primary); color: var(--primary-content);
  font: inherit; font-weight: 600; text-decoration: none;
  padding: 12px 24px; border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
  transition: background .15s ease, transform .15s ease, box-shadow .15s ease;
}
.btn:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: var(--shadow); }
.btn:active { transform: translateY(0); }
.btn--lg { padding: 16px 32px; font-size: 1.125rem; }
.btn--ghost { background: transparent; color: var(--base-content); border: 1px solid var(--base-300); }

/* Cards / grid */
.card { background: var(--base-100); border: 1px solid var(--base-300); border-radius: var(--radius); padding: var(--space-4); box-shadow: var(--shadow-sm); }
.grid { display: grid; gap: var(--space-4); }
.grid--2 { grid-template-columns: repeat(2, 1fr); }
.grid--3 { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 720px) { .grid--2, .grid--3 { grid-template-columns: 1fr; } }

/* Social proof */
.testimonial { background: var(--base-200); border-radius: var(--radius); padding: var(--space-4); }
.testimonial .who { color: var(--base-content); font-weight: 600; margin-top: var(--space-3); }
.stars { color: #f59e0b; letter-spacing: 2px; }
.avatar { width: 40px; height: 40px; border-radius: 999px; object-fit: cover; }

/* Pricing */
.price { color: var(--base-content); font-size: 2.5rem; font-weight: var(--weight-head); letter-spacing: -0.02em; }
.price small { font-size: 1rem; font-weight: 400; color: var(--base-content-secondary); }

/* FAQ — native disclosure, no JS. */
.faq { border-bottom: 1px solid var(--base-300); padding: var(--space-3) 0; }
.faq summary { color: var(--base-content); font-weight: 600; cursor: pointer; list-style: none; }
.faq summary::-webkit-details-marker { display: none; }
.faq p { margin-top: var(--space-2); }

/* Nav / footer — sticky, blurred header keeps the CTA in reach on scroll. */
.site-header { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--base-100) 80%, transparent); backdrop-filter: saturate(180%) blur(10px); border-bottom: 1px solid var(--base-300); }
.nav { display: flex; align-items: center; justify-content: space-between; padding-block: var(--space-3); }
.nav .brand { color: var(--base-content); font-weight: 700; text-decoration: none; font-size: 1.1rem; }
.footer { border-top: 1px solid var(--base-300); padding-block: var(--space-5); color: var(--base-content-secondary); font-size: .9rem; }

/* ── Appeal upgrades v1.1 (DataFast easy-wins) ───────────────────────────── */

/* Highlighted keyword — Marc's signature marker swipe under one word in a
   headline. Wrap the word: <h1>Grow <span class="highlight">faster</span></h1> */
.highlight {
  background-image: linear-gradient(120deg, transparent 0 8%, color-mix(in srgb, var(--accent) 55%, transparent) 8% 92%, transparent 92%);
  background-repeat: no-repeat; background-size: 100% 45%; background-position: 0 78%;
  -webkit-box-decoration-break: clone; box-decoration-break: clone; padding: 0 .05em;
}
/* Or tint the word in the brand gradient. */
.text-gradient {
  background: linear-gradient(90deg, var(--primary), var(--accent));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}

/* Badge — pill with an accent tint + icon, for "Featured on", "New", awards. */
.badge {
  display: inline-flex; align-items: center; gap: .4em;
  background: color-mix(in srgb, var(--accent) 16%, var(--base-100));
  color: var(--base-content); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  padding: 6px 14px; border-radius: 999px; font-size: .85rem; font-weight: 600;
}

/* Social proof — overlapping avatar row + stars + count (the hero clincher). */
.social-proof { display: inline-flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; justify-content: center; }
.avatars { display: inline-flex; }
.avatars .avatar { margin-left: -12px; border: 2px solid var(--base-100); }
.avatars .avatar:first-child { margin-left: 0; }
.social-proof .count { color: var(--base-content-secondary); font-size: .95rem; }
.social-proof .count b { color: var(--base-content); }

/* Reassurance microcopy under a CTA — "No card required", "$0 due today". */
.reassure { color: var(--base-content-secondary); font-size: .85rem; margin-top: var(--space-2); }

/* Stat callouts — big numbers earn trust. */
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); }
.stat .num { display: block; font-size: 2.5rem; font-weight: var(--weight-head); color: var(--base-content); letter-spacing: -.02em; }
.stat .label { color: var(--base-content-secondary); }
@media (max-width: 720px) { .stats { grid-template-columns: 1fr; } }

/* Framed product screenshot — rounded, bordered, big soft shadow, faux browser
   bar. <div class="app-frame"><div class="bar"></div><img ...></div> */
.app-frame { border: 1px solid var(--base-300); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-lg); background: var(--base-200); max-width: 980px; margin-inline: auto; }
.app-frame .bar { display: flex; gap: 6px; padding: 12px 16px; background: var(--base-200); border-bottom: 1px solid var(--base-300); }
.app-frame .bar::before, .app-frame .bar::after { content: ""; width: 12px; height: 12px; border-radius: 999px; background: var(--base-300); }
.app-frame .bar::after { box-shadow: 20px 0 var(--base-300), 40px 0 var(--base-300); }
.app-frame img { width: 100%; display: block; }

/* Featured pricing card — primary border + ribbon to anchor the choice. */
.card--featured { border: 2px solid var(--primary); box-shadow: var(--shadow); position: relative; }
.ribbon { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: var(--primary); color: var(--primary-content); font-size: .8rem; font-weight: 700; padding: 4px 14px; border-radius: 999px; }

/* Founder note — photo + first-person story builds indie trust. */
.founder { display: flex; gap: var(--space-4); align-items: flex-start; }
.founder img { width: 72px; height: 72px; border-radius: 999px; object-fit: cover; flex-shrink: 0; }
@media (max-width: 560px) { .founder { flex-direction: column; } }

/* Utilities */
.text-center { text-align: center; }
.muted { color: var(--base-content-secondary); }
.pill { display: inline-block; background: var(--base-200); border: 1px solid var(--base-300); color: var(--base-content-secondary); padding: 4px 12px; border-radius: 999px; font-size: .85rem; }
`;
