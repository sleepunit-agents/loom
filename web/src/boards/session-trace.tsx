/** The live work trace of a handed-off session (docs/specs/boards.md, "Sessions"): the steps its job's body
 * reported, oldest first, read as the member looking and redrawn as each step arrives. Loom keeps a trace only
 * for work handed off from the member's own thread; any other session, and anybody else, reads none. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDataQuery } from '../data/graphql';
import { Reply } from '../pair/reply';
import { workTree, type EventMessage, type WorkNode } from '../pair/work-tree';
import { Action, Actions, count, Loading, Note } from './brick-kit';

export type TraceStep = { seq: number; job: string; at: string; tool: string; cardState: 'running' | 'done' | 'failed'; clientId: string; words: string | null };
/** The most steps one read carries; the server allows no more than 200. */
export const TRACE_STEPS = 100;

/** A step as the conversation's own work-trace cards read one, so both draw the same way: a call and its
 * result are one card, and a subagent's steps sit inside its card (pair/work-tree.ts). */
export const traceEvents = (steps: TraceStep[]): EventMessage[] =>
  steps.map((s) => ({ thread: '', sender: '', kind: 'card', seq: s.seq, at: s.at, run: s.job, tool: s.tool, cardState: s.cardState, clientId: s.clientId, words: s.words }));

/** A step's output with each https address in it as a link that opens in a new tab. Only https: nothing else in
 * the output becomes a link, and what ends a sentence (a full stop, a closing bracket) is left outside it. */
export function linked(output: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const found of output.matchAll(/https:\/\/[^\s<>"'`]+/g)) {
    const href = found[0].replace(/[.,;:!?)\]}]+$/, ''), at = found.index;
    let ok = false;
    try { ok = new URL(href).protocol === 'https:'; } catch { ok = false; }
    if (!ok) continue;
    if (at > from) parts.push(output.slice(from, at));
    parts.push(<a key={at} href={href} target="_blank" rel="noopener noreferrer">{href}</a>);
    from = at + href.length;
  }
  if (from < output.length) parts.push(output.slice(from));
  return parts;
}

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
  // The line holds the command's first line; the rest of a longer one is opened with its output.
  const head = command?.split('\n')[0], whole = command && command !== head ? command : undefined;
  const more = !!output && output !== command || node.children.length > 0 || !!whole;
  const open = more && (chosen ?? (terminal && node.events.some((e) => e.seq === latestTerminal)));
  const line = <><i aria-hidden="true" /><span data-slot="trace-title" data-command={command ? '' : undefined}>{head || label}</span><span data-slot="trace-description">{state}</span></>;
  return (
    <li className="board-step" data-slot="trace" data-state={state} data-open={open}>
      {more ? <button type="button" className="board-step-line" aria-expanded={open} onClick={() => choose(!open)}>{line}</button> : <div className="board-step-line">{line}</div>}
      {open && (
        <div className="board-step-more">
          {whole && <pre className="board-tail" data-slot="trace-command">{whole}</pre>}
          {node.children.length > 0 && <ol className="board-steps">{node.children.map((child) => <Step key={child.events[0].seq} node={child} latestTerminal={latestTerminal} />)}</ol>}
          {output && output !== command && (agent ? <Reply words={output} /> : <pre className="board-tail" data-slot="trace-output" data-failed={state === 'failed' || undefined}>{linked(output)}</pre>)}
        </div>
      )}
    </li>
  );
}

/** The big form's trace: newest at the bottom, kept in view while the member has not scrolled away from it. It says
 * how many steps there are in all, and where the page holds fewer than that, a control loads the ones before. */
export function SessionTrace({ conversation, job, running }: { conversation: string; job: string; running: boolean }) {
  const read = useDataQuery<{ steps: TraceStep[]; total: number; gone: boolean }>(
    'query BrickSessionTrace($c:String!,$j:String!,$n:Int!){steps:sessionTrace(conversation:$c,job:$j,limit:$n){seq job at tool cardState clientId words} total:sessionTraceCount(conversation:$c,job:$j) gone:sessionTraceExpired(conversation:$c,job:$j)}',
    // Watching a session work is what this list is for: while its job runs it keeps up with every step, as the
    // conversation does. Once the job has ended it is read like the rest of the brick, every few seconds.
    { c: conversation, j: job, n: TRACE_STEPS }, { keep: true, pace: running ? 'eager' : undefined });
  // Earlier steps are read a page at a time, each before the oldest the page has. A stored step never changes, so
  // what has been read is kept, and the latest page is laid over it as it moves on.
  const [before, setBefore] = useState<number | null>(null);
  const earlier = useDataQuery<{ steps: TraceStep[] }>(
    'query BrickSessionEarlier($c:String!,$j:String!,$n:Int!,$b:Int!){steps:sessionTrace(conversation:$c,job:$j,limit:$n,before:$b){seq job at tool cardState clientId words}}',
    { c: conversation, j: job, n: TRACE_STEPS, b: before ?? 0 }, { pause: before === null });
  const kept = useRef(new Map<number, TraceStep>());
  for (const s of earlier.data?.steps ?? []) kept.current.set(s.seq, s);
  for (const s of read.data?.steps ?? []) kept.current.set(s.seq, s);
  const latest = read.data?.steps ?? [];
  const steps = latest.length ? [...kept.current.values()].sort((a, b) => a.seq - b.seq) : [];
  const last = steps.at(-1)?.seq ?? 0, total = Math.max(read.data?.total ?? 0, steps.length);
  const box = useRef<HTMLOListElement>(null), follow = useRef(true);
  useEffect(() => { const el = box.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [last]);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live') return <Note>Its steps are unavailable.</Note>;
  // A step is deleted when it is past its keep time. Loom says so of a job that has none and is older than that time.
  if (!steps.length && read.data?.gone) return <p className="board-note" data-session-trace-gone="">Its steps are no longer kept. Loom keeps a step for a limited time and then deletes it.</p>;
  if (!steps.length) return <Note>{running ? 'No steps reported yet.' : 'No steps were recorded.'}</Note>;
  const latestTerminal = steps.findLast((s) => s.tool.endsWith('Terminal') && s.cardState !== 'running')?.seq;
  const oldest = steps[0].seq, loading = before !== null && earlier.status === 'loading';
  return (
    <>
      {/* How many there are, and beside it the way to the ones before: one quiet line. */}
      <Actions>
        <Note data-session-trace-count="">{count(total, 'step') + ' in all' + (steps.length < total ? `, the latest ${steps.length} shown.` : '.')}</Note>
        {steps.length < total && <Action kind="quiet" disabled={loading} onClick={() => setBefore(oldest)}>{loading ? 'Loading earlier steps…' : 'Load earlier steps'}</Action>}
      </Actions>
      {before !== null && earlier.status !== 'loading' && earlier.status !== 'live' && <Note>The earlier steps are unavailable.</Note>}
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
