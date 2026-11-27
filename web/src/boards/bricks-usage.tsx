/** The `usage` brick: the desktop's Job usage app (pieces/usage) on a board, read-only. Its two selections, the
 * order of its conversations and the names of a job's measurements are that app's (pieces/usage/model.ts). The
 * range is the last `days` local days, today included, as the app's own default range is the last seven. loom
 * answers with the jobs the member may read and no others. The conversation whose jobs are listed is picked here
 * and is this drawn brick's state, never a parameter. */
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { byTokens, conversationsQuery, dayRange, format, groupTitle, jobsQuery, localDay, metrics, runKindWord, toolsLine, type UsageGroup, type UsageJob, type UsageRange } from '../pieces/usage/model';
import { isRef } from './admin-data';
import { Fact, Facts, Few, Lead, Loading, More, Note, Opened, Opens, Row, Rows, State, Unavailable, count, type BodyProps, type Tone } from './brick-kit';

const jobTone = (state: string | null): Tone => (state === 'queued' || state === 'starting' || state === 'running' ? 'working' : state === 'done' ? 'good' : state === 'failed' ? 'bad' : 'muted');

function Jobs({ range, conversation }: { range: UsageRange; conversation: string | null }) {
  const [selected, setSelected] = useState<string>();
  const { status, data } = useDataQuery<{ conversationJobUsage: UsageJob[] }>(jobsQuery, { ...range, conversation }, { keep: true });
  if (status === 'loading') return <Loading />;
  if (status !== 'live' || !data || !Array.isArray(data.conversationJobUsage)) return <Note>Job usage unavailable.</Note>;
  if (!data.conversationJobUsage.length) return <Note>No jobs in this conversation for this period.</Note>;
  return (
    <Opened>
      <Rows>
        {data.conversationJobUsage.map(({ id, title, runKind, linkedWakeJob, state, usage, observations }) => (
          <Row key={id} title={<Opens open={selected === id} onToggle={() => setSelected(selected === id ? undefined : id)}>{title || id}</Opens>}
            meta={<span className="board-number">{format(usage?.tokensIn)} in · {format(usage?.tokensOut)} out</span>}
            end={<State tone={jobTone(state)}>{[runKindWord(runKind), state].filter(Boolean).join(' · ')}</State>}>
            {selected === id && (
              <Opened>
                <Facts>
                  {title && title !== id && <Fact label="Job ID"><span className="font-mono">{id}</span></Fact>}
                  {linkedWakeJob && <Fact label="Woke job"><span className="font-mono">{linkedWakeJob}</span></Fact>}
                  <Fact label="Harness">{usage?.harness ?? 'Unknown'}</Fact>
                  <Fact label="Model">{usage?.model ?? 'Unknown'}</Fact>
                  {Object.entries(metrics).map(([key, label]) => <Fact key={key} label={label}><span className="board-number">{format(usage?.[key as keyof typeof metrics])}</span></Fact>)}
                  <Fact label="Calls by tool">{toolsLine(usage)}</Fact>
                  <Fact label="Source">{usage?.source ?? 'Pending'}</Fact>
                </Facts>
                {observations.map((words, index) => <Note key={index}>{words}</Note>)}
              </Opened>
            )}
          </Row>
        ))}
      </Rows>
    </Opened>
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
  const rest = `${format(jobs)} job${jobs === 1 ? '' : 's'} · ${count(groups.length, 'conversation')} · ${period}`;
  if (form === 'compact') return <p className="board-brief">{groups.length ? `${format(tokens)} tokens reported · ${rest}` : `No jobs ${days === 1 ? 'today' : 'in ' + period}`}</p>;
  if (!groups.length) return <Note>No jobs {days === 1 ? 'today' : 'in ' + period}</Note>;
  const cap = primary ? 60 : 4;
  return (
    <>
      <Lead>{format(tokens)} tokens reported</Lead>
      <div className="board-meta"><span>{rest}</span></div>
      <Few of={groups} first={cap} fit={!primary}>{(shown, hidden) => <>
      <Rows>
        {shown.map((g) => (
          <Row key={JSON.stringify(g.key)} title={groupTitle(g)} place={isRef(g.key) ? { brick: 'session', params: { session: g.key } } : undefined}
            end={<span className="board-number">{format(g.totalTokens)} tokens</span>}>
            {primary && <div className="board-meta">
              <span>{format(g.jobCount)} job{g.jobCount === 1 ? '' : 's'} · {format(g.retryCount)} retries · peak context {format(g.largestContext)} ({format(g.jobsWithLargestContext)} of {format(g.jobCount)} measured)</span>
              <Opens open={open === g.key} onToggle={() => setOpen(open === g.key ? undefined : g.key)}>Jobs</Opens>
            </div>}
            {primary && open === g.key && <Jobs key={JSON.stringify(g.key)} conversation={g.key} range={range} />}
          </Row>
        ))}
      </Rows>
      <More n={hidden} />
      </>}</Few>
    </>
  );
}
