// The agent-centric desktop (docs/specs/agent-desk.md; t-1959, the owner's prototype of 2026-11-07): no widgets. With
// nothing open, Home is a slim Needs you band and one big card per agent; with apps open, a fixed-width rail beside the
// tiles holds Needs you and a compact card per agent. The agents are the viewer's own (loom narrows the household to
// them), always there, in alphabetical order by name.
//
// What a card says comes from what loom already has: Home's page (each agent's state, what it's on, its readings: the
// Clock's `Next` is its next wake), the shell (its asks) and the member's own Comms summary (GET /comms/agents: the last
// thread, unread replies and the first one's line; read state is the member's alone).
//
// In the desk's own chunk (tiling/tiles.tsx imports it): a phone never fetches it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ActButton, AgentAvatar, EnvContext, Nothing, useEnv, type Mark, type MarkState } from './blocks';
import { guardedEnv, LIVE_SAYS, useAskLive } from './ask-open';
import { As, type InboxItem } from './views';
import { plain } from './plain';
import { markColor } from './look';
import { onLive } from './page';
import { newId } from './comms-id';
import type { Shell } from './loom';
import './desk-agents.css';

// ---- what loom says about each agent -----------------------------------------------------------------------------

/** One thing it has going; `href` is loom's link to it (a Comms thread, only for its member: handler.ts atWorkFor). */
type Doing = { text: string; kind?: string; where?: string; since?: string; href?: string };
type Reading = { label: string; value: string; detail?: string; tone?: string };
/** An agent as Home's page has it (src/ui/handler.ts agentCards). */
export type Card = Mark & { id: string; state?: 'working' | 'available' | 'unavailable' | 'broken'; reason?: string;
  doing?: Doing[]; problems?: { text: string; tone: 'bad' | 'warn' }[]; seen?: { at: string; where: string }; readings?: Reading[] };
export type DeskHomeData = { headline: string; needs: number; need?: InboxItem; stack?: InboxItem[]; cards: Card[] };
/** The member's own Comms, per agent (src/comms.ts agentsComms). */
export type AgentComms = { agent: string; unread: number; first?: { thread: string; text: string | null };
  last?: { thread: string; title: string | null; at: string } };

/** A thread's page address: its id without the `th:` (comms.tsx threadPath). */
export const threadHref = (id: string) => `/comms/${id.replace(/^th:/, '')}`;

/** When, as a card says it: the time today, "yesterday", a weekday this week, else the date. */
export function when(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t), today = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(today) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (days === 1) return 'yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export type Tone = 'work' | 'quiet' | 'ask' | 'bad' | 'warn' | 'off';
/** An agent on the desktop: everything its cards draw, worked out once. */
export type DeskAgent = {
  id: string; label: string; mark: Mark;
  /** its colour, lit for the look (look.ts markColor) */
  color: string;
  status: { word: string; tone: Tone };
  face: MarkState;
  /** what it's on now, or why it's quiet; `href` its thread when it has one (t-1945) */
  now: { text: string; href?: string; tone?: 'bad' | 'warn' };
  /** its next wake, as the Clock reports it (a reading named `Next`) */
  wake?: string;
  last?: { title: string; at: string; href: string };
  unread: number;
  first?: { text: string | null; href: string };
  /** its asks waiting on you, and the first of them as the Inbox has it */
  asks: number; ask?: InboxItem;
  /** where its card opens: the thread with its first unread reply, else its last thread, else Comms */
  open: string;
  /** in a conversation now (the runtime's `talk`) */
  talking: boolean;
};

/** How an agent is, in a word (precedence: trouble, an ask, work, unavailable, quiet). */
function statusOf(c: Card | undefined, asks: number): { word: string; tone: Tone; face: MarkState } {
  const problems = c?.problems ?? [], doing = c?.doing ?? [];
  if (problems.length) return c?.state === 'broken' ? { word: 'Something’s broken', tone: 'bad', face: 'error' } : { word: 'Needs a look', tone: 'warn', face: 'error' };
  if (asks > 0) return { word: 'Waiting on you', tone: 'ask', face: 'needs-input' };
  if (c?.state === 'working' || doing.length) return { word: doing.length > 1 ? `Working · ${doing.length} things` : 'Working', tone: 'work', face: 'working' };
  if (c?.state === 'unavailable') return { word: 'Unavailable', tone: 'off', face: 'idle' };
  return { word: 'Quiet', tone: 'quiet', face: 'idle' };
}

