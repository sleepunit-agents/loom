// A piece's chart (docs/extensions.md, "chart"): 000h's chart, bars, an area or a line, drawn from the piece's
// numbers. Its own chunk: a page without a chart never loads it.
import { CartesianChart } from '@/lib/cojeev/chart-cartesian';
import type { Block } from './loom';
import '@/styles/cojeev/chart.css';
import './chart.css';

type ChartB = Extract<Block, { type: 'chart' }>;

export default function ChartBlock({ b }: { b: ChartB }) {
  // A piece's numbers, as 000h's chart reads them: a missing value stays missing, never a zero.
  const data = b.data.map((p) => ({ ...p, label: String(p.label) }));
  return (
    <div className="loom-chart min-w-0"><CartesianChart kind={b.kind} variant={b.variant ?? (b.kind === 'bar' ? 'grouped' : 'smooth')} data={data} series={b.series}
      caption={b.caption ?? 'Chart'} appearance="brief" valueFormatter={(v) => v.toLocaleString()}
      {...(b.summary ? { summary: b.summary } : {})} /></div>
  );
}
