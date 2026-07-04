/**
 * Hand-built pixel sprites (retro identity). Each sprite is a small pixel map
 * (one char per pixel, "." = transparent) rendered as SVG rects with crisp
 * edges — no external assets, recolorable via palette. Pure components: safe
 * to use from both server and client components.
 */

type Rows = string[];
type Palette = Record<string, string>;

const INK = "#21241d";

function Pixels({
  rows,
  palette,
  size = 24,
  title,
}: {
  rows: Rows;
  palette: Palette;
  size?: number;
  title?: string;
}) {
  const h = rows.length;
  const w = rows[0]?.length ?? 1;
  return (
    <svg
      className="sprite"
      width={size}
      height={Math.round((size * h) / w)}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      role={title ? "img" : "presentation"}
      aria-label={title}
    >
      {rows.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === "." || !palette[c] ? null : (
            <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={palette[c]} />
          ),
        ),
      )}
    </svg>
  );
}

/* ── Company mascot — a little blob-monster, body colour keyed off the slug ── */

const MASCOT: Rows = [
  "..oo....oo..",
  ".obbo..obbo.",
  ".obbboobbbo.",
  ".obbbbbbbbo.",
  "obbbbbbbbbbo",
  "obwwbbbbwwbo",
  "obwpbbbbwpbo",
  "obbbbbbbbbbo",
  "obccbbbbccbo",
  ".obbbbbbbbo.",
  "..obbbbbbo..",
  "...oooooo...",
];

const MASCOT_BODIES = ["#5d8d81", "#c76f5e", "#b9862f", "#6f7fb2", "#8a6fb2", "#7d9a4e"];
const MASCOT_CHEEKS = ["#3f6a5f", "#a34f3f", "#96691c", "#4f5f96", "#6a4f96", "#5d7a33"];

/** Stable tiny hash so each company keeps its own mascot colour. */
function slugHue(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % MASCOT_BODIES.length;
}

export function Mascot({ slug, size = 36, paused = false }: { slug: string; size?: number; paused?: boolean }) {
  const i = slugHue(slug);
  return (
    <Pixels
      rows={MASCOT}
      size={size}
      title={`${slug} mascot`}
      palette={{
        o: INK,
        b: paused ? "#a8a394" : MASCOT_BODIES[i]!,
        c: paused ? "#8d887a" : MASCOT_CHEEKS[i]!,
        w: "#fbf8f0",
        p: INK,
      }}
    />
  );
}

/* ── Agent sprites — CEO (crown), department (cap), worker (hard hat) ─────── */

const CEO: Rows = [
  "..g.g..g.g..",
  "..gggggggg..",
  ".osssssssso.",
  ".ospsssspso.",
  ".osssssssso.",
  "..osssssso..",
  ".ouuttttuuo.",
  "ouuuttttuuuo",
  "ouuuuttuuuuo",
  "ouuuuttuuuuo",
  ".ouuuuuuuuo.",
  "..oooooooo..",
];

const DEPT: Rows = [
  "..dddddddd..",
  ".dddddddddd.",
  ".osssssssso.",
  ".ospsssspso.",
  ".osssssssso.",
  "..osssssso..",
  ".ouuuuuuuuo.",
  "ouuwwwwwwuuo",
  "ouuwllllwuuo",
  "ouuwwwwwwuuo",
  ".ouuuuuuuuo.",
  "..oooooooo..",
];

const WORKER: Rows = [
  "...hhhhhh...",
  "..hhhhhhhh..",
  ".hhhhhhhhhh.",
  ".osssssssso.",
  ".ospsssspso.",
  "..osssssso..",
  ".ovvvvvvvvo.",
  "ovvlvvvvlvvo",
  "ovvvvvvvvvvo",
  "ovvvvvvvvvvo",
  ".ovvvvvvvvo.",
  "..oooooooo..",
];

const AGENT_PALETTE: Palette = {
  o: INK,
  s: "#e8c39a", // skin
  p: INK, // pupils
  g: "#b9862f", // crown gold
  u: "#3c4650", // suit
  t: "#b5473c", // tie
  d: "#5d8d81", // department cap (sage)
  w: "#fbf8f0", // clipboard paper
  l: "#a8a394", // paper lines / vest stripe
  h: "#d9b356", // hard hat
  v: "#c76f5e", // worker overalls
};

export function AgentSprite({ kind, size = 24 }: { kind: "ceo" | "dept" | "worker"; size?: number }) {
  const rows = kind === "ceo" ? CEO : kind === "dept" ? DEPT : WORKER;
  return <Pixels rows={rows} palette={AGENT_PALETTE} size={size} title={kind} />;
}

/* ── HUD pieces — hearts (HP = runway) and the gold coin (P&L) ───────────── */

const HEART: Rows = [
  ".xx..xx.",
  "xrrxxrrx",
  "xrrrrrrx",
  "xrrrrrrx",
  ".xrrrrx.",
  "..xrrx..",
  "...xx...",
];

export function Heart({ filled = true, size = 16 }: { filled?: boolean; size?: number }) {
  return (
    <Pixels
      rows={HEART}
      size={size}
      palette={{ x: INK, r: filled ? "#c94f43" : "#d8d2c2" }}
    />
  );
}

const COIN: Rows = [
  "..xxxx..",
  ".xggggx.",
  "xgglgggx",
  "xglggggx",
  "xggggggx",
  "xgggggdx",
  ".xggddx.",
  "..xxxx..",
];

export function Coin({ size = 16 }: { size?: number }) {
  return <Pixels rows={COIN} size={size} palette={{ x: INK, g: "#d9b356", l: "#f0dfa0", d: "#b9862f" }} />;
}

/* ── Badge icons — 8×8 pictograms for achievements ───────────────────────── */

const BADGE_ICONS: Record<string, Rows> = {
  star: [
    "...ss...",
    "...ss...",
    "ssssssss",
    ".ssssss.",
    "..ssss..",
    ".ss..ss.",
    "s......s",
    "........",
  ],
  rocket: [
    "...rr...",
    "..rllr..",
    "..rllr..",
    "..rrrr..",
    ".rrrrrr.",
    "r.rrrr.r",
    "..f..f..",
    ".f.ff.f.",
  ],
  cart: [
    "cccccccc",
    "c......c",
    ".c....c.",
    ".cccccc.",
    "........",
    ".c....c.",
    "cc....cc",
    "........",
  ],
  mail: [
    "mmmmmmmm",
    "m.m..m.m",
    "m..mm..m",
    "m......m",
    "m......m",
    "mmmmmmmm",
    "........",
    "........",
  ],
  bolt: [
    "...bb...",
    "..bb....",
    ".bbbbb..",
    "...bb...",
    "..bb....",
    ".bb.....",
    "bb......",
    "........",
  ],
  flag: [
    "f.......",
    "fffffff.",
    "fffffff.",
    "ffffff..",
    "f.......",
    "f.......",
    "f.......",
    "f.......",
  ],
};

const BADGE_COLORS: Palette = {
  s: "#b9862f",
  r: "#b5473c",
  l: "#f0dfa0",
  f: "#d9873c",
  c: "#5d8d81",
  m: "#6f7fb2",
  b: "#d9b356",
};

export function BadgeIcon({ icon, size = 18 }: { icon: keyof typeof BADGE_ICONS; size?: number }) {
  return <Pixels rows={BADGE_ICONS[icon] ?? BADGE_ICONS.star!} palette={BADGE_COLORS} size={size} />;
}

export type BadgeIconName = keyof typeof BADGE_ICONS;