/** The agents on the desktop: the viewer's own (the shell has only those), alphabetical by name. */
export function deskAgents(shell: Shell, home: DeskHomeData | null, comms: Record<string, AgentComms> | null, now = Date.now()): DeskAgent[] {
  return [...shell.agents].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)).map((s) => {
    const c = home?.cards.find((x) => x.id === s.id);
    const k = comms?.[s.id];
    const asks = s.asks ?? 0;
    const st = statusOf(c, asks);
    const problems = c?.problems ?? [], doing = c?.doing ?? [];
    const nowLine = problems[0] ? { text: problems[0].text, tone: problems[0].tone }
      : doing[0] ? { text: doing[0].text, ...(doing[0].href ? { href: doing[0].href } : {}) }
      : { text: c?.state === 'unavailable' && c.reason ? c.reason : 'Nothing right now' };
    const next = c?.readings?.find((r) => r.label === 'Next');
    const last = k?.last ? { title: k.last.title ?? 'New thread', at: when(k.last.at, now), href: threadHref(k.last.thread) } : undefined;
    const first = k?.first ? { text: k.first.text, href: threadHref(k.first.thread) } : undefined;
    const ask = (home?.stack ?? []).find((i) => i.agent === s.id);
    return {
      id: s.id, label: s.label, mark: s as unknown as Mark, color: markColor(s.bg), status: { word: st.word, tone: st.tone }, face: st.face, now: nowLine,
      ...(next ? { wake: [next.value, next.detail].filter(Boolean).join(' · ') } : {}),
      ...(last ? { last } : {}), unread: k?.unread ?? 0, ...(first ? { first } : {}), asks, ...(ask ? { ask } : {}),
      open: first?.href ?? last?.href ?? '/comms', talking: doing.some((x) => x.kind === 'talk'),
    };
  });
}

/**
 * The member's own Comms summary (GET /comms/agents), kept current: asked again when the live stream says something
 * moved (a reply landing, a read, both bump the member's stream: src/ui/comms-live.ts), when a Comms pane here reads a
 * thread, when the tab comes back, and every minute as a fallback. Null until it answers, or with no Comms.
 */
