/**
 * Each look's colours read (Jonathan, 2026-11-04, Neon Noir; 2026-11-05, the looks as token sets): text at 4.5:1 or
 * better on every surface it sits on, a control's edge at 3:1 or better, the ink on each of the four tints at 4.5:1,
 * the status inks on their washes, an agent's mark and each tint on its key at 3:1, and a face's lit eyes on its body.
 * Measured from the stylesheets themselves, for every look loom ships (web/src/looks/looks.css, over tokens.css): Neon
 * Noir and Low Light over its dark, Daylight over its light. And each one's Higher contrast (Accessibility, <html
 * data-contrast="more">): text at 7:1, the quieter texts and a control's edge at 4.5:1, a hairline at 3:1, and nothing
 * weaker than without it.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { MARKS as HOUSEHOLD_MARKS } from '../household.js';

const root = new URL('../../web/src/', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties of every block whose selector is exactly `sel` (a look may split its set over several), later
 * ones winning, as the cascade has it. */
function block(css: string, sel: string): Record<string, string> {
  const out: Record<string, string> = {};
  let at = css.indexOf(`${sel}{`);
  if (at < 0) throw new Error(`no ${sel} block`);
  for (; at >= 0; at = css.indexOf(`${sel}{`, at + 1)) {
    // Only a selector that starts there (not the tail of a longer one).
    if (at > 0 && !/[\s}]/.test(css[at - 1])) continue;
    const body = css.slice(at + sel.length + 1, css.indexOf('}', at));
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) out[m[1]] = m[2].trim();
  }
  return out;
}

