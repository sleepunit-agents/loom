/** More than one conversation on the boards page: the one quiet control beside the presence and the panel it opens,
 * which holds the list of the member's threads, Comms' search of them, and whatever else the page puts there (the
 * open thread's rename, pin, archive and delete, this device's notifications), so the conversation's header is one line. Which thread is shown is the address and nothing else; whether
 * the list is open is this page's own and is kept nowhere. The reads, the order and the calls are Comms' own. */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useDataOnce, useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { newId } from '../data/id';
import { threadFields } from '../pieces/comms/thread-fields';
import { threadRows, type CommsThread } from '../pieces/comms-view/model';
import { SHORTCUTS, keysOf, onMac, shortcutEngine } from '../shell/shortcuts';
import { threadPath, useAgentNames, useThreads, type ThreadsReading } from './agents-data';
import { bridgeReceiptQuery, type BridgeReceiptData } from '../pieces/comms/conversation-query';
import { Action, Asking, Time } from './brick-kit';

/** Comms' own search of the member's threads in one folder (`commsThreads(search:)`, as the desktop's Comms asks
 * it), with `unread`. It is asked once each time a search is submitted, by one request (`useDataOnce`), never as a
 * live selection: a search answer does not follow later changes, and asking again is submitting again. Its rows are
 * in Comms' order. What was typed is held by the drawn control alone: never a parameter, a detail or a board's. */
export const threadSearchQuery = `query BoardsThreadSearch($archived:Boolean!,$search:String!){homeComms{member} commsThreads(archived:$archived,search:$search,offset:0,limit:51){${threadFields} unread}}`;
export function useThreadSearch(search: string, archived = false): ThreadsReading {
  const read = useDataOnce<{ homeComms: { member: string } | null; commsThreads: CommsThread[] }>(threadSearchQuery, { archived, search }, { pause: !search });
  if (!search || read.status === 'loading') return { status: 'loading', agents: [], rows: [], more: false };
  const home = read.data?.homeComms, threads = read.data?.commsThreads;
  if (read.status !== 'live' || !home || !Array.isArray(threads)) return { status: 'unavailable', agents: [], rows: [], more: false };
  return { status: 'live', agents: [], more: threads.length > 50, rows: threadRows({ status: 'live', member: home.member, threads: threads.slice(0, 50), agents: [] }, archived, '') };
}
/** What is sent for a search: the words typed, trimmed and with their spaces made single, at most 200 characters. */
export const searchWords = (typed: string) => typed.trim().split(/\s+/).filter(Boolean).join(' ').slice(0, 200);
/** The search box: asked on submit (Enter or Search), never on a keystroke. Emptying it goes back to the list. */
export function ThreadSearch({ asked, ask }: { asked: string; ask(words: string): void }) {
  const [typed, setTyped] = useState(asked);
  const submit = (e: FormEvent) => { e.preventDefault(); ask(searchWords(typed)); };
  return (
    <form className="board-search" role="search" onSubmit={submit}>
      <input className="board-input" type="search" aria-label="Search conversations" placeholder="Search conversations…" maxLength={200} value={typed}
        onChange={(e) => { setTyped(e.target.value); if (!e.target.value.trim()) ask(''); }} />
      <Action submit disabled={!searchWords(typed)}>Search</Action>
      {asked && <Action kind="quiet" onClick={() => { setTyped(''); ask(''); }}>Show the list</Action>}
    </form>
  );
}
/** Comms' words for what a search found nothing for, and for a search that could not be asked. */
export const searchNone = 'No conversations match.', searchFailed = 'Search is unavailable. Try again.';

/** Pin or unpin one thread, or delete it, as Comms' More menu does (`comms.change`). `done` hears which, once it is saved. */
export type ThreadAct = 'pin' | 'unpin' | 'delete';
export const changeFor = (act: ThreadAct) => (act === 'delete' ? { change: 'delete' as const } : { change: 'pin' as const, pinned: act === 'pin' });
/** The question before a delete, naming the conversation by its title. Nothing is sent until it is answered yes. */
export const deleteQuestion = (title: string) => `Delete “${title}” and its private words? It cannot be undone.`;

/** The desktop's launcher keys (shell/shortcuts.ts: its chord, its older chords, a double tap of Shift), read by
 * its own engine. Here they open and close the list of conversations. */
