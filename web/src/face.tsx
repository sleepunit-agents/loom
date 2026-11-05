// An agent's face (Jonathan, 2026-11-03: "they need faces"): its own body shape (a family: pebble, trefoil, clover,
// drop) in its mark's colour, with eyes and a mouth whose expression is its state: calm, glancing, focused, asking,
// pleased, worried. The shape and the eyes say who; the expression says how, and reads in a still frame and in grey,
// so neither rests on colour or motion. Paths: the identity prototype's spec (face-data.json), all of one topology
// so a state morphs into the next. Its own chunk; until it loads, the mark's initial stands in.
//
// Alive (Jonathan, 2026-11-04: "should feel more alive"): it breathes at rest, blinks and looks around now and then,
// bobs and scans while working, sways while thinking (face.css). CSS transforms only, each face on its own phase so
// a list never blinks in unison; only while it's on screen and the page is visible; none with reduced motion.
import { motion, useInView } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import './face.css';
import { useChoreography } from '@/lib/cojeev-motion/choreography';
import data from './face-data.json';
import { markColor, markName } from './look';

export type FaceState = 'idle' | 'thinking' | 'working' | 'needs-input' | 'complete' | 'error';
export type FaceShape = 'pebble' | 'trefoil' | 'clover' | 'drop';
export type FaceEyes = 'dot' | 'oval';
export const SHAPES: FaceShape[] = ['pebble', 'trefoil', 'clover', 'drop'];
export const EYES: FaceEyes[] = ['dot', 'oval'];
export const STATE_WORD: Record<FaceState, string> = {
  idle: 'quiet', thinking: 'thinking', working: 'working', 'needs-input': 'waiting on you', complete: 'done', error: 'needs a look',
};

type Part = { t: 'circle' | 'ellipse' | 'path'; role: string; cx?: number; cy?: number; r?: number; rx?: number; ry?: number; d?: string; fill?: string; stroke?: string };
type FaceSpec = { offset: [number, number]; scale: number; motion: string | null; parts: Part[] };
type Body = { d: string; frames?: string[]; dur?: number; ease?: string };
const families = data.families as Record<FaceShape, Record<FaceState, Body>>;
const faces = data.faces as unknown as Record<FaceEyes, Record<FaceState, FaceSpec>>;

/** A hex colour mixed toward another by t (0..1). */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
/** The rim's width by size (viewBox units): thicker small, so it reads as a lit edge at dock size. */
const RIM = { dock: 10, row: 7, card: 5 } as const;
/** loom's first mark (src/household.ts MARKS: Lilac), for a face given no colour of its own. */
const LILAC = { bg: '#B8A6FF' };
const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

/**
 * Rim-lit (Neon's finish, every look's since 2026-11-05): the body glass in the canvas's colour lit at its edge in the
 * mark's colour as the look wears it (looks.css --mark-*), the eyes and mouth lit in it too (toward --face-lit: white on a
 * dark look, ink on a light one), a soft glow around it where the look glows (face.css). The eyes' small highlights are
 * left out (on a lit eye they read as holes). The rim and the glow are the same in every state: the expression says the
 * state (src/ui/face-rim.test.ts).
 */
