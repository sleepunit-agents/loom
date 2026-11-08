// A piece's chart (docs/extensions.md, "chart"): 000h's chart, bars, an area or a line, drawn from the piece's
// numbers. Its own chunk: a page without a chart never loads it.
import { useContext } from 'react';
import { CartesianChart } from '@/lib/cojeev/chart-cartesian';
import type { Block } from './loom';
import { InSide } from './side';
import '@/styles/cojeev/chart.css';
import './chart.css';

type ChartB = Extract<Block, { type: 'chart' }>;

/** A chart in a page's side column is drawn shorter: a glance beside the page, not its subject. There the chart is the
 * point, so it has no Show data button (Jonathan's Tasks mock, t-1925): its numbers stay in a visually hidden table for
 * a screen reader. */
const SIDE_PLOT = 170;

export default function ChartBlock({ b }: { b: ChartB }) {
  const side = useContext(InSide);
  // A piece's numbers, as 000h's chart reads them: a missing value stays missing, never a zero.
  const data = b.data.map((p) => ({ ...p, label: String(p.label) }));
  return (
    <div className="loom-chart min-w-0"><CartesianChart kind={b.kind} variant={b.variant ?? (b.kind === 'bar' ? 'grouped' : 'smooth')} data={data} series={b.series}
      caption={b.caption ?? 'Chart'} appearance="brief" valueFormatter={(v) => v.toLocaleString()} {...(side ? { plotHeight: SIDE_PLOT, tableToggle: false } : {})}
      {...(b.summary ? { summary: b.summary } : {})} /></div>
  );
}
