/** An agent's face, still: the desktop's own shapes (face-data.json) in the agent's own colour, shape and eyes
 * (`agents.markBg/faceShape/faceEyes`, read as the desktop reads them), with the expression of its state. The
 * desktop's Face (web/src/face.tsx) is the same drawing with motion and a look; this is the part with neither. */
import data from '../face-data.json';
import type { FaceEyes, FaceShape, FaceState } from '../face';
import { useDeskAgentDisplays } from '../pieces/attention/agent-displays';

type Part = { t: string; role: string; cx?: number; cy?: number; r?: number; rx?: number; ry?: number; d?: string; fill?: string; stroke?: string };
type Drawn = Exclude<FaceState, 'talking'>;
const families = data.families as unknown as Record<FaceShape, Record<Drawn, { d: string }>>;
const faces = data.faces as unknown as Record<FaceEyes, Record<Drawn, { offset: [number, number]; scale: number; parts: Part[] }>>;

export function AgentFace({ agent, state }: { agent: string; state: FaceState }) {
  const display = useDeskAgentDisplays().find((d) => d.id === agent);
  if (!display) return null;
  // The drawn face has no talking expression of its own: it talks as it looks done (face.tsx).
  const drawn: Drawn = state === 'talking' ? 'complete' : state;
  const body = (families[display.face.shape] ?? families.pebble)[drawn] ?? families.pebble.idle;
  const face = (faces[display.face.eyes] ?? faces.dot)[drawn] ?? faces.dot.idle;
  const mark = /^#[0-9a-f]{6}$/i.test(display.mark.bg) ? display.mark.bg : '#B8A6FF';
  const k = face.scale * data.sizes.row.faceScale, line = data.sizes.row.stroke / k;
  const paint = (c?: string) => (c === 'fg' ? mark : 'none');
  return (
    <span className="boards-face" data-drawn="true" aria-hidden="true">
      <svg viewBox="0 0 180 160" width="100%" height="100%" data-state={state} data-shape={display.face.shape}>
        <path d={body.d} style={{ fill: `color-mix(in srgb, ${mark} 16%, var(--popover, #07070C))`, stroke: mark }} strokeWidth={7} />
        <g transform={`translate(${90 + face.offset[0]} ${80 + face.offset[1]}) scale(${k}) translate(-90 -80)`}>
          {face.parts.filter((p) => p.role !== 'hi').map((p, n) => {
            const common = { fill: paint(p.fill), stroke: p.stroke ? paint(p.stroke) : undefined, strokeWidth: p.stroke ? line : undefined, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
            return p.t === 'circle' ? <circle key={n} {...common} cx={p.cx} cy={p.cy} r={p.r} /> : p.t === 'ellipse' ? <ellipse key={n} {...common} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} /> : <path key={n} {...common} d={p.d} />;
          })}
        </g>
      </svg>
    </span>
  );
}
