// A pixel icon's colours (Jonathan, 2026-11-05: a gradient map, not a flat stencil). Each icon keeps its own light and
// shade, and its colours are replaced with its key's ramp: a dark shadow, then the key's tint, then a near-white
// highlight. A ramp per look and state: on a dark key (normal) the tint is the middle; on the lit key (the current one,
// solid tint) the middle is the tint sunk into the key's ink, so the icon reads dark on the bright key. Higher contrast
// gets a stronger ramp: its ends pushed to black and white, and its middle steeper.
//
// Line-only icons (mostly dark ink, little fill; src/icon-set.ts lineOnly) are inverted before mapping when normal on a
// dark look, so their lines take the light end and glow; lit, they aren't, so their lines stay crisp and dark on the
// bright key. Daylight's normal key is light: there, light lines would vanish, so they aren't inverted either.
//
// No React and no DOM: pixel-icons.tsx turns a ramp into an SVG filter (feColorMatrix to luminance, then a table per
// channel), drawn by the browser on every repaint at no cost to the page. src/ui/pixel-ramp.test.ts pins the ramps to
// the looks' own colours; src/ui/pixel-icons.integration.test.ts checks what Chrome draws against them.

export type RGB = [number, number, number];
export type Ramp = [RGB, RGB, RGB];

/** A computed CSS colour (rgb(), rgba() or color(srgb …)) as 0-255 RGB; black if it isn't one. */
export function parseColor(s: string): RGB {
  const t = s.trim();
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(v)) as RGB;
  m = /^color\(\s*srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/i.exec(t);
  if (m) return [m[1], m[2], m[3]].map((v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255)) as RGB;
  m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB;
  return [0, 0, 0];
}

/** a toward b by k (0: a, 1: b), in sRGB, as color-mix(in srgb, b k, a) is. */
export const mix = (a: RGB, b: RGB, k: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * k)) as RGB;

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

/** What a look's ramps are made from: whether it's light or dark, its canvas, its ink, the ink on a lit key, and the key's tint. */
export type KeyColours = { mode: 'light' | 'dark'; canvas: RGB; ink: RGB; onAccent: RGB; tint: RGB };

/**
 * The ramp for a key: [shadow, middle, highlight].
 *   dark look, normal:  the canvas, the tint, the ink (near white)
 *   dark look, lit:     the key's ink, the tint 35% into that ink, white
 *   light look, normal: the tint deep in shadow, the tint, the tint washed near white
 *   light look, lit:    the tint deep in shadow, the tint half washed, the canvas (near white)
 * Higher contrast pulls each end halfway on to black and white.
 */
export function rampFor(k: KeyColours, lit: boolean, more = false): Ramp {
  const r: Ramp = k.mode === 'dark'
    ? (lit ? [k.onAccent, mix(k.onAccent, k.tint, 0.35), WHITE] : [k.canvas, k.tint, k.ink])
    : (lit ? [mix(k.tint, BLACK, 0.7), mix(k.tint, WHITE, 0.5), k.canvas] : [mix(k.tint, BLACK, 0.75), k.tint, mix(k.tint, WHITE, 0.8)]);
  return more ? [mix(r[0], BLACK, 0.5), r[1], mix(r[2], WHITE, 0.5)] : r;
}

/** A pixel's luminance, 0 to 1 (Rec. 709, on the sRGB values, as the trial's gmap). */
export const luminance = (c: RGB): number => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Where a luminance lands on the ramp: inverted first for a line-only icon, steeper with more contrast. */
export function rampAt(L: number, invert: boolean, more: boolean): number {
  const x = invert ? 1 - L : L;
  return more ? Math.min(1, Math.max(0, 0.5 + (x - 0.5) * 1.5)) : x;
}

/** The colour a ramp gives at t (0: shadow, 0.5: the middle, 1: highlight). */
export function colorAt(r: Ramp, t: number): RGB {
  return t < 0.5 ? mix(r[0], r[1], t * 2) : mix(r[1], r[2], (t - 0.5) * 2);
}

/** What a pixel of the icon becomes: the gmap the trial drew, per pixel. */
export function mapPixel(c: RGB, r: Ramp, invert: boolean, more: boolean): RGB {
  return colorAt(r, rampAt(luminance(c), invert, more));
}

/** Steps in a filter's table: feComponentTransfer interpolates between them, so 65 keep each step under 1/64. */
export const TABLE_STEPS = 65;

/** The three channels' tables (0 to 1) for feComponentTransfer, after feColorMatrix has put the luminance in each. */
export function tablesFor(r: Ramp, invert: boolean, more: boolean): [number[], number[], number[]] {
  const out: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < TABLE_STEPS; i++) {
    const c = colorAt(r, rampAt(i / (TABLE_STEPS - 1), invert, more));
    for (let ch = 0; ch < 3; ch++) out[ch].push(Math.round((c[ch] / 255) * 10000) / 10000);
  }
  return out;
}
