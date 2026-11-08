// A pixel icon's ramp (web/src/pixel-ramp.ts), pinned to colours written out here, not computed by the code under
// test: Neon Noir's own tokens (web/src/looks/looks.css: canvas #07070C, ink #F3F1FF, the ink on a lit key #0A0912,
// magenta #FF3DA8), and the trial's Daylight teal (#0E7F8A on #F4EFE6). Shadow, then the key's tint, then highlight.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { colorAt, mapPixel, parseColor, rampAt, rampFor, tablesFor, TABLE_STEPS, type KeyColours, type RGB } from '../../web/src/pixel-ramp';
import { pixelApp } from '../../web/src/app-icon';
import { iconApp } from '../icon-set.js';

const hex = (s: string) => parseColor(s);
const NEON: KeyColours = { mode: 'dark', canvas: hex('#07070C'), ink: hex('#F3F1FF'), onAccent: hex('#0A0912'), tint: hex('#FF3DA8') };
const DAY: KeyColours = { mode: 'light', canvas: hex('#FBF8F2'), ink: hex('#16282B'), onAccent: hex('#FBF8F2'), tint: hex('#0E7F8A') };
const BLACK: RGB = [0, 0, 0], GREY: RGB = [128, 128, 128], WHITE: RGB = [255, 255, 255];

describe('the ramps', () => {
  it('on a dark look\'s normal key: the canvas, the tint, the ink', () => {
    expect(rampFor(NEON, false)).toEqual([[7, 7, 12], [255, 61, 168], [243, 241, 255]]);
    expect(mapPixel(BLACK, rampFor(NEON, false), false, false)).toEqual([7, 7, 12]);
    expect(mapPixel(WHITE, rampFor(NEON, false), false, false)).toEqual([243, 241, 255]);
    // Mid-grey (luminance 128/255, a hair over half) lands on the tint, a step toward the ink.
    const g = mapPixel(GREY, rampFor(NEON, false), false, false);
    expect(Math.max(...g.map((v, i) => Math.abs(v - [255, 61, 168][i])))).toBeLessThanOrEqual(2);
  });

  it('on a dark look\'s lit key: the key\'s ink, the tint 35% into that ink, white', () => {
    // 0x0A + (0xFF - 0x0A) × .35 = 96.45; 0x09 + (0x3D - 0x09) × .35 = 27.2; 0x12 + (0xA8 - 0x12) × .35 = 70.5
    expect(rampFor(NEON, true)).toEqual([[10, 9, 18], [96, 27, 71], [255, 255, 255]]);
  });

  it('on Daylight: dark shadow and the tint, a near-white wash of it highlit; lit, the canvas is the highlight', () => {
    // #0E7F8A = (14, 127, 138): 25% of it in shadow; 80% of the way to white for the highlight.
    expect(rampFor(DAY, false)).toEqual([[4, 32, 35], [14, 127, 138], [207, 229, 232]]);
    expect(rampFor(DAY, true)).toEqual([[4, 38, 41], [135, 191, 197], [251, 248, 242]]);
  });

  it('higher contrast: each end halfway on to black and white, the middle kept, and a steeper slope through it', () => {
    expect(rampFor(NEON, false, true)).toEqual([[4, 4, 6], [255, 61, 168], [249, 248, 255]]);
    // A quarter of the way up the ramp normally; under higher contrast, 0.5 + (0.25 − 0.5) × 1.5 = 0.125.
    expect(rampAt(0.25, false, false)).toBe(0.25);
    expect(rampAt(0.25, false, true)).toBeCloseTo(0.125);
    expect(rampAt(0.05, false, true)).toBe(0);
    // So a dark grey sits nearer the shadow with more contrast.
    const r = rampFor(NEON, false, true);
    expect(mapPixel([64, 64, 64], r, false, true)).toEqual(colorAt(r, 0.5 + (64 / 255 - 0.5) * 1.5));
  });

  it('a line-only icon inverted: its black takes the highlight and its white the shadow', () => {
    const r = rampFor(NEON, false);
    expect(mapPixel(BLACK, r, true, false)).toEqual([243, 241, 255]);
    expect(mapPixel(WHITE, r, true, false)).toEqual([7, 7, 12]);
  });

  it('the filter\'s tables walk the ramp, so the browser draws what mapPixel says', () => {
    const r = rampFor(NEON, false);
    const [tr, tg, tb] = tablesFor(r, false, false);
    expect(tr).toHaveLength(TABLE_STEPS);
    expect([tr[0], tg[0], tb[0]].map((v) => Math.round(v * 255))).toEqual([7, 7, 12]);
    expect([tr[32], tg[32], tb[32]].map((v) => Math.round(v * 255))).toEqual([255, 61, 168]);
    expect([tr[64], tg[64], tb[64]].map((v) => Math.round(v * 255))).toEqual([243, 241, 255]);
    const [ir] = tablesFor(r, true, false);
    expect(ir[0]).toBe(tr[64]);
  });

  it('reads the colours a browser computes: rgb(), and color(srgb …) from a color-mix()', () => {
    expect(parseColor('rgb(255, 61, 168)')).toEqual([255, 61, 168]);
    expect(parseColor('rgba(7, 7, 12, 0.5)')).toEqual([7, 7, 12]);
    expect(parseColor('color(srgb 1 0.5 0)')).toEqual([255, 128, 0]);
  });
});

describe('which app an icon is for', () => {
  it('the page asks for the file the server keeps it under', () => {
    for (const label of ['Home', 'Inbox', 'Approvals', 'Setup', 'Find anything', 'Subscriptions', '  Odd   Label! ']) expect(pixelApp(label), label).toBe(iconApp(label));
    expect(pixelApp('Find anything')).toBe('find-anything');
  });
});

describe('the filters and their rules come from one list of tints', () => {
  it('pixel-icons.css names no tint of its own', () => {
    expect(readFileSync(new URL('../../web/src/pixel-icons.css', import.meta.url), 'utf-8')).not.toMatch(/data-tint|loom-pix-(pink|blue|yellow|olive)/);
  });
});
