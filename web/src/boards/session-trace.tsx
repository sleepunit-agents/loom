/** The live work trace of a handed-off session (docs/specs/boards.md, "Sessions"), drawn as a conversation the member
 * was not in: the brief it was given as the asker's message, the agent's own words as its messages, its runs of tool
 * calls folded between them, its reasoning quiet and folded, and its report (or why it failed) last. The steps are read
 * as the member looking and redrawn as each arrives. Loom keeps a trace only for work handed off from the member's own
 * thread; any other session, and anybody else, reads none, and its big form is the brief and how it ended. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDataQuery } from '../data/graphql';
import { Reply } from '../pair/reply';
import { Bubble, BubbleContent } from '../pair/ui/bubble';
import { Message, MessageContent, MessageHeader } from '../pair/ui/message';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from '../pair/ui/trace';
import { workTree, type EventMessage, type WorkNode } from '../pair/work-tree';
import { Action, Actions, count, Loading, Note } from './brick-kit';

/** What a step is (src/core/conversations/job-trace.ts): a tool call or result, the agent's own words, or its readable
 * reasoning. A step read without it, as from a fixture written before schema 55, is a tool step. */
export type TraceKind = 'tool' | 'words' | 'reasoning';
export type TraceStep = { seq: number; job: string; at: string; tool: string; cardState: 'running' | 'done' | 'failed'; clientId: string; words: string | null; kind?: TraceKind };
const kindOf = (s: Pick<TraceStep, 'kind'>): TraceKind => s.kind ?? 'tool';
/** The most steps one read carries; the server allows no more than 200. */
export const TRACE_STEPS = 100;

/** A step as the conversation's own work-trace cards read one, so both draw the same way: a call and its
 * result are one card, and a subagent's steps sit inside its card (pair/work-tree.ts). */
export const traceEvents = (steps: TraceStep[]): EventMessage[] =>
  steps.filter((s) => kindOf(s) === 'tool').map((s) => ({ thread: '', sender: '', kind: 'card', seq: s.seq, at: s.at, run: s.job, tool: s.tool, cardState: s.cardState, clientId: s.clientId, words: s.words }));

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

