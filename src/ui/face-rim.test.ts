// @vitest-environment node
/**
 * Neon Noir's faces (web/src/face.tsx `rim`): the same body and the same expression as 000h's, lit at the edge in the
 * mark's neon. The rim, its colour and its glow are the same in every state, so a state is never said by colour or glow:
 * the expression (the eyes and mouth, face-data.json) is what differs, as it does in 000h's finish.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import Face, { type FaceState } from '../../web/src/face';

const STATES: FaceState[] = ['idle', 'thinking', 'working', 'needs-input', 'complete', 'error'];
const draw = (state: FaceState, rim: boolean, bg = '#B8A6FF') => renderToStaticMarkup(h(Face, { bg, fg: '#1D1240', state, size: 72, rim }));
const shapes = (svg: string) => [...svg.matchAll(/<(circle|ellipse|path)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2] }));
const attr = (a: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(a)?.[1];
/** The body's paint: its style (fill, stroke) and its stroke's width, plus the face's class and glow colour. */
const rimOf = (svg: string) => { const b = shapes(svg)[0].attrs; return [attr(b, 'style'), attr(b, 'stroke-width'), /--mk:([^;"]*)/.exec(svg)?.[1], /class="([^"]*)"/.exec(svg)?.[1]].join(' | '); };
/** The expression: the eyes' and mouth's geometry, without paint. */
const face = (svg: string) => shapes(svg).slice(1).map(({ tag, attrs }) => [tag, ...['d', 'cx', 'cy', 'r', 'rx', 'ry'].map((k) => attr(attrs, k) ?? '')].join(' ')).join('\n');

describe('Neon\'s rim-lit faces', () => {
  it('the rim, its colour and its glow are the same in every state', () => {
    const rims = new Set(STATES.map((s) => rimOf(draw(s, true))));
    expect(rims.size).toBe(1);
    expect([...rims][0]).toContain('var(--mark-lilac, #B8A6FF)');
    expect([...rims][0]).toContain('loom-face--rim');
  });
  it('the expression says the state: each state\'s eyes and mouth differ, as in 000h', () => {
    const neon = STATES.map((s) => face(draw(s, true)));
    expect(new Set(neon).size).toBe(STATES.length);
    // The same expression as 000h's: the same shapes, only their paint differs.
    for (const s of STATES) expect(face(draw(s, true))).toBe(face(draw(s, false)));
  });
  it('a mark that isn\'t one of loom\'s six keeps its own colour', () => {
    expect(rimOf(draw('idle', true, '#123456'))).not.toContain('--mark-');
  });
});
