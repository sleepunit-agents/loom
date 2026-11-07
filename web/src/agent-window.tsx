// An agent's window (t-1925 D; the app mockups Jonathan approved 2026-11-06): its pixel face in a Neon frame (a cut
// corner, a lit edge; no 000h shapes), its name with a working pill, and a plain description of what it does, written
// for the household (never its creed). Its own sections (Today, Mind, Clock, Bridges, Setup and whatever pieces add) are
// a sidebar inside the window, an icon rail when the window is narrow: the desktop's dock no longer swaps. On a phone
// the same header, and the dock keeps the agent's sections (a sidebar would take a third of a 390 px screen).
// The owner can write the description in place, or ask the agent to write its own (Regenerate): a Comms thread asks
// it, and it saves its answer with describe_self. Its own chunk.
import { useEffect, useRef, useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Button } from '@/components/ui/button';
import { iconFor } from './safe';
import { AgentAvatar, useEnv } from './blocks';
import { markColor } from './look';
import type { AgentHead, Chrome } from './loom';
import './faceframe.css';
import './agent-window.css';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newId = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map((x) => B32[x & 31]).join(''); };

/** What the agent is asked when its owner presses Regenerate (a Comms thread from them, in their name). */
export const DESCRIBE_ASK = 'Please write the short description on your loom profile: one or two plain sentences on what you do and for whom, '
  + 'for anyone in the household to read. Not your creed, and nothing from your memories. Save it with describe_self.';

/** Below this the sidebar is an icon rail and the face is smaller (the mockups' narrow tile). */
const NARROW = 640;

export default function AgentWindow({ head, chrome, icon, rail, children }: {
  head: AgentHead; chrome?: Chrome; icon: (label: string) => string; /** a window (a tile): the sidebar; a phone: none */ rail: boolean; children: React.ReactNode;
}) {
  const env = useEnv();
  const box = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < NARROW));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const id = head.id!;
  const agent = chrome?.shell?.agents.find((a) => a.id === id);
  const mark = { id, label: head.label, bg: head.bg, fg: head.fg, face: agent?.face };
  const c = markColor(head.bg);
  const loom = env.withSource({ id: 'loom', base: '/' });
  const working = head.working ?? agent?.working;
  const waiting = head.waiting ?? agent?.asks ?? 0;
  const facts = [head.sub ?? '', head.active ?? ''].filter(Boolean).join(' · ');

  return (
    <div ref={box} className="loom-agentwin" data-rail={rail || undefined} data-narrow={narrow || undefined} style={{ '--c': c } as React.CSSProperties}>
      {rail && (
        <nav className="loom-agentwin__nav" aria-label={`${head.label}'s sections`}>
          {head.tabs.map((t) => (
            <a key={t.href} href={t.href} aria-current={t.current ? 'page' : undefined} title={t.label} aria-label={narrow ? t.label : undefined}
              onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); env.go(t.href); }}>
              <AnimatedIcon name={iconFor(icon(t.label))} size="sm" active={t.current} />
              <span className="loom-agentwin__navlabel">{t.label}</span>
            </a>
          ))}
        </nav>
      )}
      <div className="loom-agentwin__main">
        <header className="loom-aghead">
          <span className="loom-faceframe loom-aghead__face" style={{ '--c': c, width: narrow ? 72 : 128, height: narrow ? 72 : 128 } as React.CSSProperties}>
            <AgentAvatar a={mark} size={narrow ? 64 : 112} state={waiting ? 'needs-input' : 'idle'} />
          </span>
          <div className="loom-aghead__who">
            <div className="loom-aghead__name">
              <span>{head.label}</span>
              {working ? <span className="loom-pill" data-tone="live"><i aria-hidden />working</span>
                : waiting ? <span className="loom-pill" data-tone="warn"><i aria-hidden />{waiting} waiting on you</span> : null}
            </div>
            <Description head={head} send={(a, f) => loom.send(a, f)} csrf={chrome?.csrf ?? ''} go={env.go} />
            {facts && <p className="loom-aghead__facts loom-data">{facts}</p>}
          </div>
          <div className="loom-aghead__acts">
            <Button size="sm" onClick={() => env.go('/comms')}>Message</Button>
          </div>
        </header>
        <div className="loom-agentwin__body">{children}</div>
      </div>
    </div>
  );
}

/** The description: the household's words for the agent, in place. Its owner can write it, or ask the agent to. */
function Description({ head, send, csrf, go }: { head: AgentHead; send: (action: string, fields: Record<string, string>) => Promise<boolean>; csrf: string; go: (href: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(head.about ?? '');
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => { if (!editing) setText(head.about ?? ''); }, [head.about, editing]);
  const id = head.id!;
  const save = async () => {
    setBusy(true);
    const ok = await send('about-set', { agent: id, about: text });
    setBusy(false);
    if (ok) setEditing(false);
  };
  // Ask the agent to write its own: the ask opens (its describe_self may write once), then a Comms thread asks it.
  const regenerate = async () => {
    setBusy(true);
    const ok = await send('about-ask', { agent: id });
    if (ok) {
      try {
        const r = await fetch('/comms/new', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ agent: id, id: newId(), text: DESCRIBE_ASK, _csrf: csrf }) });
        const j = await r.json().catch(() => ({})) as { thread?: { id: string } };
        setAsked(true);
        if (r.ok && j.thread) go(`/comms/${j.thread.id}`);
      } catch { /* the ask stands; Comms says what happened */ }
    }
    setBusy(false);
  };
  if (editing) return (
    <form className="loom-aghead__edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="sr-only" htmlFor={`about-${id}`}>{head.label}'s description</label>
      <textarea id={`about-${id}`} value={text} maxLength={600} rows={3} autoFocus onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false); } }}
        placeholder={`What ${head.label} does, and for whom, in a sentence or two.`} />
      <div className="loom-aghead__editbar">
        <Button size="sm" type="submit" disabled={busy}>Save</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
        <span className="loom-data loom-aghead__count">{text.trim().length}/600</span>
      </div>
    </form>
  );
  const waitingOn = asked || head.asked;
  return (
    <div className="loom-aghead__desc">
      {head.about ? <p>{head.about}</p> : head.edit ? <p className="loom-aghead__none">No description yet.</p> : null}
      {head.edit && (
        <div className="loom-aghead__descacts">
          <button type="button" className="loom-linkbtn" onClick={() => setEditing(true)}>{head.about ? 'Edit' : 'Write one'}</button>
          <button type="button" className="loom-linkbtn" disabled={busy} onClick={() => void regenerate()}>
            {head.about ? `Ask ${head.label} to rewrite it` : `Ask ${head.label} to write it`}</button>
          {waitingOn && <span className="loom-aghead__asked" role="status">Asked {head.label}; its words show here once it saves them.</span>}
        </div>
      )}
    </div>
  );
}
