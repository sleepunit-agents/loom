// Work in this thread (docs/specs/comms.md, "Work in this thread", "The panel"): the tasks, changes and notes a thread
// names or made, with their live state, from GET /comms/<thread>/work. Part of the Comms chunk (comms.tsx imports it).
//
// Desktop, with the comm screen in the right column: a framed panel under the comm screen and YOU. Anywhere else (a
// phone, or a desktop pane under 760 px, where the comm screen sits at the top): a strip, "Work (N)", folded until
// tapped. Read when the thread opens, 5 s after each new reply, and every 60 s while the page is visible.
import { useCallback, useEffect, useRef, useState } from 'react';
import './comms-work.css';

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
  const inner = (
    <>
      <span className="comms-work__title">{it.title}</span>
      <span className="comms-work__line">
        <span className="comms-work__badge loom-data" data-tone={it.tone}>{it.status}</span>
        <span className="comms-work__meta loom-data">{shortRef(it.ref)}{it.made ? ' · made here' : ''}</span>
      </span>
    </>
  );
  return (
    <li className="comms-work__row" data-tone={it.tone} data-made={it.made || undefined}>
      {url ? <a href={url} {...(url.startsWith('https://') ? { target: '_blank', rel: 'noreferrer' } : {})}>{inner}</a> : <span>{inner}</span>}
    </li>
  );
}

export function WorkPanel({ thread, replySeq }: { thread: string; replySeq: number }) {
  const [work, setWork] = useState<Work | null>(null);
  const [open, setOpen] = useState(false);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/comms/${thread}/work`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (r.ok && alive.current) setWork((await r.json()) as Work);
    } catch { /* the next read tries again */ }
  }, [thread]);
  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);
  // A new reply may have made or named work: read again 5 s after it, once the pieces have seen it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => void load(), 5_000);
    return () => clearTimeout(t);
  }, [replySeq, load]);

  const items = work?.items ?? [];
  const rows = (
    <div className="comms-work__rows" id={`work-${thread}`}>
      {work === null ? <p className="comms-work__empty">Reading…</p>
        : items.length === 0 ? <p className="comms-work__empty">Nothing yet. Tasks, changes and notes this thread names or makes show up here.</p>
          : <ul className="comms-work__list">{items.map((it) => <Row key={it.ref} it={it} />)}</ul>}
      {work?.failed.map((f) => <p key={f} className="comms-work__failed">{f} didn't answer.</p>)}
    </div>
  );
  return (
    <section className="comms-work" data-open={open || undefined} aria-label="Work in this thread">
      <h2 className="comms-work__head loom-data">WORK IN THIS THREAD</h2>
      <button type="button" className="comms-work__toggle" aria-expanded={open} aria-controls={`work-${thread}`} onClick={() => setOpen(!open)}>
        <span>{workLabel(items)}</span><span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {rows}
    </section>
  );
}
