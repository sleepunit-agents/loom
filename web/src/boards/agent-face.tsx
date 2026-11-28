/** An agent's face, the same wherever the boards page draws one (the conversation's header, the roster, the `agent`
 * brick): the agent's own pixel sprite where the household keeps one for it (`agents.spriteVersion`,
 * drawn by the desktop's own renderer, ../pixel-face.tsx: the head alone when small, the living bust when large);
 * Art's built-in sprite for Art where none is stored; and otherwise the face generated from the agent's colour,
 * shape and eyes (`agents.markBg/markFg/faceShape/faceEyes`, the desktop's shapes in face-data.json), still, with
 * the expression of its state. An agent whose look cannot be read has no face. */
import { lazy, Suspense } from 'react';
import data from '../face-data.json';
import type { FaceEyes, FaceShape, FaceState } from '../face-model';
import { Portrait } from '../contexts/portrait';
import { useDeskAgentDisplays } from '../pieces/attention/agent-displays';

type Part = { t: string; role: string; cx?: number; cy?: number; r?: number; rx?: number; ry?: number; d?: string; fill?: string; stroke?: string };
type Drawn = Exclude<FaceState, 'talking'>;
const families = data.families as unknown as Record<FaceShape, Record<Drawn, { d: string }>>;
const faces = data.faces as unknown as Record<FaceEyes, Record<Drawn, { offset: [number, number]; scale: number; parts: Part[] }>>;
// The pixel renderer is its own chunk, fetched the first time an agent with a stored sprite is drawn.
const PixelFace = lazy(() => import('../pixel-face'));
const PixelAvatar = lazy(() => import('../pixel-face').then((m) => ({ default: m.PixelAvatar })));

/** The sizes a face is drawn at, in px: in a roster's row, at the head of the `agent` brick, and as the
 * conversation's presence. From `head` up a sprite is the living bust in a frame. */
export const FACE = { row: 32, head: 48, presence: 52 } as const;
const colour = (c: string | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined);
const light = (hex: string) => { const n = parseInt(hex.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
/** The colour a generated face is drawn in: the agent's own, unless that would vanish into the card in one of the
 * two schemes (a near-black mark on the dark card, a near-white one on the light), where its other colour is used. */
export function faceInk(bg: string | undefined, fg: string | undefined): string {
  const mark = colour(bg) ?? '#B8A6FF', other = colour(fg) ?? mark;
  const onLight = light(mark) > 0.8 && light(other) < light(mark) ? other : mark, onDark = light(mark) < 0.12 && light(other) > light(mark) ? other : mark;
  return onLight === onDark ? mark : `light-dark(${onLight}, ${onDark})`;
}

export function AgentFace({ agent, state, size = FACE.presence }: { agent: string; state: FaceState; size?: number }) {
  const display = useDeskAgentDisplays().find((d) => d.id === agent);
  const framed = size >= FACE.head, box = { width: size, height: size };
  // Art's own sprite, built into the page, for Art where the household stores none.
  const builtIn = agent === 'art'
    ? <span className="boards-face" data-sprite="art" data-framed={framed} style={{ ...box, '--face': size / FACE.presence } as React.CSSProperties} aria-hidden="true"><Portrait className="art-portrait shrink-0" state={state} /></span> : null;
  if (!display) return builtIn;
  // The drawn face has no talking expression of its own: it talks as it looks done (face.tsx).
  const drawn: Drawn = state === 'talking' ? 'complete' : state;
  const body = (families[display.face.shape] ?? families.pebble)[drawn] ?? families.pebble.idle;
  const face = (faces[display.face.eyes] ?? faces.dot)[drawn] ?? faces.dot.idle;
  const ink = faceInk(display.mark.bg, display.mark.fg);
  const k = face.scale * data.sizes.row.faceScale, line = data.sizes.row.stroke / k;
  const paint = (c?: string) => (c === 'fg' ? ink : 'none');
  const generated = builtIn ?? (
    <span className="boards-face" data-drawn="true" data-framed={framed} style={box} aria-hidden="true">
      <svg viewBox="0 0 180 160" width="100%" height="100%" data-state={state} data-shape={display.face.shape}>
        <path d={body.d} style={{ fill: `color-mix(in srgb, ${ink} 16%, var(--popover, #07070C))`, stroke: ink }} strokeWidth={7} />
        <g transform={`translate(${90 + face.offset[0]} ${80 + face.offset[1]}) scale(${k}) translate(-90 -80)`}>
          {face.parts.filter((p) => p.role !== 'hi').map((p, n) => {
            const common = { fill: paint(p.fill), stroke: p.stroke ? paint(p.stroke) : undefined, strokeWidth: p.stroke ? line : undefined, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
            return p.t === 'circle' ? <circle key={n} {...common} cx={p.cx} cy={p.cy} r={p.r} /> : p.t === 'ellipse' ? <ellipse key={n} {...common} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} /> : <path key={n} {...common} d={p.d} />;
          })}
        </g>
      </svg>
    </span>
  );
  if (!display.sprite) return generated;
  // Until the sprite's sheet is here, and if it cannot be had, the generated face stands in its place.
  return (
    <span className="boards-face" data-sprite="stored" data-framed={framed} style={box} aria-hidden="true">
      <Suspense fallback={generated}>
        {framed ? <PixelFace sprite={display.sprite} state={state} size={size} scale={1} fallback={generated} /> : <PixelAvatar sprite={display.sprite} size={size} fallback={generated} />}
      </Suspense>
    </span>
  );
}
