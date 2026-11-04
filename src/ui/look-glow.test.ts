/**
 * Neon Noir's glow never carries meaning (Jonathan's brief, 2026-11-04): it sits on edges and on what's current or
 * chosen, the same whatever an agent's state or a status is, never behind text, and it all goes when more contrast is
 * asked for. Checked over Neon's own sheets (looks/neon.css, and face.css's rim): every glow is a --glow-* token, every
 * --glow-* token is turned off under prefers-contrast: more, no glow rule is chosen by a state, a tone or a status, and
 * nothing casts a text-shadow. An agent's state is its face's expression (face-alive.test.ts, face-rim.test.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const web = new URL('../../web/src/', import.meta.url);
const css = (p: string) => readFileSync(new URL(p, web), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
// Neon's own sheet, the face's, and any Neon rule loom's own stylesheet carries (its rules under [data-look="neon"]).
const neonRulesOf = (s: string) => [...s.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes('data-look="neon"')).map((m) => m[0]).join('\n');
const SHEETS = { 'looks/neon.css': css('looks/neon.css'), 'face.css': css('face.css'), 'index.css (Neon\'s rules)': neonRulesOf(css('index.css')) };

/** A sheet split into what's inside @media (prefers-contrast: more) and what isn't. */
function split(s: string): { more: string; rest: string } {
  let more = '', rest = '', i = 0;
  for (const m of s.matchAll(/@media\s*\(\s*prefers-contrast\s*:\s*more\s*\)\s*\{/g)) {
    let depth = 1, j = m.index! + m[0].length;
    while (depth && j < s.length) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
    rest += s.slice(i, m.index); more += s.slice(m.index! + m[0].length, j - 1); i = j;
  }
  return { more, rest: rest + s.slice(i) };
}
const rules = (s: string) => [...s.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const decls = (body: string) => [...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map((m) => ({ prop: m[1], value: m[2].trim() }));
/** A declaration that lights something: a blurred shadow, a drop-shadow, an SVG filter. Not an inset hairline or a token. */
const lit = (prop: string, value: string) => (prop === 'box-shadow' || prop === 'filter' || prop === 'text-shadow')
  && !/^none$/.test(value) && value.split(/,(?![^(]*\))/).some((part) => /var\(--glow-|drop-shadow|url\(|\b0 0 \d+px/.test(part) && !/^\s*inset\b/.test(part));

describe('Neon Noir\'s glow', () => {
  for (const [file, s] of Object.entries(SHEETS)) {
    const { more, rest } = split(s);
    it(`${file}: every glow is a --glow-* token`, () => {
      const raw = rules(rest).flatMap((r) => decls(r.body).filter((d) => lit(d.prop, d.value) && !/var\(--glow-/.test(d.value)).map((d) => `${r.sel} { ${d.prop}: ${d.value} }`));
      expect(raw).toEqual([]);
    });
    it(`${file}: every --glow-* token is off when more contrast is asked for`, () => {
      if (!rest.trim()) return;
      const defined = new Set([...rest.matchAll(/(--glow-[\w-]+)\s*:/g)].map((m) => m[1]));
      const off = new Set([...more.matchAll(/(--glow-[\w-]+)\s*:\s*(none|0 0 0 0)\s*[;}]/g)].map((m) => m[1]));
      expect([...defined].filter((g) => !off.has(g))).toEqual([]);
    });
    it(`${file}: no glow rule is chosen by a state, a tone or a status; no text-shadow`, () => {
      const bad = rules(rest).filter((r) => decls(r.body).some((d) => lit(d.prop, d.value) || /^--glow-/.test(d.prop))
        // A :not() that only leaves out a kind of button (.-danger) says nothing of state; one naming a state does.
        && /data-state|data-tone|tone|status|warn|bad|danger|working|data-off/.test(r.sel.replace(/:not\((?![^)]*(data-state|data-tone|status|data-off))[^)]*\)/g, ''))).map((r) => r.sel);
      expect(bad).toEqual([]);
      expect(s).not.toMatch(/text-shadow/);
    });
  }

  it('the check catches a state hidden in a :not()', () => {
    const sel = '[data-slot="agent-face"]:not([data-state="idle"])';
    expect(/data-state/.test(sel.replace(/:not\((?![^)]*(data-state|data-tone|status|data-off))[^)]*\)/g, ''))).toBe(true);
  });
});