export function useAgentComms(on: boolean): Record<string, AgentComms> | null {
  const [v, setV] = useState<Record<string, AgentComms> | null>(null);
  useEffect(() => {
    if (!on) { setV(null); return; }
    let alive = true;
    let t = 0;
    const get = () => {
      // Refused (signed out: loom sends a non-member to sign in, a 303; or no longer a member, a 403): nothing is shown,
      // not the last answer. Not reached at all: the last answer stays.
      void fetch('/comms/agents', { credentials: 'same-origin', headers: { accept: 'application/json' }, redirect: 'manual', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 500) ? { agents: [] } : null)).catch(() => null)
        .then((d: { agents?: AgentComms[] } | null) => {
          if (!alive || !d?.agents) return;
          const next = Object.fromEntries(d.agents.map((a) => [a.agent, a]));
          setV((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
        });
    };
    // A burst of changes asks once.
    const soon = () => { clearTimeout(t); t = window.setTimeout(get, 200); };
    get();
    const off = onLive(soon);
    const every = setInterval(get, 60_000);
    const back = () => { if (document.visibilityState === 'visible') soon(); };
    addEventListener('loom-comms-read', soon);
    document.addEventListener('visibilitychange', back);
    return () => { alive = false; clearTimeout(t); off(); clearInterval(every); removeEventListener('loom-comms-read', soon); document.removeEventListener('visibilitychange', back); };
  }, [on]);
  return v;
}

// ---- Needs you ----------------------------------------------------------------------------------------------------

const needHref = (i: InboxItem) => `/inbox?f=needs&i=${encodeURIComponent(i.key)}`;

/**
 * One thing that needs you, in Home's band: what, a line of why, and its answer where that's safe to give in a line:
 * Yes and No for a yes/no ask, its own buttons for a plain one. An approval, or buttons with lines of their own ("If you
 * allow…"), are read whole before they're pressed (views.tsx ApprovalBox's rule): those open in the Inbox, picked.
 * Its buttons wait until loom says, now, it's still open, and it's asked again right before a send (ask-open.ts).
 */
function NeedChip({ i }: { i: InboxItem }) {
  const outer = useEnv();
  const agents = outer.ctx.agents ?? {};
  const who = (i.agent && agents[i.agent]?.label) || (i.agent ? i.agent[0].toUpperCase() + i.agent.slice(1) : '');
  const p = plain(i, who);
  const yesNo = !i.approval && i.needs?.answers === 'yes-no' && !!i.reply;
  const lined = !!(i.needs?.if_yes || i.needs?.if_no);
  const acts = !i.approval && !yesNo && !lined && !i.reply ? (i.actions ?? []) : [];
  const answerable = yesNo || acts.length > 0;
  const { live, check } = useAskLive(answerable ? { k: i.key } : null);
  const env = useMemo(() => guardedEnv(outer, check), [outer, i.key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const say = async (answer: 'yes' | 'no') => {
    if (busy || !i.reply) return;
    setBusy(true);
    await env.withSource(i.source).send('needs-answer', { ...i.reply.fields, answer });
    setBusy(false);
  };
  const open = () => outer.go(needHref(i));
  const sub = [who && `${who} asks`, p.why ?? i.outcome].filter(Boolean).join(' · ');
  return (
    <EnvContext.Provider value={env}>
      <li className="loom-nchip" data-tone={i.approval ? 'ask' : undefined}>
        <button type="button" className="loom-nchip__tx" onClick={open} title={p.title}>
          <b>{i.unread && <span className="loom-nchip__unread" aria-label="Unread" />}{p.title}</b>
          {sub && <small>{sub}</small>}
        </button>
        <span className="loom-nchip__acts" role="group" aria-label="Your answer">
          {answerable && live !== 'live' ? <span className="loom-nchip__live loom-data" role="status" data-live={live} title={LIVE_SAYS[live as Exclude<typeof live, 'live'>]}>
            {live === 'checking' ? 'checking…' : live === 'gone' ? 'answered' : 'offline'}</span>
            : yesNo ? <><Button size="sm" disabled={busy} onClick={() => void say('yes')}>Yes</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void say('no')}>No</Button></>
            : acts.length ? <As source={i.source}>{acts.slice(0, 2).map((b) => <ActButton key={b.action + b.label} b={b} />)}</As>
            : <Button size="sm" variant="outline" onClick={open}>{i.reply?.label || (i.approval ? 'Read and answer' : 'Open')}…</Button>}
        </span>
      </li>
    </EnvContext.Provider>
  );
}

/** Home's Needs you: a slim band over the cards, the first three answerable where they stand, the rest in the Inbox. */
export function NeedsBand({ d }: { d: DeskHomeData | null }) {
  const { go } = useEnv();
  const all = d?.stack ?? (d?.need ? [d.need] : []);
  const n = d?.needs ?? 0;
  const shown = all.slice(0, 3);
  return (
    <div className="loom-needs-band" data-zero={n ? undefined : ''} role="region" aria-label="Needs you">
      <span className="loom-needs-band__lab loom-data"><span className="loom-dot" aria-hidden />NEEDS YOU · {n}</span>
      {n ? <ul className="loom-needs-band__items">{shown.map((i) => <NeedChip key={i.key} i={i} />)}</ul>
        : <span className="loom-needs-band__quiet">{d ? 'All clear. Nothing is waiting on you.' : 'Checking…'}</span>}
      {n > 0 && <a href="/inbox?f=needs" className="loom-needs-band__all" onClick={(e) => { e.preventDefault(); go('/inbox?f=needs'); }}>
        {n > shown.length ? `+${n - shown.length} more · ` : ''}Inbox ›</a>}
    </div>
  );
}

/** The rail's Needs you: its count and the first thing, opening the Inbox on Needs you. */
export function RailNeeds({ d }: { d: DeskHomeData | null }) {
  const { go, ctx } = useEnv();
  const n = d?.needs ?? 0;
  const top = d?.stack?.[0] ?? d?.need;
  const who = top?.agent ? ctx.agents?.[top.agent]?.label ?? top.agent : '';
  const title = top ? plain(top, who).title : '';
  return (
    <button type="button" className="loom-rneeds" data-zero={n ? undefined : ''} onClick={() => go(top && n === 1 ? needHref(top) : '/inbox?f=needs')}
      aria-label={n ? `Needs you: ${n}. ${title}` : 'Needs you: all clear'}>
      <span className="loom-dot" aria-hidden /><span className="loom-rneeds__lab loom-data">NEEDS YOU · {n}</span>
      <span className="loom-rneeds__top">{n ? `${title}${n > 1 ? ` · +${n - 1} more` : ''}` : 'All clear'}</span>
    </button>
  );
}

// ---- the big card -------------------------------------------------------------------------------------------------

/** A row of a big card's facts (a label and one line), or null to leave it out. `tall`: only when the card has room. */
export type BigRow = { id: string; label: string; tall?: boolean; draw: (a: DeskAgent) => React.ReactNode | null };
/** A section under the facts, the card's width (an ask, what's unread): null to leave it out. */
export type BigSection = { id: string; draw: (a: DeskAgent, go: (href: string) => void) => React.ReactNode | null };

/** A link inside a card: its own page in a tile (the desk's go), and a real link for a new tab. */
function Go({ href, className, children, label }: { href: string; className?: string; children: React.ReactNode; label?: string }) {
  const { go } = useEnv();
  return <a href={href} className={className} aria-label={label} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(href); }}>{children}</a>;
}

