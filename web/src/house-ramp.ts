// A house icon's colours. The art (assets/house-icons/) is greyscale on black; what's drawn is its luminance on the
// key's ramp: black is nothing at all (the key shows through, whatever colour the key is), mid grey is the key's tint,
// white is a highlight. In between they blend, so a dark grey is the tint thinned over the key and a light grey is
// partway to the highlight.
//
// A ramp per look and state. On a dark look's key the highlight is near white, tinted; on a light look's the ramp is
// turned over, so the glyph is dark on light: its highlight is the tint deep in shadow. On a lit key (the current one in
// the dock, a window's title-strip key: solid tint) the glyph is the key's own ink, its mid tones a little toward the
// tint. Higher contrast pushes the far end on to white or black and makes the dark greys solid sooner.
//
// No React and no DOM: house-tint.ts turns a ramp into an SVG filter the browser draws with.

export type RGB = [number, number, number];
/** What's drawn for black's far side: the tint at the art's mid grey, the highlight at its white. Black is clear. */
export type Ramp = { mid: RGB; high: RGB };

/** A computed CSS colour (rgb(), rgba(), color(srgb …) or #rrggbb) as 0-255 RGB; black if it isn't one. */
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
const light = (c: RGB): number => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** What a key's ramps are made from: whether the look is light or dark, its ink, the ink on a lit key, and the key's tint. */
export type KeyColours = { mode: 'light' | 'dark'; ink: RGB; onAccent: RGB; tint: RGB };

/**
 * The ramp for a key.
 *   dark look:   the tint, then the tint washed most of the way to the look's ink (near white)
 *   light look:  the tint, then the tint deep in shadow
 *   lit key:     the key's ink a third of the way to the tint, then the key's ink (either look)
 * Higher contrast pulls the far end halfway on to white or black, whichever it's already nearer than the middle is.
 */
export function rampFor(k: KeyColours, lit: boolean, more = false): Ramp {
  const r: Ramp = lit ? { mid: mix(k.onAccent, k.tint, 0.35), high: k.onAccent }
    : k.mode === 'dark' ? { mid: k.tint, high: mix(k.tint, k.ink, 0.8) }
      : { mid: k.tint, high: mix(k.tint, BLACK, 0.45) };
  return more ? { mid: r.mid, high: mix(r.high, light(r.high) >= light(r.mid) ? WHITE : BLACK, 0.5) } : r;
}

/** The luminance at which the glyph is solid: under it, the middle colour thinned over the key. */
export const kneeOf = (more: boolean): number => (more ? 0.3 : 0.5);

/** What a pixel of the art becomes: a colour and how solid it is (0: the key shows, 1: all glyph), from its luminance 0 to 1. */
export function toneAt(r: Ramp, L: number, more = false): { rgb: RGB; alpha: number } {
  const l = Math.min(1, Math.max(0, L));
  return { rgb: l <= 0.5 ? r.mid : mix(r.mid, r.high, (l - 0.5) * 2), alpha: Math.min(1, l / kneeOf(more)) };
}

const unit = (v: number): number => Math.round((v / 255) * 10000) / 10000;

/** A filter's numbers: each channel's table over the luminance (three stops: black, mid grey, white; the browser
 * blends between them, as toneAt does) and the slope the luminance is multiplied by to give how solid a pixel is. */
export function tablesFor(r: Ramp, more = false): { r: number[]; g: number[]; b: number[]; slope: number } {
  const stop = (ch: number) => [r.mid[ch], r.mid[ch], r.high[ch]].map(unit);
  return { r: stop(0), g: stop(1), b: stop(2), slope: Math.round((1 / kneeOf(more)) * 10000) / 10000 };
}
