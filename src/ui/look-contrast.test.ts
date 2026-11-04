/**
 * Each look's colours read (Jonathan, 2026-11-04, Neon Noir): text at 4.5:1 or better on every surface it sits on,
 * a control's edge at 3:1 or better, and the ink on each of the four tints at 4.5:1. Measured from the stylesheets
 * themselves, for every look and mode loom ships: 000h light and dark (web/src/styles/cojeev/tokens.css) and Neon Noir
 * (web/src/looks/neon.css, over 000h's dark).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const root = new URL('../../web/src/', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties of the first block whose selector is exactly `sel`. */
function block(css: string, sel: string): Record<string, string> {
  const at = css.indexOf(`${sel}{`);
  if (at < 0) throw new Error(`no ${sel} block`);
  const body = css.slice(at + sel.length + 1, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const tokens = read('styles/cojeev/tokens.css');
const light = block(tokens, ':root');
const dark = { ...light, ...block(tokens, ':root[data-mode="dark"]') };
const neon = { ...dark, ...block(read('looks/neon.css'), ':root[data-look="neon"][data-mode]') };
const LOOKS = { '000h light': light, '000h dark': dark, 'Neon Noir': neon } as const;

function hex(t: Record<string, string>, name: string): string {
  let v = t[name];
  for (let i = 0; i < 5 && v?.startsWith('var('); i++) v = t[/var\((--[\w-]+)/.exec(v)![1]];
  if (!/^#[0-9a-f]{6}$/i.test(v ?? '')) throw new Error(`${name} isn't a plain colour (${v})`);
  return v;
}
const lum = (h: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const SURFACES = ['--v-canvas', '--v-paper', '--v-beige'];
const PAIRS: Array<[string, string, number]> = [
  ...['--v-text', '--v-text-2', '--v-text-3'].flatMap((t) => SURFACES.map((s) => [t, s, 4.5] as [string, string, number])),
  ...SURFACES.map((s) => ['--v-edge', s, 3] as [string, string, number]),
  ...['--v-pink', '--v-blue', '--v-yellow', '--v-olive'].map((a) => ['--v-on-accent', a, 4.5] as [string, string, number]),
  ['--v-brand', '--v-canvas', 3],
];
// Neon's own: its status inks on their washes, and the inks it adds on its ground.
const NEON_PAIRS: Array<[string, string, number]> = [
  ['--status-ok-ink', '--status-ok-bg', 4.5], ['--status-warn-ink', '--status-warn-bg', 4.5], ['--status-danger-ink', '--status-danger-bg', 4.5],
  ['--status-info-ink', '--status-info-bg', 4.5], ['--status-pending-ink', '--status-pending-bg', 4.5],
  ['--v-danger-ink', '--v-paper', 4.5], ['--v-accent-ink', '--v-paper', 4.5], ['--v-olive-ink', '--v-paper', 4.5], ['--sel-ink', '--sel-bg', 4.5],
  ['--loom-count-ink', '--loom-count', 4.5],
];

describe('each look\'s contrast', () => {
  for (const [name, t] of Object.entries(LOOKS)) {
    it(`${name}: text 4.5:1, control edges 3:1, ink on the tints 4.5:1`, () => {
      const short = PAIRS.map(([f, b, min]) => ({ pair: `${f} on ${b}`, ratio: +ratio(hex(t, f), hex(t, b)).toFixed(2), min })).filter((p) => p.ratio < p.min);
      expect(short).toEqual([]);
    });
  }
  it('Neon Noir: its status inks and its own inks', () => {
    const short = NEON_PAIRS.map(([f, b, min]) => ({ pair: `${f} on ${b}`, ratio: +ratio(hex(neon, f), hex(neon, b)).toFixed(2), min })).filter((p) => p.ratio < p.min);
    expect(short).toEqual([]);
  });
});
