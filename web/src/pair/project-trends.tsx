import { useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { useDataQuery } from '../data/graphql';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from './ui/chart';
import { Button } from './ui/button';

type Window = { from: string; until: string; coverage: string; counts: { key: string; total: number }[] };
const buckets = [0, 1, 2, 3];
const query = `query ProjectTrend($project:String!,${[...buckets, 4].map((i) => '$d' + i + ':String!').join(',')}){
  ${buckets.map((i) => `w${i}:projectBacklogWindow(project:$project,since:$d${i},until:$d${i + 1}){from until coverage counts{key total}}`).join('\n')}
}`;
const day = 86400000;
const date = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export default function ProjectTrends({ project }: { project: string }) {
  const [days, setDays] = useState(7);
  const [end] = useState(Date.now);
  const variables = Object.fromEntries(
    [...buckets, 4].map((i) => ['d' + i, new Date(end - ((4 - i) * days * day) / 4).toISOString()]),
  );
  const read = useDataQuery<Record<string, Window | null>>(query, { project, ...variables });
  const windows = buckets.map((i) => read.data?.['w' + i]).filter((w): w is Window => !!w?.counts.length);
  const samples = new Map<number, number>();
  for (const w of windows) {
    const start = w.counts.find((c) => c.key === 'start'),
      finish = w.counts.find((c) => c.key === 'end');
    if (start && finish) {
      samples.set(Date.parse(w.from), start.total);
      samples.set(Date.parse(w.until), finish.total);
    }
  }
  const points = Array.from(samples, ([time, open]) => ({ time, open }));
  const first = points[0],
    last = points.at(-1);
  return (
    <section className="space-y-3" aria-label="Backlog history">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Open backlog</h3>
        <div className="flex gap-1">
          {[7, 30].map((n) => (
            <Button
              key={n}
              size="xs"
              variant={days === n ? 'secondary' : 'ghost'}
              aria-pressed={days === n}
              onClick={() => setDays(n)}
            >
              {n} days
            </Button>
          ))}
        </div>
      </div>
      {read.status !== 'live' ? (
        <p role="status">
          {read.status === 'loading' ? 'Reading backlog history…' : 'Backlog history unavailable.'}
        </p>
      ) : first && last ? (
        <>
          <p className="text-sm">
            {first.open} open on {date(first.time)} · {last.open} on {date(last.time)}
          </p>
          <ChartContainer
            className="h-44 w-full"
            config={{ open: { label: 'Open tickets', color: 'var(--foreground)' } }}
          >
            <LineChart accessibilityLayer data={points} margin={{ top: 8, right: 14, bottom: 4, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="time"
                type="number"
                domain={['dataMin', 'dataMax']}
                ticks={points.map((p) => p.time)}
                tickFormatter={date}
                minTickGap={32}
              />
              <YAxis allowDecimals={false} width={38} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => date(Number(payload[0]?.payload.time))}
                  />
                }
              />
              <Line
                dataKey="open"
                type="linear"
                stroke="var(--color-open)"
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ChartContainer>
          {first.time > Date.parse(variables.d0) && (
            <p className="text-xs text-muted-foreground">Recorded history begins {date(first.time)}.</p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No recorded history in this period.</p>
      )}
    </section>
  );
}