/** What the conversation holds besides its steps, all read by the brick itself (bricks-session.tsx). */
export type SessionTalk = {
  /** Who did the work, as the chat names a sender. */ agent: string;
  /** The brief it was given, the job's own `brief`, and when it was taken up. */ brief: string | null; briefAt: string | null;
  /** Its report once there is one (sessionReport), and when the job ended. */ report: string | null; endedAt: string | null;
  /** Why it failed, in loom's plain words, where it failed. */ failure: string | null;
};
const said = (at: string | null) => (at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const sender = (agent: string) => (agent === 'art' ? 'Art' : agent || 'Agent');

/** One message of the conversation, composed as the chat composes one (pair/transcript.tsx): the asker's on the end
 * side in a filled bubble, the agent's on the start side in a bare one, its words through the chat's own renderer
 * (pair/reply.tsx: markdown with no raw HTML, so markup in an agent's words is shown as text). */
function Said({ mine, head, words, tone, at, ...rest }: { mine?: boolean; head: string; words: string; tone?: 'destructive'; at?: string | null } & Record<`data-${string}`, string>) {
  const time = said(at ?? null);
  return (
    <Message align={mine ? 'end' : 'start'} {...rest}>
      <MessageContent>
        <MessageHeader>{time ? `${head} · ${time}` : head}</MessageHeader>
        <Bubble variant={tone ?? (mine ? 'secondary' : 'ghost')} align={mine ? 'end' : 'start'}>
          <BubbleContent className="whitespace-pre-wrap break-words"><Reply words={words} /></BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

/** A run of tool calls between two of the agent's messages, folded the way the chat folds work: one quiet line that
 * says how many steps and opens in place to them. The latest run of a working session is open, so watching it work
 * needs no press, and so is a failed session's, which holds what led to the failure; any other is folded until the
 * member opens it. */
function ToolRun({ nodes, live, open, latestTerminal }: { nodes: WorkNode[]; live: boolean; open: boolean; latestTerminal?: number }) {
  const [chosen, choose] = useState<boolean | null>(null);
  const events = nodes.map((n) => n.events[n.events.length - 1]);
  const failed = events.filter((e) => e.cardState === 'failed').length, working = events.some((e) => e.cardState === 'running');
  return (
    <Trace data-session-run="">
      <TraceCollapsible open={chosen ?? open} onOpenChange={choose}>
        <TraceCollapsibleTrigger>
          <TraceLine status={working && live ? 'running' : undefined}>
            <TraceTitle data-session-run-count="">{count(nodes.length, 'step')}</TraceTitle>
            {(failed > 0 || (working && live)) && <TraceDescription>{[working && live ? 'working' : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ')}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <ol className="board-steps">{nodes.map((node) => <Step key={node.events[0].seq} node={node} latestTerminal={latestTerminal} />)}</ol>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/** The agent's reasoning, where its harness gave it readably: quiet, and folded until opened. */
function Reasoning({ words }: { words: string | null }) {
  return (
    <Trace data-session-reasoning="">
      <TraceCollapsible>
        <TraceCollapsibleTrigger><TraceLine><TraceTitle data-session-reasoning-title="">Reasoning</TraceTitle></TraceLine></TraceCollapsibleTrigger>
        <TraceCollapsibleContent><div className="text-muted-foreground">{words ? <Reply words={words} /> : 'Its words are no longer kept.'}</div></TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

type Piece = { kind: 'tools'; nodes: WorkNode[] } | { kind: 'words' | 'reasoning'; step: TraceStep };
/** The steps in the order they were reported, a run of tool calls between two of the agent's own steps made one piece.
 * A call and its result are one step wherever they fall (pair/work-tree.ts), placed where the call was. */
export function sessionPieces(steps: TraceStep[]): Piece[] {
  const nodes = workTree(traceEvents(steps)), at = new Map(nodes.map((n) => [n.events[0].seq, n]));
  const pieces: Piece[] = [];
  for (const s of steps) {
    const kind = kindOf(s);
    if (kind !== 'tool') { pieces.push({ kind, step: s }); continue; }
    const node = at.get(s.seq);
    if (!node) continue;
    const last = pieces.at(-1);
    if (last?.kind === 'tools') last.nodes.push(node); else pieces.push({ kind: 'tools', nodes: [node] });
  }
  return pieces;
}

const traceFields = '{seq job at tool cardState clientId words kind}';
/** The big form: the session as a conversation, newest at the bottom, kept in view while the member has not scrolled
 * away from it. It says how many steps there are in all, and where the page holds fewer than that, a control loads the
 * ones before. With `trace` false (a session that keeps none) it reads no steps and is the brief and how it ended. */
export function SessionTrace({ conversation, job, running, failed = false, trace = true, talk }: { conversation: string; job: string; running: boolean; failed?: boolean; trace?: boolean; talk: SessionTalk }) {
  const read = useDataQuery<{ steps: TraceStep[]; total: number; gone: boolean }>(
    'query BrickSessionTrace($c:String!,$j:String!,$n:Int!){steps:sessionTrace(conversation:$c,job:$j,limit:$n)' + traceFields + ' total:sessionTraceCount(conversation:$c,job:$j) gone:sessionTraceExpired(conversation:$c,job:$j)}',
    // Watching a session work is what this list is for: while its job runs it keeps up with every step, as the
    // conversation does. Once the job has ended it is read like the rest of the brick, every few seconds.
    { c: conversation, j: job, n: TRACE_STEPS }, { keep: true, pace: running ? 'eager' : undefined, pause: !trace });
  // Earlier steps are read a page at a time, each before the oldest the page has. A stored step never changes, so
  // what has been read is kept, and the latest page is laid over it as it moves on.
  const [before, setBefore] = useState<number | null>(null);
  const earlier = useDataQuery<{ steps: TraceStep[] }>(
    'query BrickSessionEarlier($c:String!,$j:String!,$n:Int!,$b:Int!){steps:sessionTrace(conversation:$c,job:$j,limit:$n,before:$b)' + traceFields + '}',
    { c: conversation, j: job, n: TRACE_STEPS, b: before ?? 0 }, { pause: before === null || !trace });
  const kept = useRef(new Map<number, TraceStep>());
  for (const s of earlier.data?.steps ?? []) kept.current.set(s.seq, s);
  for (const s of read.data?.steps ?? []) kept.current.set(s.seq, s);
  const latest = trace ? read.data?.steps ?? [] : [];
  const steps = latest.length ? [...kept.current.values()].sort((a, b) => a.seq - b.seq) : [];
  const last = steps.at(-1)?.seq ?? 0, total = Math.max(read.data?.total ?? 0, steps.length);
  const box = useRef<HTMLDivElement>(null), follow = useRef(true);
  useEffect(() => { const el = box.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [last]);
  if (trace && read.status === 'loading') return <Loading />;
  const pieces = sessionPieces(steps);
  // The report is the agent's last words: drawn as the last message, not twice.
  const end = pieces.at(-1);
  if (talk.report && end?.kind === 'words' && end.step.words?.trim() === talk.report.trim()) pieces.pop();
  const latestTerminal = steps.findLast((s) => kindOf(s) === 'tool' && s.tool.endsWith('Terminal') && s.cardState !== 'running')?.seq;
  const oldest = steps[0]?.seq ?? 0, loading = before !== null && earlier.status === 'loading';
  const who = sender(talk.agent);
  // What stands where the steps would: they are unavailable, no longer kept, or there are none yet.
  const none = !trace ? null : read.status !== 'live' ? <Note>Its steps are unavailable.</Note>
    // A step is deleted when it is past its keep time. Loom says so of a job that has none and is older than that time.
    : !steps.length && read.data?.gone ? <p className="board-note" data-session-trace-gone="">Its steps are no longer kept. Loom keeps a step for a limited time and then deletes it.</p>
      : !steps.length ? <Note>{running ? 'No steps reported yet.' : 'No steps were recorded.'}</Note> : null;
  return (
    <>
      {/* How many there are, and beside it the way to the ones before: one quiet line. */}
      {steps.length > 0 && (
        <Actions>
          <Note data-session-trace-count="">{count(total, 'step') + ' in all' + (steps.length < total ? `, the latest ${steps.length} shown.` : '.')}</Note>
          {steps.length < total && <Action kind="quiet" disabled={loading} onClick={() => setBefore(oldest)}>{loading ? 'Loading earlier steps…' : 'Load earlier steps'}</Action>}
        </Actions>
      )}
      {before !== null && earlier.status !== 'loading' && earlier.status !== 'live' && <Note>The earlier steps are unavailable.</Note>}
      <div ref={box} className="board-session-talk" role="log" aria-label="Session" data-session-trace="" data-scroll=""
        onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {talk.brief && <Said mine head="Asked" words={talk.brief} at={talk.briefAt} data-session-brief="" />}
        {none}
        {pieces.map((piece, i) => piece.kind === 'tools'
          ? <ToolRun key={piece.nodes[0].events[0].seq} nodes={piece.nodes} live={running && i === pieces.length - 1} open={(running || failed) && i === pieces.length - 1} latestTerminal={latestTerminal} />
          : piece.kind === 'reasoning' ? <Reasoning key={piece.step.seq} words={piece.step.words} />
            : <Said key={piece.step.seq} head={who} words={piece.step.words ?? 'Its words are no longer kept.'} at={piece.step.at} data-session-words="" />)}
        {talk.report && <Said head={`${who} · Report`} words={talk.report} at={talk.endedAt} data-session-report="" />}
        {talk.failure && <Said head="Why it failed" words={talk.failure} tone="destructive" at={talk.endedAt} data-session-failure="" />}
      </div>
    </>
  );
}

/** The small form's one line: the latest tool step and where it stands, as it was before steps had kinds. It opens no words. */
export function SessionLatestStep({ conversation, job }: { conversation: string; job: string }) {
  const read = useDataQuery<{ steps: Pick<TraceStep, 'seq' | 'tool' | 'cardState'>[] }>(
    'query BrickSessionStep($c:String!,$j:String!){steps:sessionTrace(conversation:$c,job:$j,kind:"tool",limit:1){seq tool cardState}}',
    { c: conversation, j: job }, { keep: true });
  const step = read.data?.steps.at(-1);
  return step ? <p className="board-note" data-session-step="">Latest step: {step.tool} · {step.cardState}</p> : null;
}
