/** The live work trace of a handed-off session (docs/specs/boards.md, "Sessions"): the steps its job's body
 * reported, oldest first, read as the member looking and redrawn as each step arrives. Loom keeps a trace only
 * for work handed off from the member's own thread; any other session, and anybody else, reads none. */
import { useEffect, useRef, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { Reply } from '../pair/reply';
import { workTree, type EventMessage, type WorkNode } from '../pair/work-tree';
import { Loading, Note } from './brick-kit';

export type TraceStep = { seq: number; job: string; at: string; tool: string; cardState: 'running' | 'done' | 'failed'; clientId: string; words: string | null };
/** The most steps one read carries; the server allows no more than 200. */
export const TRACE_STEPS = 100;

/** A step as the conversation's own work-trace cards read one, so both draw the same way: a call and its
 * result are one card, and a subagent's steps sit inside its card (pair/work-tree.ts). */
export const traceEvents = (steps: TraceStep[]): EventMessage[] =>
  steps.map((s) => ({ thread: '', sender: '', kind: 'card', seq: s.seq, at: s.at, run: s.job, tool: s.tool, cardState: s.cardState, clientId: s.clientId, words: s.words }));

/** One step of the log: a mark for where it stands, what was run or which tool, and, opened, what it said. It reads a
 * step as the conversation's work-trace cards do (pair/work-trace.tsx: a call and its result are one step, a
 * terminal's first words are its command, a subagent's steps sit inside it) and draws it as a line, not a card. */
function Step({ node, latestTerminal }: { node: WorkNode; latestTerminal?: number }) {
  const [chosen, choose] = useState<boolean | null>(null);
  const first = node.events[0], last = node.events[node.events.length - 1];
  const label = (last.tool || 'Work step').split(' → ').at(-1)!;
  const terminal = label === 'Terminal', agent = label.startsWith('Subagent');
  const command = terminal && first.cardState === 'running' ? first.words : undefined;
  const output = node.events.map((e) => (e.words !== label && !(e === first && command && node.events.length > 1) ? e.words : null)).filter((v): v is string => !!v).join('\n');
  const state = last.cardState || 'recorded';
  const more = !!output && output !== command || node.children.length > 0;
  const open = more && (chosen ?? (terminal && node.events.some((e) => e.seq === latestTerminal)));
  const line = <><i aria-hidden="true" /><span data-slot="trace-title" data-command={command ? '' : undefined}>{command || label}</span><span data-slot="trace-description">{state}</span></>;
  return (
    <li className="board-step" data-slot="trace" data-state={state} data-open={open}>
      {more ? <button type="button" className="board-step-line" aria-expanded={open} onClick={() => choose(!open)}>{line}</button> : <div className="board-step-line">{line}</div>}
      {open && (
        <div className="board-step-more">
          {node.children.length > 0 && <ol className="board-steps">{node.children.map((child) => <Step key={child.events[0].seq} node={child} latestTerminal={latestTerminal} />)}</ol>}
          {output && output !== command && (agent ? <Reply words={output} /> : <pre className="board-tail" data-failed={state === 'failed' || undefined}>{output}</pre>)}
        </div>
      )}
    </li>
  );
}

/** The big form's trace: newest at the bottom, kept in view while the member has not scrolled away from it. */
export function SessionTrace({ conversation, job, running }: { conversation: string; job: string; running: boolean }) {
  const read = useDataQuery<{ steps: TraceStep[]; gone: boolean }>(
    'query BrickSessionTrace($c:String!,$j:String!,$n:Int!){steps:sessionTrace(conversation:$c,job:$j,limit:$n){seq job at tool cardState clientId words} gone:sessionTraceExpired(conversation:$c,job:$j)}',
    { c: conversation, j: job, n: TRACE_STEPS }, { keep: true });
  const steps = read.data?.steps ?? [], last = steps.at(-1)?.seq ?? 0;
  const box = useRef<HTMLOListElement>(null), follow = useRef(true);
  useEffect(() => { const el = box.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [last]);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live') return <Note>Its steps are unavailable.</Note>;
  // A step is deleted when it is past its keep time. Loom says so of a job that has none and is older than that time.
  if (!steps.length && read.data?.gone) return <p className="board-note" data-session-trace-gone="">Its steps are no longer kept. Loom keeps a step for a limited time and then deletes it.</p>;
  if (!steps.length) return <Note>{running ? 'No steps reported yet.' : 'No steps were recorded.'}</Note>;
  const latestTerminal = steps.findLast((s) => s.tool.endsWith('Terminal') && s.cardState !== 'running')?.seq;
  return (
    <>
      {steps.length === TRACE_STEPS && <Note>The latest {TRACE_STEPS} steps.</Note>}
      <ol ref={box} className="board-steps" role="log" aria-label="Steps" data-session-trace="" data-scroll=""
        onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {workTree(traceEvents(steps)).map((node) => <Step key={node.events[0].seq} node={node} latestTerminal={latestTerminal} />)}
      </ol>
    </>
  );
}

/** The small form's one line: the latest step and where it stands. It opens no words. */
export function SessionLatestStep({ conversation, job }: { conversation: string; job: string }) {
  const read = useDataQuery<{ steps: Pick<TraceStep, 'seq' | 'tool' | 'cardState'>[] }>(
    'query BrickSessionStep($c:String!,$j:String!){steps:sessionTrace(conversation:$c,job:$j,limit:1){seq tool cardState}}',
    { c: conversation, j: job }, { keep: true });
  const step = read.data?.steps.at(-1);
  return step ? <p className="board-note" data-session-step="">Latest step: {step.tool} · {step.cardState}</p> : null;
}