/**
 * The big card's facts, in order. The owner wants the card's spare room filled over time (2026-11-07): a new fact is a
 * row here, a new block a section below; the card lays them out and gives each its own line.
 */
export const BIG_ROWS: BigRow[] = [
  { id: 'now', label: 'now', draw: (a) => (a.now.href ? <Go href={a.now.href} className="loom-bigcard__link">{a.now.text}</Go> : a.now.text) },
  { id: 'last', label: 'last thread', draw: (a) => (a.last ? <Go href={a.last.href} className="loom-bigcard__link">{a.last.title}<span className="loom-bigcard__at"> · {a.last.at}</span></Go> : null) },
  { id: 'wake', label: 'next wake', tall: true, draw: (a) => a.wake ?? null },
];
export const BIG_SECTIONS: BigSection[] = [
  { id: 'ask', draw: (a, go) => (a.ask ? (
    <button type="button" className="loom-bigcard__strip" data-kind="ask" onClick={() => go(needHref(a.ask!))}>
      <b className="loom-data">ASKS</b><span>{plain(a.ask, a.label).title}</span></button>
  ) : null) },
  { id: 'unread', draw: (a, go) => (a.unread ? (
    <button type="button" className="loom-bigcard__strip" data-kind="unread" onClick={() => go(a.open)}>
      <b className="loom-data">{a.unread} new</b><span>{a.first?.text ? `‘${a.first.text}’` : 'Open the thread to read it'}</span></button>
  ) : a.ask ? null : <span className="loom-bigcard__strip" data-kind="none">No new messages</span>) },
];

/** The face's size for a card this big: whole-number scales of the 96 px sprite only (3x, 2x, 1x). */
const faceFor = (w: number, h: number) => (w >= 720 && h >= 540 ? 288 : w <= 440 || h <= 300 ? 96 : 192);

/** What each agent's composer holds, and its message id, kept while you move between Home and the apps: the id stays
 * with the draft until the send succeeds (comms.md, as Comms' own New thread keeps it), so a send tried again is the
 * same thread, never a second. */
