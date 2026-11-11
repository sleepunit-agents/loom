// Work in this thread (docs/specs/comms.md, "Work in this thread", "The panel"): the tasks, changes and notes a thread
// names or made, with their live state, from GET /comms/<thread>/work. Part of the Comms chunk (comms.tsx imports it).
//
// Desktop, with the comm screen in the right column: a framed panel under the comm screen and YOU. Anywhere else (a
// phone, or a desktop pane under 760 px, where the comm screen sits at the top): a strip, "Work (N)", folded until
// tapped. Read when the thread opens, 5 s after each new reply, and when a task it shows (or one made in it) moves, or
// a change it shows does: the tasks' and the changes' own records, live (tasks-live.ts, t-2029). Every 60 s while the
// page is visible only while those it needs aren't live.
import { useCallback, useEffect, useRef, useState } from 'react';
import { changesLive, tasksLive, watchChanges, watchTasks } from './tasks-live';
import './comms-work.css';
import { List, LinkRow, Loading, Empty, Error as LoadError } from './kit';

export interface WorkItem { title: string; ref: string; status: string; tone?: 'bad' | 'warn' | 'ok'; when?: string; url?: string; made?: true; from: string }
interface Work { items: WorkItem[]; failed: string[] }

/** The ref as the row shows it: a change by its short form (acme/app#3), the rest as kept. */
export function shortRef(ref: string): string {
  return ref.startsWith('github:') ? ref.slice('github:'.length) : ref;
}

/** Only a link that stays on this origin or goes to https opens; anything else is shown as words. */
function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  if (/^\/(?!\/)/.test(u)) return u;
  return /^https:\/\/[^\s<>"]+$/.test(u) ? u : undefined;
}

/** "Work (5)", or "Work (5 · 1 needs a look)" when any is a problem: in words, never colour alone. */
export function workLabel(items: WorkItem[]): string {
  const bad = items.filter((i) => i.tone === 'bad').length;
  return `Work (${items.length}${bad ? ` · ${bad} need${bad === 1 ? 's' : ''} a look` : ''})`;
}

function Row({ it }: { it: WorkItem }) {
  const url = safeUrl(it.url);
  return <li data-tone={it.tone} data-made={it.made || undefined}><LinkRow href={url}
    {...(url?.startsWith('https://') ? { target: '_blank', rel: 'noreferrer' } : {})}
    title={it.title} status={<span data-tone={it.tone}>{it.status}</span>} meta={`${shortRef(it.ref)}${it.made ? ' · made here' : ''}`} /></li>;
}

/** Whether these moved tasks concern the panel: one it shows, or one made in its conversation. */
export function concerns(keys: ReadonlySet<string>, records: ReadonlyMap<string, Record<string, unknown>>, shown: readonly WorkItem[], conversation: string): boolean {
  const refs = new Set(shown.map((i) => `tasks/task/${i.ref}`));
  for (const k of keys) if (refs.has(k) || records.get(k)?.source === `conversation:${conversation}`) return true;
  return false;
}

/** Whether these moved changes concern the panel: one it shows, by its ref (github:owner/repo#N). */
export function changesConcern(keys: ReadonlySet<string>, records: ReadonlyMap<string, Record<string, unknown>>, shown: readonly WorkItem[]): boolean {
  const refs = new Set(shown.filter((i) => i.ref.startsWith('github:')).map((i) => i.ref));
  for (const k of keys) { const ref = records.get(k)?.ref; if (typeof ref === 'string' && refs.has(ref)) return true; }
  return false;
}

export function WorkPanel({ thread, conversation, csrf, replySeq }: { thread: string; conversation: string; csrf: string; replySeq: number }) {
  const [work, setWork] = useState<Work | null>(null);
  const [error, setError] = useState(false);
  const shown = useRef<WorkItem[]>([]);
  shown.current = work?.items ?? [];
  const [open, setOpen] = useState(false);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/comms/${thread}/work`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('unavailable');
      const next = await r.json() as Work;
      if (alive.current) { setWork(next); setError(false); }
    } catch { if (alive.current) setError(true); }
  }, [thread]);
  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && (!tasksLive() || (!changesLive() && shown.current.some((i) => i.ref.startsWith('github:'))))) void load();
    }, 60_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);
  // A task it shows, or one made here, moved: read again (a moment later, so a burst of moves is one read).
  useEffect(() => {
    if (!csrf) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const again = () => { clearTimeout(t); t = setTimeout(() => void load(), 250); };
    const offT = watchTasks(csrf, (keys, records) => { if (concerns(keys, records, shown.current, conversation)) again(); });
    // A change it shows moved (its checks, its review, merged): Changes' own records (loom-changes' changes/change).
    const offC = watchChanges(csrf, (keys, records) => { if (changesConcern(keys, records, shown.current)) again(); });
    return () => { clearTimeout(t); offT(); offC(); };
  }, [csrf, conversation, load]);
  // A new reply may have made or named work: read again 5 s after it, once the pieces have seen it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => void load(), 5_000);
    return () => clearTimeout(t);
  }, [replySeq, load]);

  const items = work?.items ?? [];
  const rows = (
    <div className="comms-work-content" id={`work-${thread}`}>
      {error && <LoadError title="Couldn’t read this thread’s work" retry={() => void load()} />}
      {work === null ? !error && <Loading label="Reading…" />
        : items.length === 0 ? <Empty compact title="Nothing yet" text="Tasks, changes and notes this thread names or makes show up here." />
          : <List label="Work in this thread"><ul className="comms-work__list">{items.map((it) => <Row key={it.ref} it={it} />)}</ul></List>}
      {work?.failed.map((f) => <LoadError key={f} title={`${f} didn't answer.`} retry={() => void load()} />)}
    </div>
  );
  return (
    <section className="comms-work" data-open={open || undefined} aria-label="Work in this thread">
      <h2 className="comms-work-label loom-data">WORK IN THIS THREAD</h2>
      <button type="button" className="comms-work__toggle" aria-expanded={open} aria-controls={`work-${thread}`} onClick={() => setOpen(!open)}>
        <span>{workLabel(items)}</span><span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {rows}
    </section>
  );
}