function useLauncherKeys(toggle: () => void) {
  const latest = useRef(toggle); latest.current = toggle;
  useEffect(() => {
    const engine = shortcutEngine({ toggleLauncher: () => latest.current(), apps: () => ({ order: [] }), show() {}, land() {} });
    const listen: [string, (e: never) => void, boolean][] = [['keydown', engine.keydown, true], ['keyup', engine.keyup, true], ['pointerdown', engine.pointerdown, true], ['blur', engine.away, false]];
    for (const [name, fn, capture] of listen) addEventListener(name, fn as EventListener, capture);
    return () => { for (const [name, fn, capture] of listen) removeEventListener(name, fn as EventListener, capture); };
  }, []);
}

/** The one control beside the presence, and the panel it opens: the list of conversations, then `children` (what
 * else the page keeps out of its header). */
export function ThreadSwitch({ thread, visit, children }: { thread: string; visit(path: string): void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  useLauncherKeys(() => setOpen((now) => !now));
  return (
    <>
      <button type="button" className="boards-threads-open" aria-haspopup="dialog" aria-expanded={open} aria-label="Conversations"
        title={'Conversations · ' + keysOf(SHORTCUTS[0], onMac())} onClick={() => setOpen((now) => !now)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="13" cy="8" r="1.1" /></svg>
      </button>
      {open && <ThreadList thread={thread} visit={visit} close={() => setOpen(false)}>{children}</ThreadList>}
    </>
  );
}

function ThreadList({ thread, visit, close, children }: { thread: string; visit(path: string): void; close(): void; children?: ReactNode }) {
  const threads = useThreads(), name = useAgentNames();
  // A submitted search shows what Comms found in place of the list, and no new conversations; emptying it goes back.
  const [asked, setAsked] = useState(''), found = useThreadSearch(asked);
  const list = asked ? found : threads;
  const [at, setAt] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null), fresh = useRef<Record<string, string>>({});
  useEffect(() => { box.current?.focus?.(); }, []);
  const go = (id: string) => { visit(threadPath(id)); close(); };
  /** A new thread with this agent, as Comms' "New" makes one. A retry asks for the same thread again. */
  const start = async (agent: string) => {
    if (busy) return;
    const id = (fresh.current[agent] ??= 'th:' + newId());
    setBusy(true); setError('');
    try { await memberOperation('comms.open', { agent, thread: id }); delete fresh.current[agent]; go(id); }
    catch { setError('Could not start the conversation. Try again.'); setBusy(false); }
  };
  const count = list.rows.length + list.agents.length;
  const ask = (words: string) => { setAsked(words); setAt(0); };
  const choose = (n: number) => { const row = list.rows[n]; if (row) go(row.id); else if (list.agents[n - list.rows.length]) void start(list.agents[n - list.rows.length]); };
  const keys = (e: KeyboardEvent) => {
    // Typing in the panel (a new title) and its own controls keep their keys; Escape closes from anywhere in it.
    const typing = e.target !== e.currentTarget && (e.target as { closest?(selector: string): unknown } | null)?.closest?.('input, textarea, button, a, label');
    if (e.key === 'Escape') close();
    else if (typing) return;
    else if (e.key === 'ArrowDown' && count) setAt((n) => (n + 1) % count);
    else if (e.key === 'ArrowUp' && count) setAt((n) => (n - 1 + count) % count);
    else if (e.key === 'Enter' && count) choose(Math.min(at, count - 1));
    else return;
    e.preventDefault();
  };
  const follow = (e: MouseEvent, id: string) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); go(id); };
  return (
    <div ref={box} className="boards-threads" role="dialog" aria-label="Conversations" tabIndex={-1} onKeyDown={keys}>
      {threads.status === 'live' && <ThreadSearch asked={asked} ask={ask} />}
      {list.status === 'loading' && <p role="status" className="board-note">Loading…</p>}
      {list.status === 'unavailable' && <p className="board-note">{asked ? searchFailed : 'Conversations are unavailable.'}</p>}
      {asked && list.status === 'live' && !list.rows.length && <p className="board-note">{searchNone}</p>}
      {list.status === 'live' && (
        <ul>
          {list.rows.map((t, n) => (
            <li key={t.id}>
              <a href={threadPath(t.id)} data-active={n === at} aria-current={t.id === thread ? 'page' : undefined} onClick={(e) => follow(e, t.id)} onPointerEnter={() => setAt(n)}>
                <ThreadLine thread={t} name={name} />
              </a>
            </li>
          ))}
          {list.more && <li className="board-note">{asked ? 'More match than these; the rest are in Comms.' : 'Older conversations are in Comms.'}</li>}
          {list.agents.map((agent, n) => (
            <li key={'new:' + agent}>
              <button type="button" data-active={list.rows.length + n === at} disabled={busy} onClick={() => void start(agent)} onPointerEnter={() => setAt(list.rows.length + n)}>New conversation with {name(agent)}</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="board-problem">{error}</p>}
      {children}
    </div>
  );
}

/** One thread as a line: its title, its agent, and whether the agent is working or has replied unread. */
export function ThreadLine({ thread, name }: { thread: CommsThread; name(id: string): string }) {
  return (
    <>
      <span>{thread.title}</span>
      <small> {name(thread.agent)}</small>
      {thread.working && <span className="board-state" data-running="true">Working</span>}
      {thread.unread && <span className="board-state" data-unread="true">Unread</span>}
    </>
  );
}

export const threadHeadQuery = `query BoardsThreadHead($id:String!){thread:commsThread(id:$id){${threadFields}}}`;
type Change = { change: 'rename'; title: string } | { change: 'archive'; archived: boolean } | { change: 'pin'; pinned: boolean } | { change: 'delete' };
/** The open thread's title, and for the member whose thread it is, Comms' rename, pin, archive and delete
 * (`comms.change`); archive and delete are asked first. A deleted thread is left for the page's own address
 * (`visit('/app/boards')`), as Comms goes back to its list. */
export function ThreadHead({ thread, member, visit }: { thread: string; member: string; visit?(path: string): void }) {
  const read = useDataQuery<{ thread: CommsThread | null }>(threadHeadQuery, { id: thread }, { keep: true });
  const [mode, setMode] = useState<'rename' | 'archive' | 'delete' | null>(null), [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const t = read.status === 'live' && read.data?.thread?.id === thread ? read.data.thread : null;
  if (!t) return null;
  const run = async (change: Change) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await memberOperation('comms.change', { thread, ...change }); setMode(null); if (change.change === 'delete') visit?.('/app/boards'); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const named = title.trim(), fits = !!named && [...named].length <= 60;
  const rename = (e: FormEvent) => { e.preventDefault(); if (fits) void run({ change: 'rename', title: named }); };
  return (
    <div className="boards-thread">
      <div className="board-line">
        <strong className="boards-thread-title">{t.title}</strong>
        {t.archivedAt && <span className="board-state" data-tone="muted">Archived</span>}
        {t.member === member && !mode && (
          <>
            <button type="button" className="board-action" data-kind="quiet" disabled={busy} onClick={() => { setTitle(t.title); setMode('rename'); }}>Rename</button>
            <button type="button" className="board-action" data-kind="quiet" disabled={busy} onClick={() => void run(changeFor(t.pinned ? 'unpin' : 'pin'))}>{t.pinned ? 'Unpin' : 'Pin'}</button>
            {t.archivedAt
              ? <button type="button" className="board-action" data-kind="quiet" disabled={busy} onClick={() => void run({ change: 'archive', archived: false })}>Restore</button>
              : <button type="button" className="board-action" data-kind="quiet" disabled={busy} onClick={() => setMode('archive')}>Archive…</button>}
            <button type="button" className="board-action" data-kind="quiet" disabled={busy} onClick={() => setMode('delete')}>Delete…</button>
          </>
        )}
      </div>
      {mode === 'rename' && (
        <form className="board-line" aria-label="Rename conversation" onSubmit={rename}>
          <input className="board-input" aria-label="Conversation title" value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} />
          <button type="submit" className="board-action" data-kind="primary" disabled={busy || !fits}>Save title</button>
          <button type="button" className="board-action" data-kind="quiet" disabled={busy} onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === 'archive' && (
        <Asking label="Archive conversation" kind="plain" yes="Archive conversation" no="Keep it" disabled={busy} onYes={() => void run({ change: 'archive', archived: true })} onNo={() => setMode(null)}>Archive this conversation? It leaves the list of conversations.</Asking>
      )}
      {mode === 'delete' && (
        <Asking label="Delete conversation" yes="Delete conversation" no="Keep it" disabled={busy} onYes={() => void run({ change: 'delete' })} onNo={() => setMode(null)}>{deleteQuestion(t.title)}</Asking>
      )}
      {error && <p role="alert" className="board-problem">Could not save. Try again.</p>}
    </div>
  );
}

/** The boards chat's Stop for the whole conversation: Comms' own thread stop (`comms.change {stop}`, as the desktop's
 * Comms header sends it), not one job's (`runtime.jobStop`, which the session and agent bricks send). Loom marks the
 * thread; the job working in it notices, stops its work, and ends as stopped by this member; a job that finishes
 * first keeps its work and the mark is dropped. It is drawn only while the agent is working in this conversation,
 * for the member whose conversation it is, and never in a terminal's; it asks first, naming the conversation, and
 * sends nothing on Keep it. It reads nothing of its own: the open thread's selection (`threadHeadQuery`) is the
 * header's and the panel's, which says whether the agent is working and whether a Stop is already asked. */
export function ThreadStop({ thread, member, name }: { thread: string; member: string; /** The agent's name, as the presence says it. */ name: string }) {
  const read = useDataQuery<{ thread: CommsThread | null }>(threadHeadQuery, { id: thread }, { keep: true });
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const t = read.status === 'live' && read.data?.thread?.id === thread ? read.data.thread : null;
  if (!t || t.member !== member || t.venue === 'terminal' || !t.working) return null;
  if (t.stopRequested) return <div className="boards-stop"><Action disabled>Stopping…</Action></div>;
  const stop = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await memberOperation('comms.change', { thread, change: 'stop' }); setAsking(false); }
    catch (e) { const status = (e as { status?: unknown } | null)?.status; setError(status === 401 || status === 403 ? 'You can’t stop this conversation.' : 'That did not stop it. Try again.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="boards-stop">
      {asking
        ? <Asking label={`Stop conversation ${t.title}`} yes="Stop the conversation" no="Keep it going" busy={busy} onYes={() => void stop()} onNo={() => { setAsking(false); setError(''); }}>{stopQuestion(t.title, name)}</Asking>
        : <Action label={`Stop ${name} in ${t.title}…`} onClick={() => { setError(''); setAsking(true); }}>Stop…</Action>}
      {error && <p role="alert" className="board-problem">{error}</p>}
    </div>
  );
}
/** The question before a thread stop, naming the conversation and its agent. */
export const stopQuestion = (title: string, name: string) => `Stop ${name} in “${title}”? What it is doing in this conversation ends now; what it already did stays.`;

/** Which bridge a conversation came in by, in plain words: only Discord and Slack have a receipt. */
const bridges: Record<string, string> = { discord: 'Discord', slack: 'Slack' };
/** The bridge receipt, as the desktop's conversation activity draws it (pieces/comms/conversation.tsx): for a
 * conversation that came in by Discord or Slack, when the member's latest message there arrived, whether the agent
 * took it up, and whether a reply went back. Read only for such a conversation (`latestBridgeReceipt`, the
 * desktop's own read, which answers only the member's own messages), at a brick's relaxed pace: it is a receipt,
 * not the conversation, and a few seconds late is soon enough. Nothing of the bridge itself is shown or linked. */
export function BridgeReceipt({ thread, agentName }: { thread: string; agentName(id: string): string }) {
  const head = useDataQuery<{ thread: CommsThread | null }>(threadHeadQuery, { id: thread }, { keep: true });
  const t = head.status === 'live' && head.data?.thread?.id === thread ? head.data.thread : null;
  const by = t?.venue ? bridges[t.venue] : undefined;
  const read = useDataQuery<BridgeReceiptData>(bridgeReceiptQuery, { id: t?.conversation ?? '' }, { pause: !by || !t?.conversation, pace: 'relaxed' });
  const receipt = by && read.status === 'live' ? read.data?.latestBridgeReceipt : null;
  if (!by || !receipt) return null;
  return (
    <p className="boards-receipt board-note" data-bridge={t!.venue}>
      Your message by {by} <Time at={receipt.receivedAt} />
      {' · '}{receipt.acceptedAt ? <>{agentName(receipt.agent)} took it up <Time at={receipt.acceptedAt} /></> : `${agentName(receipt.agent)} has not taken it up yet`}
      {' · '}{receipt.replied ? 'Reply sent' : 'No reply sent yet'}
    </p>
  );
}