const tokens = read('styles/cojeev/tokens.css');
const looks = read('looks/looks.css');
// loom's own (index.css --loom-*: the count badge and the rest swept from literals) over 000h's.
const own = read('index.css');
const loomBlock = (sel: string) => Object.fromEntries([...own.slice(own.indexOf(sel)).split('}')[0].matchAll(/(--loom-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const light = { ...block(tokens, ':root'), ...loomBlock(':root { --loom-ok:') };
const dark = { ...light, ...block(tokens, ':root[data-mode="dark"]'), ...loomBlock(':root[data-mode="dark"] { --loom-ok-ink') };
const set = (look: string) => block(looks, `:root[data-look="${look}"][data-mode]`);
const more = (look: string) => block(looks, `:root[data-look="${look}"][data-mode][data-contrast="more"]`);
const neon = { ...dark, ...set('neon') }, lowlight = { ...dark, ...set('lowlight') }, daylight = { ...light, ...set('daylight') };
const LOOKS = { 'Neon Noir': neon, 'Low Light': lowlight, Daylight: daylight } as const;
const MORE = { 'Neon Noir': { ...neon, ...more('neon') }, 'Low Light': { ...lowlight, ...more('lowlight') }, Daylight: { ...daylight, ...more('daylight') } } as const;

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
// Each look's status inks on their washes, and the inks on its ground.
const OWN_PAIRS: Array<[string, string, number]> = [
  ['--status-ok-ink', '--status-ok-bg', 4.5], ['--status-warn-ink', '--status-warn-bg', 4.5], ['--status-danger-ink', '--status-danger-bg', 4.5],
  ['--status-info-ink', '--status-info-bg', 4.5], ['--status-pending-ink', '--status-pending-bg', 4.5],
  ['--v-danger-ink', '--v-paper', 4.5], ['--v-accent-ink', '--v-paper', 4.5], ['--v-olive-ink', '--v-paper', 4.5], ['--sel-ink', '--sel-bg', 4.5],
];

// Higher contrast's floors: body text 7:1; the quieter texts, a control's edge and a selection's 4.5:1; a hairline 3:1.
const MORE_PAIRS: Array<[string, string, number]> = [
  ...[...SURFACES, ...TINTED].flatMap((s) => [['--v-text', s, 7], ['--v-text-2', s, 4.5], ['--v-text-3', s, 4.5]] as Array<[string, string, number]>),
  ...SURFACES.flatMap((s) => [['--v-edge', s, 4.5], ['--sel-edge', s, 4.5], ['--v-border', s, 3]] as Array<[string, string, number]>),
];

const mix = (a: string, b: string, t: number) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, '0')).join('')}`;
const MARKS = HOUSEHOLD_MARKS.map((m) => m.name.toLowerCase());

describe('each look\'s contrast', () => {
  it('ships at least Neon Noir, Low Light and Daylight, each a token set and nothing else', () => {
    expect(Object.keys(LOOKS)).toEqual(expect.arrayContaining(['Neon Noir', 'Low Light', 'Daylight']));
    // Anywhere in the app's stylesheets, a rule for one look is a root block of tokens: colours, corners, glow, type,
    // and the few surfaces they paint. Never a selector past :root, never a property that lays anything out.
    const TOKEN = /^--(v-|loom-|mark-|status-|surface-|sel-|switch-|sidebar|structure-|on-structure$|card$|popover$|destructive$|accent-foreground$|alert-ink$|nav-group-ink$|unavail-ink$|btn-disabled-ink$|muted-foreground-|glide-|ink-fixed$|cream-fixed$|face-|wash-|glow-|font-|fw-display$|ls-display$|default-font-family$|radius$|r-|shadow-float$)/;
    const sheets = ['looks/looks.css', 'index.css', 'desk.css', 'face.css', 'chart.css'].map((f) => [f, read(f)] as const);
    const rules = sheets.flatMap(([f, css]) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /data-look="/.test(m[1])).map((m) => ({ f, sel: m[1].trim(), body: m[2] })));
    expect(new Set(rules.map((r) => /data-look="(\w+)"/.exec(r.sel)![1]))).toEqual(new Set(['neon', 'lowlight', 'daylight']));
    expect(rules.filter((r) => !/^:root\[data-look="\w+"\]\[data-mode\](\[data-contrast="more"\])?$/.test(r.sel)).map((r) => `${r.f}: ${r.sel}`)).toEqual([]);
    const props = rules.flatMap((r) => r.body.split(';').map((d) => d.trim().split(':')[0].trim()).filter(Boolean).map((p) => ({ p, at: `${r.f}: ${r.sel}` })));
    expect(props.filter(({ p }) => p !== 'color-scheme' && !TOKEN.test(p)).map(({ p, at }) => `${at} { ${p} }`)).toEqual([]);
  });
  for (const [name, t] of Object.entries(LOOKS)) {
    it(`${name}: text 4.5:1, control edges 3:1, ink on the tints and the count 4.5:1, its status inks`, () => {
      const short = [...PAIRS, ...OWN_PAIRS].map(([f, b, min]) => ({ pair: `${f} on ${b}`, ratio: +ratio(hex(t, f), hex(t, b)).toFixed(2), min })).filter((p) => p.ratio < p.min);
      expect(short).toEqual([]);
    });
    // Lit things: an agent's rim and lit eyes on its card (3:1, a graphic), and a key's icon in its tint on the key's own
    // 9% wash of that tint over paper (looks.css: the dock, the launcher, an app's tile), a graphic too.
    it(`${name}: agents' marks on paper, and each tint on its own key`, () => {
      const paper = hex(t, '--v-paper');
      const marks = MARKS.map((m) => ({ pair: `--mark-${m} on --v-paper`, ratio: +ratio(hex(t, `--mark-${m}`), paper).toFixed(2), min: 3 }));
      const keys = ['--v-pink', '--v-blue', '--v-yellow', '--v-olive'].map((k) => ({ pair: `${k} on its key`, ratio: +ratio(hex(t, k), mix(hex(t, k), paper, 0.09)).toFixed(2), min: 3 }));
      expect([...marks, ...keys].filter((p) => p.ratio < p.min)).toEqual([]);
    });
    // A rim-lit face's eyes and mouth (face.tsx: the mark 72% toward --face-lit, white unless the look says) on its body
    // (the mark 16% over the canvas).
    it(`${name}: a face's lit eyes on its body, every mark`, () => {
      const canvas = hex(t, '--v-canvas'), lit = t['--face-lit'] ? hex(t, '--face-lit') : '#ffffff';
      const short = MARKS.map((m) => { const mk = hex(t, `--mark-${m}`); return { mark: m, ratio: +ratio(mix(mk, lit, 0.72), mix(mk, canvas, 0.16)).toFixed(2) }; }).filter((x) => x.ratio < 3);
      expect(short).toEqual([]);
    });
  }
  for (const [name, t] of Object.entries(MORE)) {
    const base = LOOKS[name as keyof typeof LOOKS];
    it(`${name}, higher contrast: text 7:1, the quieter texts and control edges 4.5:1, hairlines 3:1, on every surface`, () => {
      const short = MORE_PAIRS.map(([f, b, min]) => ({ pair: `${f} on ${b}`, ratio: +ratio(hex(t, f), hex(t, b)).toFixed(2), min })).filter((p) => p.ratio < p.min);
      expect(short).toEqual([]);
    });
    it(`${name}, higher contrast: every pair the look is held to still passes, none weaker than without it (the count too)`, () => {
      const rows = [...PAIRS, ...OWN_PAIRS].map(([f, b, min]) => ({ pair: `${f} on ${b}`, more: +ratio(hex(t, f), hex(t, b)).toFixed(2), was: +ratio(hex(base, f), hex(base, b)).toFixed(2), min }));
      expect(rows.filter((r) => r.more < r.min)).toEqual([]);
      expect(rows.filter((r) => r.more < r.was)).toEqual([]);
      // The texts are brighter, not only as bright: each one moved further from every surface it sits on.
      for (const f of ['--v-text-2', '--v-text-3']) expect(hex(t, f), `${name} ${f}`).not.toBe(hex(base, f));
    });
  }
});
