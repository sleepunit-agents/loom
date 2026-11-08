// @vitest-environment node
/**
 * Agents' faces (web/src/face.tsx, face-data.json, face.css). Jonathan, 2026-11-04, on Art's working face: "looks like
 * he's taking a shit hahahaha. A rough one at that." Working reads as busy and pleased: open eyes, brows that don't
 * clench, a mouth that isn't a tight line, the body upright. And every face is alive, but quietly: CSS transforms
 * only, only on screen, each on its own phase, none with reduced motion.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import Face from '../../web/src/face';
import data from '../../web/src/face-data.json';

type Part = { t: string; role: string; cx?: number; cy?: number; r?: number; rx?: number; ry?: number; d?: string; fill?: string };
const faces = data.faces as unknown as Record<string, Record<string, { parts: Part[]; motion: string | null }>>;
const css = readFileSync(new URL('../../web/src/face.css', import.meta.url), 'utf-8');
const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe('the working face is busy and pleased, never straining', () => {
  for (const eyes of ['dot', 'oval']) {
    const parts = faces[eyes].working.parts;
    it(`${eyes} eyes: open (round, with a highlight), never squeezed arcs or lines`, () => {
      const e = parts.filter((p) => p.role === 'eye');
      expect(e).toHaveLength(2);
      for (const p of e) expect(p.t === 'circle' ? p.r! >= 5 : p.t === 'ellipse' && p.ry! >= 6).toBe(true);
      expect(parts.filter((p) => p.role === 'hi')).toHaveLength(2);
    });
    it(`${eyes} eyes: no brow slopes down toward the middle (a furrow)`, () => {
      for (const b of parts.filter((p) => p.role === 'brow')) {
        const n = nums(b.d!);
        const [x0, y0, x1, y1] = [n[0], n[1], n[n.length - 2], n[n.length - 1]];
        const [inner, outer] = Math.abs(x0 - 90) < Math.abs(x1 - 90) ? [y0, y1] : [y1, y0];
        expect(inner).toBeLessThanOrEqual(outer + 1);
      }
    });
    it(`${eyes} eyes: the mouth smiles (it's open, or curves down from its corners), not a tight line`, () => {
      const m = parts.find((p) => p.role === 'mouth')!;
      expect(/^M[\d.]+ [\d.]+H/.test(m.d!)).toBe(false);
      const n = nums(m.d!);
      expect(Math.max(...n.filter((_, i) => i % 2)) - n[1]).toBeGreaterThanOrEqual(4);
    });
  }
  it('its body is upright (idle\'s), not the squashed working silhouette that churned', () => {
    for (const fam of Object.values(data.families as Record<string, Record<string, { d: string; frames?: string[] }>>)) {
      expect(fam.working.d).toBe(fam.idle.d);
      expect(fam.working.frames).toBeUndefined();
    }
  });
});

describe('alive, quietly', () => {
  it('every state moves, and only a live face (on screen, in a visible page) does', () => {
    for (const s of ['idle', 'thinking', 'working', 'needs-input', 'complete', 'error']) {
      expect(css).toContain(`.loom-face[data-live][data-state="${s}"] .loom-face__field`);
    }
    for (const rule of css.match(/animation-name:[^;]+/g) ?? []) expect(rule).toMatch(/face-/);
    expect([...css.matchAll(/\.loom-face\S*\s*\.loom-face__(?:field|eyes)\s*\{[^}]*animation-name/g)].every((m) => m[0].includes('[data-live]'))).toBe(true);
  });
  it('transforms only: the keyframes move scale, translate and rotate, nothing that lays out or repaints', () => {
    const frames = css.slice(css.indexOf('@keyframes'), css.indexOf('@media (prefers-reduced-motion'));
    const props = new Set([...frames.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]));
    expect([...props].filter((p) => !['scale', 'translate', 'rotate'].includes(p))).toEqual([]);
  });
  it('none with reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none !important/);
  });
  it('a face says its size and its own phase, so a row of faces doesn\'t blink in unison', () => {
    const html = (size: number) => renderToStaticMarkup(h(Face, { bg: '#B8A6FF', fg: '#1D1240', state: 'working', size }));
    expect(html(24)).toContain('data-tier="dock"');
    expect(html(40)).toContain('data-tier="row"');
    expect(html(120)).toContain('data-tier="card"');
    expect(html(120)).toMatch(/--face-phase:-\d+(\.\d+)?s/);
    // Rendered off screen (here, on the server) it isn't live: nothing moves until it's seen.
    expect(html(120)).not.toContain('data-live');
  });
});
