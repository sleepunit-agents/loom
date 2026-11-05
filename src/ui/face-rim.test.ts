// @vitest-environment node
/**
 * An agent's drawn face (web/src/face.tsx): rim-lit in every look, at the edge in the mark's colour as the look wears
 * it. The rim, its colour and its glow are the same in every state, so a state is never said by colour or glow: the
 * expression (the eyes and mouth, face-data.json) is what differs.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import Face, { type FaceState } from '../../web/src/face';

const STATES: FaceState[] = ['idle', 'thinking', 'working', 'needs-input', 'complete', 'error'];
const draw = (state: FaceState, bg = '#B8A6FF') => renderToStaticMarkup(h(Face, { bg, fg: '#1D1240', state, size: 72 }));
const shapes = (svg: string) => [...svg.matchAll(/<(circle|ellipse|path)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2] }));
const attr = (a: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(a)?.[1];
/** The body's paint: its style (fill, stroke) and its stroke's width, plus the face's class and glow colour. */
const rimOf = (svg: string) => { const b = shapes(svg)[0].attrs; return [attr(b, 'style'), attr(b, 'stroke-width'), /--mk:([^;"]*)/.exec(svg)?.[1], /class="([^"]*)"/.exec(svg)?.[1]].join(' | '); };
/** The expression: the eyes' and mouth's geometry, without paint. */
const face = (svg: string) => shapes(svg).slice(1).map(({ tag, attrs }) => [tag, ...['d', 'cx', 'cy', 'r', 'rx', 'ry'].map((k) => attr(attrs, k) ?? '')].join(' ')).join('\n');

describe('rim-lit faces', () => {
  it('the rim, its colour and its glow are the same in every state', () => {
    const rims = new Set(STATES.map((s) => rimOf(draw(s))));
    expect(rims.size).toBe(1);
    expect([...rims][0]).toContain('var(--mark-lilac, #B8A6FF)');
    expect([...rims][0]).toContain('loom-face--rim');
  });
  it('the expression says the state: each state\'s eyes and mouth differ', () => {
    expect(new Set(STATES.map((s) => face(draw(s)))).size).toBe(STATES.length);
  });
  it('its lit eyes go toward the look\'s --face-lit (white unless the look says: ink on Daylight)', () => {
    expect(draw('idle')).toContain('var(--face-lit, #fff)');
  });
  it('a mark that isn\'t one of loom\'s six keeps its own colour', () => {
    expect(rimOf(draw('idle', '#123456'))).not.toContain('--mark-');
  });
});