const drafts = new Map<string, { text: string; id: string }>();
const draftOf = (agent: string) => { let d = drafts.get(agent); if (!d) { d = { text: '', id: newId() }; drafts.set(agent, d); } return d; };

/** Start a thread with the agent from its card, and open it in Comms (POST /comms/new, as Comms' New thread does). */
function Composer({ a }: { a: DeskAgent }) {
  const env = useEnv();
  const [text, setText] = useState(() => draftOf(a.id).text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch('/comms/new', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ agent: a.id, id: draftOf(a.id).id, text: t, _csrf: env.ctx.csrf }) });
      const j = await r.json().catch(() => ({})) as { thread?: { id: string }; error?: string };
      if (!r.ok || !j.thread) { setError(String(j.error ?? 'That didn’t start.').replace(/^[a-z-]+: /, '')); return; }
      setText(''); drafts.delete(a.id);
      env.go(threadHref(j.thread.id));
    } catch { setError('loom can’t be reached right now.'); } finally { setBusy(false); }
  };
  return (
    <form className="loom-bigcard__compose" onSubmit={(e) => void send(e)}>
      <input value={text} onChange={(e) => { setText(e.target.value); draftOf(a.id).text = e.target.value; }} placeholder={`Message ${a.label}…`}
        aria-label={`Message ${a.label}`} autoComplete="off" maxLength={40_000} disabled={busy} data-draft={a.id} />
      <Button type="submit" disabled={busy || !text.trim()}>Send</Button>
      {error && <p className="loom-bigcard__error" role="alert">{error}</p>}
    </form>
  );
}

/** An agent, big (Home): its face as big as the card allows, how it is, its facts, its ask and what's new, a composer. */
export function BigCard({ a, flow }: { a: DeskAgent; /** as tall as it needs (a phone's column), not a box the desktop sets */ flow?: boolean }) {
  const env = useEnv();
  const box = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => { const r = el.getBoundingClientRect(); setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height })); };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const face = faceFor(size.w, size.h);
  const tall = flow || size.h === 0 || size.h > 360;
  const rows = BIG_ROWS.filter((r) => tall || !r.tall).map((r) => ({ r, v: r.draw(a) })).filter((x) => x.v !== null);
  const sections = BIG_SECTIONS.map((s) => ({ s, v: s.draw(a, env.go) })).filter((x) => x.v !== null);
  return (
    <article ref={box} className="loom-bigcard" data-tone={a.status.tone} data-size={face} style={{ '--c': a.color } as React.CSSProperties} aria-label={a.label} data-agent={a.id}>
      <div className="loom-bigcard__in">
        <Go href={`/a/${a.id}`} className="loom-bigcard__face" label={`Open ${a.label}’s window`}>
          <AgentAvatar a={a.mark} size={face} state={a.face} />
          <span className="loom-bigcard__st" aria-hidden />
        </Go>
        <div className="loom-bigcard__info">
          <span className="loom-bigcard__eb loom-data">{a.status.word}</span>
          <h2 className="loom-bigcard__name">{a.label}{a.asks > 0 && <span className="loom-askb loom-data">ASKS YOU</span>}</h2>
          <dl className="loom-bigcard__kv">{rows.map(({ r, v }) => (
            <div key={r.id} data-row={r.id} data-tone={r.id === 'now' ? a.now.tone : undefined}><dt className="loom-data">{r.label}</dt><dd>{v}</dd></div>
          ))}</dl>
          {sections.map(({ s, v }) => <div key={s.id} className="loom-bigcard__sec" data-sec={s.id}>{v}</div>)}
        </div>
        <Composer a={a} />
      </div>
    </article>
  );
}

