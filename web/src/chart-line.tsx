// A chart in one line (t-1925, Tasks in a narrow window): where a page's side column folds away (a phone, a narrow
// tile), its chart would be hidden in the fold or, opened, push the page down by 300 px. Instead the fold has a strip
// over it: the chart's number, what it says, and its series as a small sparkline, one line high; the whole chart is
// still in the fold. Its own chunk: a page without a chart in its side never loads it.
import type { Block } from './loom';
import './chart-line.css';

type ChartB = Extract<Block, { type: 'chart' }>;

const COLOR: Record<string, string> = { pink: 'var(--v-pink)', blue: 'var(--v-blue)', olive: 'var(--v-olive)', yellow: 'var(--v-yellow)', ink: 'var(--v-ink)' };
const H = 20, BAR = 3, GAP = 1, GROUP = 3;

/** The series as a small picture: bars side by side per point (a bar chart), else a line per series. */
export function sparkOf(b: Pick<ChartB, 'kind' | 'series' | 'data'>): { w: number; bars: { x: number; h: number; c: string }[]; lines: { d: string; c: string }[] } {
  const n = b.data.length, s = b.series.length || 1;
  const val = (p: ChartB['data'][number], k: string) => { const v = p[k]; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
  const max = Math.max(1, ...b.data.flatMap((p) => b.series.map((x) => val(p, x.key) ?? 0)));
  const color = (i: number) => COLOR[b.series[i]?.color ?? ''] ?? 'currentColor';
  if (b.kind === 'bar') {
    const step = s * (BAR + GAP) + GROUP;
    const bars = b.data.flatMap((p, i) => b.series.map((x, j) => ({ x: i * step + j * (BAR + GAP), h: Math.max(val(p, x.key) ? 1 : 0, Math.round(((val(p, x.key) ?? 0) / max) * H)), c: color(j) })));
    return { w: Math.max(0, n * step - GROUP), bars, lines: [] };
  }
  const w = Math.max(24, (n - 1) * 8);
  const lines = b.series.map((x, j) => ({ c: color(j), d: b.data.map((p, i) => [i, val(p, x.key)] as const).filter(([, v]) => v !== null)
    .map(([i, v], k) => `${k ? 'L' : 'M'}${n > 1 ? (i * w) / (n - 1) : 0} ${H - ((v as number) / max) * H}`).join(' ') }));
  return { w, bars: [], lines };
}

export default function ChartLine({ b, title }: { b: ChartB; title?: string }) {
  const sp = sparkOf(b);
  const name = title || b.caption || 'Chart';
  return (
    <div className="loom-chartline" role="group" aria-label={name}>
      <span className="loom-chartline__name">{name}</span>
      {b.summary && <span className="loom-chartline__num"><span className="loom-chartline__label">{b.summary.label}</span>
        <b className="loom-data">{b.summary.value}</b>{b.summary.detail && <span className="loom-chartline__detail">{b.summary.detail}</span>}</span>}
      {/* The picture is the numbers' shape; the numbers themselves are the whole chart's, in the fold. */}
      <svg className="loom-chartline__spark" width={sp.w} height={H} viewBox={`0 0 ${sp.w} ${H}`} aria-hidden>
        {sp.bars.map((r, i) => <rect key={i} x={r.x} y={H - r.h} width={BAR} height={r.h} rx={1} fill={r.c} />)}
        {sp.lines.map((l, i) => <path key={i} d={l.d} fill="none" stroke={l.c} strokeWidth={1.5} strokeLinejoin="round" />)}
      </svg>
      <span className="loom-chartline__keys" aria-hidden>{b.series.map((x) => <span key={x.key}><i style={{ background: COLOR[x.color ?? ''] ?? 'currentColor' }} />{x.label}</span>)}</span>
    </div>
  );
}
