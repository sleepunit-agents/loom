/** More than one conversation on the boards page: the list of the member's threads beside the presence, and the
 * open thread's title with its rename and archive. Which thread is shown is the address and nothing else; whether
 * the list is open is this page's own and is kept nowhere. The reads, the order and the calls are Comms' own. */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { newId } from '../data/id';
import { threadFields } from '../pieces/comms/thread-fields';
import type { CommsThread } from '../pieces/comms-view/model';
import { SHORTCUTS, keysOf, onMac, shortcutEngine } from '../shell/shortcuts';
import { threadPath, useAgentNames, useThreads } from './agents-data';

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

/** The control beside the presence, and the list it opens. */
export function ThreadSwitch({ thread, visit }: { thread: string; visit(path: string): void }) {
  const [open, setOpen] = useState(false);
  useLauncherKeys(() => setOpen((now) => !now));
  return (
    <>
      <button type="button" className="boards-threads-open board-action" aria-haspopup="dialog" aria-expanded={open} aria-label="Conversations"
        title={'Conversations · ' + keysOf(SHORTCUTS[0], onMac())} onClick={() => setOpen((now) => !now)}>☰</button>
      {open && <ThreadList thread={thread} visit={visit} close={() => setOpen(false)} />}
    </>
  );
}

function ThreadList({ thread, visit, close }: { thread: string; visit(path: string): void; close(): void }) {
  const list = useThreads(), name = useAgentNames();
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
  const choose = (n: number) => { const row = list.rows[n]; if (row) go(row.id); else if (list.agents[n - list.rows.length]) void start(list.agents[n - list.rows.length]); };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' && count) setAt((n) => (n + 1) % count);
    else if (e.key === 'ArrowUp' && count) setAt((n) => (n - 1 + count) % count);
    else if (e.key === 'Enter' && count) choose(Math.min(at, count - 1));
    else return;
    e.preventDefault();
  };
  const follow = (e: MouseEvent, id: string) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); go(id); };
  return (
    <div ref={box} className="boards-threads" role="dialog" aria-label="Conversations" tabIndex={-1} onKeyDown={keys}>
      {list.status === 'loading' && <p role="status" className="text-muted-foreground">Loading…</p>}
      {list.status === 'unavailable' && <p className="text-muted-foreground">Conversations are unavailable.</p>}
      {list.status === 'live' && (
        <ul>
          {list.rows.map((t, n) => (
            <li key={t.id}>
              <a href={threadPath(t.id)} data-active={n === at} aria-current={t.id === thread ? 'page' : undefined} onClick={(e) => follow(e, t.id)} onPointerEnter={() => setAt(n)}>
                <ThreadLine thread={t} name={name} />
              </a>
            </li>
          ))}
          {list.more && <li className="text-muted-foreground">Older conversations are in Comms.</li>}
          {list.agents.map((agent, n) => (
            <li key={'new:' + agent}>
              <button type="button" data-active={list.rows.length + n === at} disabled={busy} onClick={() => void start(agent)} onPointerEnter={() => setAt(list.rows.length + n)}>New conversation with {name(agent)}</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
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
type Change = { change: 'rename'; title: string } | { change: 'archive'; archived: boolean };
/** The open thread's title, and for the member whose thread it is, Comms' rename and archive (`comms.change`). */
export function ThreadHead({ thread, member }: { thread: string; member: string }) {
  const read = useDataQuery<{ thread: CommsThread | null }>(threadHeadQuery, { id: thread }, { keep: true });
  const [mode, setMode] = useState<'rename' | 'archive' | null>(null), [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const t = read.status === 'live' && read.data?.thread?.id === thread ? read.data.thread : null;
  if (!t) return null;
  const run = async (change: Change) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await memberOperation('comms.change', { thread, ...change }); setMode(null); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const named = title.trim(), fits = !!named && [...named].length <= 60;
  const rename = (e: FormEvent) => { e.preventDefault(); if (fits) void run({ change: 'rename', title: named }); };
  return (
    <div className="boards-thread">
      <div className="board-line">
        <strong className="boards-thread-title">{t.title}</strong>
        {t.archivedAt && <span className="board-state">Archived</span>}
        {t.member === member && !mode && (
          <>
            <button type="button" className="board-action" disabled={busy} onClick={() => { setTitle(t.title); setMode('rename'); }}>Rename</button>
            {t.archivedAt
              ? <button type="button" className="board-action" disabled={busy} onClick={() => void run({ change: 'archive', archived: false })}>Restore</button>
              : <button type="button" className="board-action" disabled={busy} onClick={() => setMode('archive')}>Archive…</button>}
          </>
        )}
      </div>
      {mode === 'rename' && (
        <form className="board-line" aria-label="Rename conversation" onSubmit={rename}>
          <input className="board-input" aria-label="Conversation title" value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} />
          <button type="submit" className="board-action" disabled={busy || !fits}>Save title</button>
          <button type="button" className="board-action" disabled={busy} onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === 'archive' && (
        <div className="board-line" role="group" aria-label="Archive conversation">
          <span>Archive this conversation? It leaves the list of conversations.</span>
          <button type="button" className="board-action" disabled={busy} onClick={() => void run({ change: 'archive', archived: true })}>Archive conversation</button>
          <button type="button" className="board-action" disabled={busy} onClick={() => setMode(null)}>Keep it</button>
        </div>
      )}
      {error && <p role="alert" className="text-destructive">Could not save. Try again.</p>}
    </div>
  );
}
