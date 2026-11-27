/** The `usage` brick: the desktop's Job usage app (pieces/usage) on a board, read-only. Its two selections, the
 * order of its conversations and the names of a job's measurements are that app's (pieces/usage/model.ts). The
 * range is the last `days` local days, today included, as the app's own default range is the last seven. loom
 * answers with the jobs the member may read and no others. The conversation whose jobs are listed is picked here
 * and is this drawn brick's state, never a parameter. */
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { byTokens, conversationsQuery, dayRange, format, groupTitle, jobsQuery, localDay, metrics, runKindWord, toolsLine, type UsageGroup, type UsageJob, type UsageRange } from '../pieces/usage/model';
import { isRef } from './admin-data';
import { Chip, Loading, Unavailable, type BodyProps } from './brick-kit';

function Jobs({ range, conversation }: { range: UsageRange; conversation: string | null }) {
  const [selected, setSelected] = useState<string>();
  const { status, data } = useDataQuery<{ conversationJobUsage: UsageJob[] }>(jobsQuery, { ...range, conversation }, { keep: true });
  if (status === 'loading') return <Loading />;
  if (status !== 'live' || !data || !Array.isArray(data.conversationJobUsage)) return <p className="text-muted-foreground">Job usage unavailable.</p>;
  if (!data.conversationJobUsage.length) return <p className="text-muted-foreground">No jobs in this conversation for this period.</p>;
  return (
    <>
      {data.conversationJobUsage.map(({ id, title, runKind, linkedWakeJob, state, usage, observations }) => (
        <div key={id}>
          <div className="board-line">
            <button type="button" className="board-action" aria-expanded={selected === id} onClick={() => setSelected(selected === id ? undefined : id)}>{title || id}</button>
            <span className="board-state">{[runKindWord(runKind), state].filter(Boolean).join(' · ')}</span>
            <span className="text-muted-foreground">{format(usage?.tokensIn)} in · {format(usage?.tokensOut)} out</span>
          </div>
          {selected === id && (
            <dl style={{ margin: '.3rem 0 .7rem' }}>
              {title && title !== id && <div><dt>Job ID</dt><dd className="font-mono">{id}</dd></div>}
              {linkedWakeJob && <div><dt>Woke job</dt><dd className="font-mono">{linkedWakeJob}</dd></div>}
              <div><dt>Harness</dt><dd>{usage?.harness ?? 'Unknown'}</dd></div>
              <div><dt>Model</dt><dd>{usage?.model ?? 'Unknown'}</dd></div>
              {Object.entries(metrics).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{format(usage?.[key as keyof typeof metrics])}</dd></div>)}
              <div><dt>Calls by tool</dt><dd>{toolsLine(usage)}</dd></div>
              <div><dt>Source</dt><dd>{usage?.source ?? 'Pending'}</dd></div>
              {observations.map((words, index) => <p key={index}>{words}</p>)}
            </dl>
          )}
        </div>
      ))}
    </>
  );
}

export function Usage({ params, form }: BodyProps) {
  const days = [1, 7, 30].includes(Number(params.days)) ? Number(params.days) : 7, primary = form === 'primary';
  // Two strings that change at local midnight, so the read is asked again only then.
  const range = dayRange(localDay(1 - days), localDay(0));
  const { status, data } = useDataQuery<{ jobUsageRollup: UsageGroup[] }>(conversationsQuery, { ...range }, { keep: true });
  const [open, setOpen] = useState<string | null>();
  if (status === 'loading') return <Loading />;
  if (status !== 'live' || !data || !Array.isArray(data.jobUsageRollup)) return <Unavailable what="usage report" />;
  const groups = byTokens(data.jobUsageRollup);
  const tokens = groups.reduce((n, g) => n + (g.totalTokens ?? 0), 0), jobs = groups.reduce((n, g) => n + g.jobCount, 0);
  const period = days === 1 ? 'today' : `the last ${days} days`;
  const count = groups.length ? `${format(tokens)} tokens reported · ${format(jobs)} job${jobs === 1 ? '' : 's'} · ${groups.length} conversation${groups.length === 1 ? '' : 's'} · ${period}` : `No jobs ${days === 1 ? 'today' : 'in ' + period}`;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  const cap = primary ? 60 : 6;
  const name = (g: UsageGroup) => (isRef(g.key) ? <Chip place={{ brick: 'session', params: { session: g.key } }}>{groupTitle(g)}</Chip> : <span>{groupTitle(g)}</span>);
  return (
    <>
      <p className="board-line"><span>{count}</span></p>
      {groups.slice(0, cap).map((g) => (
        <div key={JSON.stringify(g.key)}>
          <div className="board-line">
            {name(g)}
            <span>{format(g.totalTokens)} tokens</span>
            <span className="text-muted-foreground">{format(g.jobCount)} job{g.jobCount === 1 ? '' : 's'}{primary ? ` · ${format(g.retryCount)} retries · peak context ${format(g.largestContext)} (${format(g.jobsWithLargestContext)} of ${format(g.jobCount)} measured)` : ''}</span>
            {primary && <button type="button" className="board-action" aria-expanded={open === g.key} onClick={() => setOpen(open === g.key ? undefined : g.key)}>Jobs</button>}
          </div>
          {primary && open === g.key && <Jobs key={JSON.stringify(g.key)} conversation={g.key} range={range} />}
        </div>
      ))}
      {groups.length > cap && <p className="text-muted-foreground">and {groups.length - cap} more</p>}
    </>
  );
}
