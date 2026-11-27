/** The live work trace of a handed-off session (docs/specs/boards.md, "Sessions"): the steps its job's body
 * reported, oldest first, read as the member looking and redrawn as each step arrives. Loom keeps a trace only
 * for work handed off from the member's own thread; any other session, and anybody else, reads none. */
import { useEffect, useRef } from 'react';
import { useDataQuery } from '../data/graphql';
import { WorkTrace } from '../pair/work-trace';
import { workTree, type EventMessage } from '../pair/work-tree';

export type TraceStep = { seq: number; job: string; at: string; tool: string; cardState: 'running' | 'done' | 'failed'; clientId: string; words: string | null };
/** The most steps one read carries; the server allows no more than 200. */
export const TRACE_STEPS = 100;

/** A step as the conversation's own work-trace cards read one, so both draw the same way: a call and its
 * result are one card, and a subagent's steps sit inside its card (pair/work-tree.ts). */
export const traceEvents = (steps: TraceStep[]): EventMessage[] =>
  steps.map((s) => ({ thread: '', sender: '', kind: 'card', seq: s.seq, at: s.at, run: s.job, tool: s.tool, cardState: s.cardState, clientId: s.clientId, words: s.words }));

/** The big form's trace: newest at the bottom, kept in view while the member has not scrolled away from it. */
export function SessionTrace({ conversation, job, running }: { conversation: string; job: string; running: boolean }) {
  const read = useDataQuery<{ steps: TraceStep[]; gone: boolean }>(
    'query BrickSessionTrace($c:String!,$j:String!,$n:Int!){steps:sessionTrace(conversation:$c,job:$j,limit:$n){seq job at tool cardState clientId words} gone:sessionTraceExpired(conversation:$c,job:$j)}',
    { c: conversation, j: job, n: TRACE_STEPS }, { keep: true });
  const steps = read.data?.steps ?? [], last = steps.at(-1)?.seq ?? 0;
  const box = useRef<HTMLDivElement>(null), follow = useRef(true);
  useEffect(() => { const el = box.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [last]);
  if (read.status === 'loading') return <p role="status" className="text-muted-foreground">Loading…</p>;
  if (read.status !== 'live') return <p className="text-muted-foreground">Its steps are unavailable.</p>;
  // A step is deleted when it is past its keep time. Loom says so of a job that has none and is older than that time.
  if (!steps.length && read.data?.gone) return <p className="text-muted-foreground" data-session-trace-gone="">Its steps are no longer kept. Loom keeps a step for a limited time and then deletes it.</p>;
  if (!steps.length) return <p className="text-muted-foreground">{running ? 'No steps reported yet.' : 'No steps were recorded.'}</p>;
  const latestTerminal = steps.findLast((s) => s.tool.endsWith('Terminal') && s.cardState !== 'running')?.seq;
  return (
    <>
      {steps.length === TRACE_STEPS && <p className="text-muted-foreground">The latest {TRACE_STEPS} steps.</p>}
      <div ref={box} role="log" aria-label="Steps" data-session-trace=""
        style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', maxHeight: '24rem', overflowY: 'auto', overflowWrap: 'anywhere' }}
        onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {workTree(traceEvents(steps)).map((node) => <WorkTrace key={node.events[0].seq} node={node} latestTerminal={latestTerminal} />)}
      </div>
    </>
  );
}

/** The small form's one line: the latest step and where it stands. It opens no words. */
export function SessionLatestStep({ conversation, job }: { conversation: string; job: string }) {
  const read = useDataQuery<{ steps: Pick<TraceStep, 'seq' | 'tool' | 'cardState'>[] }>(
    'query BrickSessionStep($c:String!,$j:String!){steps:sessionTrace(conversation:$c,job:$j,limit:1){seq tool cardState}}',
    { c: conversation, j: job }, { keep: true });
  const step = read.data?.steps.at(-1);
  return step ? <p className="board-line text-muted-foreground" data-session-step="">Latest step: {step.tool} · {step.cardState}</p> : null;
}
