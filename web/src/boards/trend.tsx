/** The trend brick: tickets opened and tickets closed per day in a project (docs/specs/boards.md, "The first
 * bricks"). Small, it is two totals and a strip. Big, it is the chart, and a day shows the tickets behind it. */
import { useMemo, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import type { Form } from './layout';

type Row = { id: string; title: string; at: string };
export interface Day { date: string; opened: Row[]; closed: Row[] }
const local = (time: number) => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** The first moment of the day `days - 1` days before the day `now` is in, in the reader's own time. */
export function since(now: number, days: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
}
/** One entry per day, oldest first, each holding the tickets opened and closed on it. Pure. */
export function perDay(opened: readonly Row[], closed: readonly Row[], days: number, now: number): Day[] {
  const start = since(now, days);
  const out: Day[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    return { date: local(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i).getTime()), opened: [], closed: [] };
  });
  const at = new Map(out.map((d) => [d.date, d]));
  for (const r of opened) at.get(local(Date.parse(r.at)))?.opened.push(r);
  for (const r of closed) at.get(local(Date.parse(r.at)))?.closed.push(r);
  return out;
}
const short = (date: string) => new Date(date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const query = `query BrickTrend($project:String!,$since:String!){
  opened:tasks(where:{project:{eq:$project},createdAt:{gte:$since}},limit:2000){id title at:createdAt}
  closed:tasks(where:{project:{eq:$project},closedAt:{gte:$since}},limit:2000){id title at:closedAt}}`;

export function Trend({ project, days, form, chip }: { project: string; days: number; form: Form; chip(id: string): React.ReactNode }) {
  const [now] = useState(Date.now);
  const read = useDataQuery<{ opened: Row[]; closed: Row[] }>(query, { project, since: new Date(since(now, days)).toISOString() }, { keep: true });
  const series = useMemo(() => perDay(read.data?.opened ?? [], read.data?.closed ?? [], days, now), [read.data, days, now]);
  const [picked, pick] = useState<string | null>(null), [hover, setHover] = useState<number | null>(null);
  if (read.status === 'loading') return <p role="status" className="text-muted-foreground">Loading…</p>;
  if (read.status !== 'live') return <p className="text-muted-foreground">This project is unavailable.</p>;
  const opened = series.reduce((n, d) => n + d.opened.length, 0), closed = series.reduce((n, d) => n + d.closed.length, 0);
  const top = Math.max(1, ...series.map((d) => Math.max(d.opened.length, d.closed.length)));
  if (form === 'compact') return <p className="board-brief">{opened} opened · {closed} closed in {days} days</p>;
  const big = form === 'primary';
  // One band per day. Opened grows up from the baseline, closed grows down: one axis, two directions.
  const W = 600, H = big ? 220 : 90, pad = big ? 18 : 2, half = (H - pad * 2) / 2, band = W / days, bar = Math.min(24, Math.max(2, band - 2));
  const y = (n: number) => (n / top) * (half - (big ? 6 : 1));
  const net = opened - closed;
  const shown = picked ? series.find((d) => d.date === picked) : null;
  return (
    <div className="board-trend" data-form={form}>
      <p className="board-trend-key">
        <span><i data-series="opened" aria-hidden="true" /><b>{opened}</b> opened</span>
        <span><i data-series="closed" aria-hidden="true" /><b>{closed}</b> closed</span>
        <span className="text-muted-foreground">{net === 0 ? 'level' : net > 0 ? `${net} more open than ${days} days ago` : `${-net} fewer open than ${days} days ago`}</span>
      </p>
      <div className="board-trend-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Tickets opened and closed per day over ${days} days: ${opened} opened, ${closed} closed.`}
          onPointerLeave={() => setHover(null)}>
          {big && [-1, 1].map((s) => <line key={s} className="board-trend-grid" x1="0" x2={W} y1={H / 2 - s * y(top)} y2={H / 2 - s * y(top)} />)}
          {series.map((d, i) => {
            const x = i * band + (band - bar) / 2, up = y(d.opened.length), down = y(d.closed.length);
            return (
              <g key={d.date} data-on={hover === i || picked === d.date}>
                {up > 0 && <rect data-series="opened" x={x} y={H / 2 - 1 - up} width={bar} height={up} rx={Math.min(4, bar / 2)} />}
                {down > 0 && <rect data-series="closed" x={x} y={H / 2 + 1} width={bar} height={down} rx={Math.min(4, bar / 2)} />}
                {big && <rect className="board-trend-hit" x={i * band} y="0" width={band} height={H} onPointerEnter={() => setHover(i)}
                  onClick={() => pick(picked === d.date ? null : d.date)} />}
              </g>
            );
          })}
          <line className="board-trend-base" x1="0" x2={W} y1={H / 2} y2={H / 2} />
        </svg>
        {big && hover !== null && (
          <p className="board-trend-tip" style={{ left: `${((hover + 0.5) / days) * 100}%` }} data-end={hover > days * 0.7}>
            <b>{short(series[hover].date)}</b> {series[hover].opened.length} opened · {series[hover].closed.length} closed
          </p>
        )}
      </div>
      {big && <p className="board-trend-axis"><span>{short(series[0].date)}</span><span>most in a day: {top}</span><span>{short(series.at(-1)!.date)}</span></p>}
      {big && shown && (
        <div className="board-trend-day">
          <h3>{short(shown.date)}</h3>
          {(['opened', 'closed'] as const).map((k) => shown[k].length > 0 && (
            <p key={k}><span className="text-muted-foreground">{k}</span> {shown[k].map((t) => <span key={t.id}>{chip(t.id)} {t.title}</span>)}</p>
          ))}
          {!shown.opened.length && !shown.closed.length && <p className="text-muted-foreground">Nothing opened or closed.</p>}
        </div>
      )}
      {big && !shown && <p className="text-muted-foreground board-trend-hint">Pick a day to see its tickets.</p>}
    </div>
  );
}