export default function Face({ bg, shape = 'pebble', eyes = 'dot', state = 'idle', size = 40, label, dark = false }: {
  bg: string; fg: string; shape?: FaceShape; eyes?: FaceEyes; state?: FaceState; size?: number; label?: string; dark?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const { quiet } = useChoreography();
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { margin: '40px' });
  const shown = useVisible();
  const fam = families[shape] ?? families.pebble;
  const body = fam[state] ?? fam.idle;
  const face = (faces[eyes] ?? faces.dot)[state] ?? faces.dot.idle;
  // A dark mark lifts on a dark ground, so it doesn't sink into it.
  const base = /^#[0-9a-f]{6}$/i.test(bg) ? (dark && lum(bg) < 0.2 ? mix(bg, '#ffffff', 0.28) : bg) : LILAC.bg;
  // Small sizes: a bigger face with thicker lines, and no brows or highlights at dock size.
  const tier = size <= 28 ? data.sizes.dock : size <= 56 ? data.sizes.row : data.sizes.card;
  const drop = new Set((tier as { drop?: string[] }).drop ?? []);
  const k = face.scale * tier.faceScale;
  const stroke = tier.stroke / k;
  const move = !quiet;
  // Moving only where it's seen: off screen or in a hidden tab, nothing runs (the body's morph included).
  const live = move && inView && shown;
  const loop = live && body.frames ? { d: body.frames } : { d: body.d };
  const loopT = live && body.frames ? { duration: body.dur ?? 3, repeat: Infinity, ease: (body.ease === 'linear' ? 'linear' : 'easeInOut') as 'linear' | 'easeInOut' } : { duration: quiet ? 0 : 0.6 };
  // The rim: the look's own colour for one of loom's marks, else this mark's (lifted on the dark, as above).
  const mk = markName(bg) ? markColor(bg) : base;
  const lit = `color-mix(in srgb, ${mk} 72%, var(--face-lit, #fff))`;
  const paint = (c?: string) => (c === 'fg' ? lit : c === 'hi' ? 'none' : c ?? 'none');
  const part = (p: Part, n: number) => {
    if (drop.has(p.role)) return null;
    const fill = p.fill ? paint(p.fill) : 'none', line = p.stroke ? paint(p.stroke) : undefined;
    // A colour-mix() is CSS, not an SVG paint: the rim's go in style.
    const common = { key: n, style: { fill, stroke: line }, strokeWidth: p.stroke ? stroke : undefined, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
    if (p.t === 'circle') return <circle {...common} cx={p.cx} cy={p.cy} r={p.r} />;
    if (p.t === 'ellipse') return <ellipse {...common} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} />;
    return <path {...common} d={p.d} />;
  };
  const eyesParts = face.parts.filter((p) => p.role === 'eye' || p.role === 'hi');
  const rest = face.parts.filter((p) => p.role !== 'eye' && p.role !== 'hi');
  const [ox, oy] = face.offset;
  return (
    <svg ref={ref} role="img" aria-label={label ? `${label}, ${STATE_WORD[state]}` : STATE_WORD[state]} viewBox="0 0 180 160" width={size} height={size * 160 / 180}
      data-slot="agent-face" data-state={state} data-shape={shape} data-motion={move ? face.motion ?? undefined : undefined} data-live={live || undefined}
      data-tier={size <= 28 ? 'dock' : size <= 56 ? 'row' : 'card'} style={{ '--face-phase': `${-phaseOf(id)}s`, '--mk': mk } as React.CSSProperties}
      className="loom-face loom-face--rim shrink-0 overflow-visible">
      <g className="loom-face__field">
        <motion.path initial={false} d={body.d} animate={loop} transition={loopT} style={{ fill: `color-mix(in srgb, ${mk} 16%, var(--v-canvas, #07070C))`, stroke: mk }} strokeWidth={RIM[size <= 28 ? 'dock' : size <= 56 ? 'row' : 'card']} />
        <g transform={`translate(${90 + ox} ${80 + oy}) scale(${k}) translate(-90 -80)`}>
          <g className="loom-face__eyes">{eyesParts.map(part)}</g>
          {rest.map(part)}
        </g>
      </g>
    </svg>
  );
}

/** Whether the page is visible (a hidden tab runs nothing). */
function useVisible(): boolean {
  const [v, setV] = useState(true);
  useEffect(() => {
    const update = () => setV(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return v;
}

/** Where in its loops a face starts, 0 to 12 s, steady for one face: a row of them breathes and blinks out of step. */
function phaseOf(id: string): number {
  let h = 7;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 1200) / 100;
}