/** Home: Needs you, then the agents, big. A household with none says how to make the first. */
export function HomeDesk({ agents, d }: { agents: DeskAgent[]; d: DeskHomeData | null }) {
  const { go } = useEnv();
  return (
    <section className="loom-adesk" aria-label="Home">
      <NeedsBand d={d} />
      {agents.length ? <div className="loom-adesk__cards" data-n={Math.min(agents.length, 7)}>{agents.map((a) => <BigCard key={a.id} a={a} />)}</div>
        : <div className="loom-adesk__none"><Nothing title="No agents yet" text="An agent is who does the work here. Make the first one."><Button className="mt-2" onClick={() => go('/new-agent')}>New agent</Button></Nothing></div>}
    </section>
  );
}

// ---- the rail -----------------------------------------------------------------------------------------------------

/** An agent, compact (the rail): its face, name and how it is, what it's on, its ask, and what's new. It opens its thread. */
export function RailCard({ a }: { a: DeskAgent }) {
  const { go } = useEnv();
  const what = [a.status.word, a.asks ? 'asks you' : '', a.unread ? `${a.unread} new` : ''].filter(Boolean).join(', ');
  return (
    <button type="button" className="loom-rcard" data-tone={a.status.tone} data-agent={a.id} style={{ '--c': a.color } as React.CSSProperties}
      onClick={() => go(a.open)} aria-label={`${a.label}: ${what}. Open the thread`}>
      <span className="loom-rcard__top">
        <span className="loom-rcard__face"><AgentAvatar a={a.mark} size={96} state={a.face} /></span>
        <span className="loom-rcard__who"><b>{a.label}</b><span className="loom-rcard__st loom-data"><span className="loom-dot" aria-hidden />{a.status.word}</span></span>
      </span>
      <span className="loom-rcard__now" data-tone={a.now.tone}><i className="loom-data">NOW</i> {a.now.text}</span>
      {a.asks > 0 && <span className="loom-askb loom-data">ASKS YOU</span>}
      {a.unread ? <span className="loom-rcard__ur"><b className="loom-data">{a.unread}</b><span>{a.first?.text ?? 'New in the thread'}</span></span>
        : <span className="loom-rcard__ur" data-none="">No new messages</span>}
    </button>
  );
}

/**
 * An agent's rail card while its thread is in Comms beside the rail: the comm screen itself (the avatar appears once).
 * The Comms pane draws the screen into `slot`, so it plays the thread's own state (static as a reply lands, talking,
 * its channel line); under it, who it is, what it's on and its ask.
 */
export function ScreenCard({ a, slot }: { a: DeskAgent; slot?: (el: HTMLElement | null) => void }) {
  return (
    <section className="loom-rcard loom-rscreen" data-tone={a.status.tone} data-agent={a.id} style={{ '--c': a.color } as React.CSSProperties} aria-label={`${a.label}, on the line in Comms`}>
      <div ref={slot} className="loom-rscreen__slot" />
      <div className="loom-rscreen__meta"><b>{a.label}</b><small className="loom-data">on the line</small></div>
      <span className="loom-rcard__now" data-tone={a.now.tone}><i className="loom-data">NOW</i> {a.now.text}</span>
      {a.asks > 0 && <span className="loom-askb loom-data">ASKS YOU</span>}
      <span className="loom-rcard__ur" data-none="">Thread open in Comms</span>
    </section>
  );
}

/** An agent folded to one line (the accordion): its face, its name with how it is as a dot, ASK, and what's new. */
export function RailRow({ a, onOpen }: { a: DeskAgent; onOpen: () => void }) {
  const what = [a.status.word, a.asks ? 'asks you' : '', a.unread ? `${a.unread} new` : ''].filter(Boolean).join(', ');
  return (
    <button type="button" className="loom-rrow" data-tone={a.status.tone} data-agent={a.id} style={{ '--c': a.color } as React.CSSProperties}
      onClick={onOpen} aria-label={`${a.label}: ${what}. Open the thread`}>
      <span className="loom-rrow__face" aria-hidden><AgentAvatar a={a.mark} size={48} state={a.face} /></span>
      <b><span className="loom-dot" aria-hidden />{a.label}</b>
      {a.asks > 0 ? <span className="loom-askb loom-data">ASK</span> : <span />}
      {a.unread > 0 ? <span className="loom-rrow__n loom-data">{a.unread}</span> : <span />}
    </button>
  );
}

