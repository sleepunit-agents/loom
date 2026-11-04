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
// loom's own (index.css --loom-*: the count badge and the rest swept from literals) over 000h's.
const own = read('index.css');
const loomBlock = (sel: string) => Object.fromEntries([...own.slice(own.indexOf(sel)).split('}')[0].matchAll(/(--loom-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const light = { ...block(tokens, ':root'), ...loomBlock(':root { --loom-ok:') };
const dark = { ...light, ...block(tokens, ':root[data-mode="dark"]') };
const neon = { ...dark, ...block(read('looks/neon.css'), ':root[data-look="neon"][data-mode]') };
const LOOKS = { '000h light': light, '000h dark': dark, 'Neon Noir': neon } as const;

function hex(t: Record<string, string>, name: string): string {
  let v = t[name];
  for (let i = 0; i < 5 && v?.startsWith('var('); i++) v = t[/var\((--[\w-]+)/.exec(v)![1]];
  if (/^#[0-9a-f]{3}$/i.test(v ?? '')) v = `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  if (!/^#[0-9a-f]{6}$/i.test(v ?? '')) throw new Error(`${name} isn't a plain colour (${v})`);
  return v;
}
const lum = (h: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const SURFACES = ['--v-canvas', '--v-paper', '--v-beige'];
// The tinted regions text also sits on (tokens.css's semantic surfaces and soft tints).
const TINTED = ['--v-beige-2', '--v-cream-pill', '--surface-quiet', '--surface-work', '--surface-automation', '--surface-memory', '--surface-library',
  '--surface-ai', '--surface-alert', '--v-pink-soft', '--v-blue-soft', '--v-yellow-soft', '--v-olive-soft'];
const PAIRS: Array<[string, string, number]> = [
  ...['--v-text', '--v-text-2', '--v-text-3'].flatMap((t) => [...SURFACES, ...TINTED].map((s) => [t, s, 4.5] as [string, string, number])),
  // Control edges (a selection's too). --v-border is a hairline between static surfaces, never a control's edge (tokens.css).
  ...SURFACES.flatMap((s) => [['--v-edge', s, 3], ['--sel-edge', s, 3]] as Array<[string, string, number]>),
  ...['--v-pink', '--v-blue', '--v-yellow', '--v-olive'].map((a) => ['--v-on-accent', a, 4.5] as [string, string, number]),
  ['--v-brand', '--v-canvas', 3],
  // The structure (the rail): its text and its quiet text on it.
  ['--on-structure', '--v-structure', 4.5], ['--structure-text', '--v-structure', 4.5], ['--sidebar-muted', '--v-structure', 4.5],
  ['--loom-count-ink', '--loom-count', 4.5],
];
// Neon's own: its status inks on their washes, and the inks it adds on its ground.
const NEON_PAIRS: Array<[string, string, number]> = [
  ['--status-ok-ink', '--status-ok-bg', 4.5], ['--status-warn-ink', '--status-warn-bg', 4.5], ['--status-danger-ink', '--status-danger-bg', 4.5],
  ['--status-info-ink', '--status-info-bg', 4.5], ['--status-pending-ink', '--status-pending-bg', 4.5],
  ['--v-danger-ink', '--v-paper', 4.5], ['--v-accent-ink', '--v-paper', 4.5], ['--v-olive-ink', '--v-paper', 4.5], ['--sel-ink', '--sel-bg', 4.5],
];

/**
 * Short of the floor today, and kept so on purpose: 000h's count badge (white on #e5484d, 11px semibold) is 3.91:1.
 * Neon Noir was asked to leave 000h drawing exactly as it did (Jonathan, 2026-11-04), so it stays here, named, until
 * 000h's own palette is changed; Neon's count passes. Anything new short of the floor fails.
 */
const KNOWN: Record<string, Array<{ pair: string; ratio: number; min: number }>> = {
  '000h light': [{ pair: '--loom-count-ink on --loom-count', ratio: 3.91, min: 4.5 }],
  '000h dark': [{ pair: '--loom-count-ink on --loom-count', ratio: 3.91, min: 4.5 }],
};

describe('each look\'s contrast', () => {
  for (const [name, t] of Object.entries(LOOKS)) {
    it(`${name}: text 4.5:1, control edges 3:1, ink on the tints and the count 4.5:1`, () => {
      const short = PAIRS.map(([f, b, min]) => ({ pair: `${f} on ${b}`, ratio: +ratio(hex(t, f), hex(t, b)).toFixed(2), min })).filter((p) => p.ratio < p.min);
      expect(short).toEqual(KNOWN[name] ?? []);
    });
  }
  it('Neon Noir: its status inks and its own inks', () => {
    const short = NEON_PAIRS.map(([f, b, min]) => ({ pair: `${f} on ${b}`, ratio: +ratio(hex(neon, f), hex(neon, b)).toFixed(2), min })).filter((p) => p.ratio < p.min);
    expect(short).toEqual([]);
  });
  // Neon's lit things: an agent's rim and lit eyes on its card (3:1, a graphic), and a key's icon in its tint on the key's
  // own 9% wash of that tint over paper (neon.css: the dock, the launcher, an app's tile), a graphic too.
  it('Neon Noir: agents\' marks on paper, and each tint on its own key', () => {
    const mix = (a: string, b: string, t: number) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, '0')).join('')}`;
    const paper = hex(neon, '--v-paper');
    const marks = ['lilac', 'plum', 'pine', 'mustard', 'denim', 'coral'].map((m) => ({ pair: `--mark-${m} on --v-paper`, ratio: +ratio(hex(neon, `--mark-${m}`), paper).toFixed(2), min: 3 }));
    const keys = ['--v-pink', '--v-blue', '--v-yellow', '--v-olive'].map((t) => ({ pair: `${t} on its key`, ratio: +ratio(hex(neon, t), mix(hex(neon, t), paper, 0.09)).toFixed(2), min: 3 }));
    expect([...marks, ...keys].filter((p) => p.ratio < p.min)).toEqual([]);
  });
});
