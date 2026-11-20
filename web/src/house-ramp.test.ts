import { expect, it } from 'vitest';
import { kneeOf, mix, parseColor, rampFor, tablesFor, toneAt, type KeyColours, type RGB } from './house-ramp';
import { defsMarkup, filterId, filterMarkup, filterRules, LIT } from './house-tint';
import { TINTS } from './tint';

// Neon Noir's and Daylight's own colours for a pink key (looks/looks.css).
const pink: RGB = [255, 61, 168], deep: RGB = [194, 24, 91];
const dark: KeyColours = { mode: 'dark', ink: [243, 241, 255], onAccent: [10, 9, 18], tint: pink };
const light: KeyColours = { mode: 'light', ink: [26, 24, 20], onAccent: [255, 255, 255], tint: deep };
const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

it('maps black to nothing, mid grey to the tint and white to a near-white highlight on a dark look', () => {
  const ramp = rampFor(dark, false);
  expect(toneAt(ramp, 0).alpha).toBe(0);
  expect(toneAt(ramp, 0.5)).toEqual({ rgb: pink, alpha: 1 });
  expect(toneAt(ramp, 1)).toEqual({ rgb: mix(pink, dark.ink, 0.8), alpha: 1 });
  expect(lum(toneAt(ramp, 1).rgb)).toBeGreaterThan(lum(pink));
  // a dark grey is the tint itself, thinner; a light grey is partway to the highlight
  expect(toneAt(ramp, 0.25)).toEqual({ rgb: pink, alpha: 0.5 });
  expect(toneAt(ramp, 0.75)).toEqual({ rgb: mix(pink, mix(pink, dark.ink, 0.8), 0.5), alpha: 1 });
});
it('turns the ramp over on a light look: black still nothing, mid grey the tint, white its dark shade', () => {
  const ramp = rampFor(light, false);
  expect(toneAt(ramp, 0).alpha).toBe(0);
  expect(toneAt(ramp, 0.5)).toEqual({ rgb: deep, alpha: 1 });
  expect(toneAt(ramp, 1)).toEqual({ rgb: mix(deep, [0, 0, 0], 0.45), alpha: 1 });
  expect(lum(toneAt(ramp, 1).rgb)).toBeLessThan(lum(deep));
});
it('draws a lit key’s glyph in the key’s own ink, in either look', () => {
  for (const k of [dark, light]) {
    const ramp = rampFor(k, true);
    expect(toneAt(ramp, 0).alpha).toBe(0);
    expect(toneAt(ramp, 1)).toEqual({ rgb: k.onAccent, alpha: 1 });
    expect(toneAt(ramp, 0.5)).toEqual({ rgb: mix(k.onAccent, k.tint, 0.35), alpha: 1 });
  }
});
it('pushes the far end on and makes dark greys solid sooner with higher contrast', () => {
  expect(rampFor(dark, false, true)).toEqual({ mid: pink, high: mix(mix(pink, dark.ink, 0.8), [255, 255, 255], 0.5) });
  expect(lum(rampFor(light, false, true).high)).toBeLessThan(lum(rampFor(light, false).high));
  expect(lum(rampFor(dark, true, true).high)).toBeLessThan(lum(dark.onAccent));
  expect(rampFor(light, true, true).high).toEqual([255, 255, 255]);
  expect(kneeOf(true)).toBeLessThan(kneeOf(false));
  expect(toneAt(rampFor(dark, false, true), 0.3, true).alpha).toBe(1);
  expect(toneAt(rampFor(dark, false, true), 0, true).alpha).toBe(0);
});
it('gives the filter the same mapping: three stops per channel and the slope to solid', () => {
  const ramp = rampFor(dark, false), t = tablesFor(ramp);
  expect(t.slope).toBe(2);
  expect(t.r).toEqual([1, 1, ramp.high[0] / 255].map(v => Math.round(v * 10000) / 10000));
  expect([t.r.length, t.g.length, t.b.length]).toEqual([3, 3, 3]);
  expect(t.g[0]).toBe(t.g[1]);
  expect(tablesFor(rampFor(dark, false, true), true).slope).toBeCloseTo(1 / 0.3, 3);
});
it('reads a computed colour however the browser writes it', () => {
  expect(parseColor('rgb(255, 61, 168)')).toEqual(pink);
  expect(parseColor('rgba(255 61 168 / 0.5)')).toEqual(pink);
  expect(parseColor('color(srgb 1 0.5 0)')).toEqual([255, 128, 0]);
  expect(parseColor('#FF3DA8')).toEqual(pink);
});
it('makes a filter that colours by luminance and clears black, and one pair per tint', () => {
  const one = filterMarkup('x', dark, false, false);
  expect(one).toContain('<filter id="x" color-interpolation-filters="sRGB"');
  // the luminance as how solid: the last row of the second matrix; then the colour kept inside it
  expect(one).toContain('values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2126 0.7152 0.0722 0 0"');
  expect(one).toContain('<feFuncA type="linear" slope="2"/>');
  expect(one).toContain('<feComposite in="c" in2="a" operator="in"/>');
  const keys = Object.fromEntries(TINTS.map(t => [t, dark])) as Record<typeof TINTS[number], KeyColours>;
  const defs = defsMarkup(keys, false);
  for (const t of TINTS) for (const state of ['n', 'l'] as const) expect(defs).toContain(`<filter id="${filterId(t, state)}"`);
  expect(defs.match(/<filter /g)).toHaveLength(TINTS.length * 2);
});
it('lets a key’s tint and its lit state choose the filter, in CSS', () => {
  const rules = filterRules();
  for (const t of TINTS) expect(rules).toContain(`[data-tint="${t}"]{--loom-house:url(#loom-house-${t}-n);--loom-house-lit:url(#loom-house-${t}-l)}`);
  expect(rules).toContain('.loom-house{filter:var(--loom-house,');
  // the same selectors that draw a key solid: the dock's current key (looks.css) and a window's title-strip key (shell.css)
  expect(LIT).toEqual(['.v-dock [data-part="lane"][data-active="true"]', '.next-app-key']);
  expect(rules).toContain(`:is(${LIT.join(',')}) .loom-house{filter:var(--loom-house-lit,`);
});
