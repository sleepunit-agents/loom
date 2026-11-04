/**
 * Neon Noir's glow never carries meaning (Jonathan's brief, 2026-11-04): it sits on edges and on what's current, the
 * same whatever an agent's state or a status is, so nothing is said by glow alone, and it goes when more contrast is
 * asked for. An agent's state is its face's expression (face-alive.test.ts); a status is its word.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const web = new URL('../../web/src/', import.meta.url);
const css = (p: string) => readFileSync(new URL(p, web), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (s: string) => [...s.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const glows = (body: string) => /(box-shadow|filter)\s*:[^;]*(glow|drop-shadow|0 0 \d+px)/.test(body);

describe('Neon Noir\'s glow', () => {
  const sheets = { 'looks/neon.css': css('looks/neon.css'), 'face.css': css('face.css') };
  it('no glow rule is chosen by a state, a tone or a status', () => {
    const bad = Object.entries(sheets).flatMap(([f, s]) => rules(s).filter((r) => glows(r.body) && /data-state|data-tone|tone|status|warn|bad|danger|working/.test(r.sel.replace(/:not\([^)]*\)/g, ''))).map((r) => `${f}: ${r.sel}`));
    expect(bad).toEqual([]);
  });
  it('goes when more contrast is asked for', () => {
    for (const s of Object.values(sheets)) expect(s).toMatch(/@media \(prefers-contrast:\s?more\)/);
  });
});