/**
 * The one card the accordion keeps open: the agent whose thread Comms shows, else one in a conversation now, else one
 * with an ask, else one with something unread, else the first.
 */
export function openInRail(agents: DeskAgent[], onAir: string | null): string | undefined {
  return (agents.find((a) => a.id === onAir) ?? agents.find((a) => a.talking) ?? agents.find((a) => a.asks > 0)
    ?? agents.find((a) => a.unread > 0) ?? agents[0])?.id;
}

/**
 * The rail beside the apps: Needs you at the top, then a compact card per agent. When they don't all fit at their own
 * size, the accordion: each a line, one open (openInRail). Measured before it's painted, so it never flashes.
 */
export function AgentRail({ agents, d, onAir, screen, slot, over, onEnter, onLeave }: { agents: DeskAgent[]; d: DeskHomeData | null; onAir: string | null;
  /** the agent whose card is the comm screen (its thread is in Comms beside the rail), and where the screen goes */
  screen?: string | null; slot?: (el: HTMLElement | null) => void;
  /** brought in over the apps (from its strip, or auto-hiding): the pointer coming and going */
  over?: boolean; onEnter?: () => void; onLeave?: () => void }) {
  const { go } = useEnv();
  const box = useRef<HTMLElement>(null);
  const [fold, setFold] = useState(false);
  const [h, setH] = useState(0);
  // What the cards hold: a change tries them at full size again.
  const holds = agents.map((a) => `${a.id}:${a.unread}:${a.asks}:${a.now.text}`).join('|');
  useLayoutEffect(() => { setFold(false); }, [h, holds, agents.length]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || fold) return;
    if (el.scrollHeight > el.clientHeight + 1) setFold(true);
  });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const open = fold ? openInRail(agents, onAir) : undefined;
  return (
    <aside ref={box} className={over ? 'loom-arail loom-arail--over' : 'loom-arail'} aria-label="Agents" data-fold={fold || undefined}
      onPointerEnter={onEnter} onPointerLeave={(e) => { if (e.pointerType === 'mouse') onLeave?.(); }}>
      <RailNeeds d={d} />
      {agents.map((a) => (a.id === screen ? <ScreenCard key={a.id} a={a} slot={slot} />
        : fold && a.id !== open ? <RailRow key={a.id} a={a} onOpen={() => go(a.open)} /> : <RailCard key={a.id} a={a} />))}
    </aside>
  );
}

// ---- a phone's Home ------------------------------------------------------------------------------------------------

/** How many agents a phone's Home draws as cards; past it, a line each and one card open (the rail's accordion rule). */
export const PHONE_CARDS_UP_TO = 4;

/**
 * A phone's Home (docs/specs/agent-desk.md, "A phone"): Needs you, then the agents in the same spirit as a desktop's,
 * alphabetical, the viewer's own. Up to four, a card each (face, how it is, what it's on, its last thread, what's new, a
 * composer); past four, a line each, and the one that most wants you open as a card (t-1869: a screen of big cards is
 * a nightmare past a few).
 */
export function PhoneHome({ home, shell }: { home: DeskHomeData; shell: Shell }) {
  const { go } = useEnv();
  const comms = useAgentComms(shell.core.some((p) => p.href === '/comms'));
  const agents = useMemo(() => deskAgents(shell, home, comms), [shell, home, comms]);
  const fold = agents.length > PHONE_CARDS_UP_TO;
  const open = fold ? openInRail(agents, null) : undefined;
  return (
    <section className="loom-phome" aria-label="Home">
      <NeedsBand d={home} />
      {agents.length === 0 && <Nothing title="No agents yet" text="An agent is who does the work here. Make the first one."><Button className="mt-2" onClick={() => go('/new-agent')}>New agent</Button></Nothing>}
      {agents.map((a) => (fold && a.id !== open ? <RailRow key={a.id} a={a} onOpen={() => go(a.open)} /> : <BigCard key={a.id} a={a} flow />))}
    </section>
  );
}
export default PhoneHome;
