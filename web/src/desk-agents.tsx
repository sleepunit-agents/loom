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
import { aboutAttr, type About } from './about';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { ActButton, AgentAvatar, EnvContext, Nothing, useEnv, type Mark, type MarkState } from './blocks';
import { guardedEnv, LIVE_SAYS, useAskLive } from './ask-open';
import { As, type InboxItem } from './views';
import { askerOf, plain } from './plain';
import { markColor } from './look';
import { onLive } from './page';
import { onThreads, threadsNow } from './threads-live';
import { newId } from './comms-id';
import type { Shell, TickerActivity } from './loom';
import './desk-agents.css';
const CardAsk = lazy(() => import('./inbox').then((m) => ({ default: m.CardAsk })));

// ---- what loom says about each agent -----------------------------------------------------------------------------

/** One thing it has going; `href` is loom's link to it (a Comms thread, only for its member: handler.ts atWorkFor). */
type Doing = { text: string; kind?: string; where?: string; since?: string; href?: string;
  /** The step it's on, from the runtime (fresh for 30 s at the producer): its plain label. */
  activity?: { action: string; observedAt?: string } };
type Job = Doing & { id: string; status: 'running' | 'waiting' | 'scheduled' | 'backlog'; at?: string };
type Reading = { label: string; value: string; detail?: string; tone?: string };
/** An agent as Home's page has it (src/ui/handler.ts agentCards). */
export type Card = Mark & { id: string; state?: 'working' | 'available' | 'unavailable' | 'broken'; reason?: string;
  jobs?: Job[]; doing?: Doing[]; problems?: { text: string; tone: 'bad' | 'warn' }[]; seen?: { at: string; where: string }; readings?: Reading[]; steps?: { text: string; at: string; where: string }[];
  moving?: { agent: string; text: string; meta?: string }[];
  /** The system bar's ticker (agent-status 1.2; the live record's, not Home's card). */
  activity?: TickerActivity; activityUnavailable?: boolean };
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
  work: Doing[];
  jobs: Job[];
  steps: { text: string; at: string; where: string }[];
};

/** How an agent is, in a word (precedence: trouble, an ask, work, unavailable, quiet). */
function statusOf(c: Card | undefined, asks: number): { word: string; tone: Tone; face: MarkState } {
  const problems = c?.problems ?? [], doing = c?.doing ?? [];
  const running = c?.jobs?.filter((j) => j.status === 'running').length ?? doing.length;
  if (problems.length) return c?.state === 'broken' ? { word: 'Something’s broken', tone: 'bad', face: 'error' } : { word: 'Needs a look', tone: 'warn', face: 'error' };
  if (asks > 0) return { word: 'Waiting on you', tone: 'ask', face: 'needs-input' };
  if (c?.state === 'working' || running) return { word: running > 1 ? `Working · ${running} things` : 'Working', tone: 'work', face: 'working' };
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
    const active = doing[0] ?? c?.jobs?.find((j) => j.status === 'running');
    const nowLine = problems[0] ? { text: problems[0].text, tone: problems[0].tone }
      : active ? { text: active.text, ...(active.href ? { href: active.href } : {}) }
      : { text: c?.state === 'unavailable' && c.reason ? c.reason : 'Nothing right now' };
    const next = c?.readings?.find((r) => r.label === 'Next');
    const last = k?.last ? { title: k.last.title ?? 'New thread', at: when(k.last.at, now), href: threadHref(k.last.thread) } : undefined;
    const first = k?.first ? { text: k.first.text, href: threadHref(k.first.thread) } : undefined;
    const ask = (home?.stack ?? []).find((i) => i.agent === s.id);
    return {
      id: s.id, label: s.label, mark: s as unknown as Mark, color: markColor(s.bg), status: { word: st.word, tone: st.tone }, face: st.face, now: nowLine,
      ...(next ? { wake: [next.value, next.detail].filter(Boolean).join(' · ') } : {}),
      ...(last ? { last } : {}), unread: k?.unread ?? 0, ...(first ? { first } : {}), asks, ...(ask ? { ask } : {}),
      open: first?.href ?? last?.href ?? '/comms', talking: doing.some((x) => x.kind === 'talk'), work: doing, jobs: c?.jobs ?? [], steps: c?.steps ?? [],
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
  // The member's threads, live (threads-live.ts, t-2027), once App has the set going: then the summary is asked again
  // only when a thread's unread or newest message moves, never on loom's bare "something changed" or a timer, and each
  // card's count is of threads (the owner's decision: unread is counted in threads everywhere).
  const live = useSyncExternalStore(onThreads, threadsNow, () => null);
  const isLive = !!live;
  const moved = live?.moved;
  const getRef = useRef<() => void>(() => {});
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
    getRef.current = get;
    // A burst of changes asks once.
    const soon = () => { clearTimeout(t); t = window.setTimeout(get, 200); };
    get();
    const back = () => { if (document.visibilityState === 'visible') soon(); };
    addEventListener('loom-comms-read', soon);
    document.addEventListener('visibilitychange', back);
    // Not live: as before, on every bare change and every minute.
    const off = isLive ? () => {} : onLive(soon);
    const every = isLive ? undefined : setInterval(get, 60_000);
    return () => { alive = false; clearTimeout(t); off(); clearInterval(every); removeEventListener('loom-comms-read', soon); document.removeEventListener('visibilitychange', back); };
  }, [on, isLive]);
  // Live: asked again when the threads move (its first line, and the thread a card opens, are words the set never holds).
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (on && moved !== undefined) getRef.current(); }, [moved, on]);
  return useMemo(() => (v && live ? Object.fromEntries(Object.entries(v).map(([a, k]) => [a, { ...k, unread: live.byAgent[a] ?? 0, ...(live.byAgent[a] ? {} : { first: undefined }) }])) : v), [v, live]);
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
  const named = (a?: string) => (a && agents[a]?.label) || (a ? a[0].toUpperCase() + a.slice(1) : '');
  const { who, asks } = askerOf(i, named);
  const p = plain(i, who);
  const yesNo = !i.approval && i.needs?.answers === 'yes-no' && !!i.reply;
  const lined = !!(i.needs?.if_yes || i.needs?.if_no);
  const acts = !i.approval && !yesNo && !lined && !i.reply ? (i.actions ?? []) : [];
  const answerable = yesNo || acts.length > 0;
  const { live, check } = useAskLive(answerable ? { k: i.key } : null);
  const env = useMemo(() => guardedEnv(outer, check), [outer, i.key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const say = async (answer: 'yes' | 'no') => {
    if (sending.current || busy || outer.stale || !i.reply) return;
    sending.current = true;
    try {
      if (!(await check())) return;
      setBusy(true);
      await outer.withSource(i.source).send('needs-answer', { ...i.reply.fields, answer });
    } finally { setBusy(false); sending.current = false; }
  };
  const open = () => outer.go(needHref(i));
  const sub = [asks, p.why ?? i.outcome].filter(Boolean).join(' · ');
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
            : yesNo ? <><Button size="sm" disabled={busy || outer.stale} onClick={() => void say('yes')}>Yes</Button>
              <Button size="sm" variant="outline" disabled={busy || outer.stale} onClick={() => void say('no')}>No</Button></>
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

/** A link inside a card: its own page in a tile (the desk's go), and a real link for a new tab. */
function Go({ href, className, children, label }: { href: string; className?: string; children: React.ReactNode; label?: string }) {
  const { go } = useEnv();
  return <a href={href} className={className} aria-label={label} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(href); }}>{children}</a>;
}

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

/** The agreed large card: identity, the full question, then work and wakes. It scrolls inside its desktop box. */
export function BigCard({ a, flow }: { a: DeskAgent; flow?: boolean }) {
  const face = 96;
  return (
    <article className="loom-bigcard" data-tone={a.status.tone} data-size={face} data-flow={flow || undefined} style={{ '--c': a.color } as React.CSSProperties} aria-label={a.label} data-agent={a.id}>
      <div className="loom-bigcard__in">
        <header className="loom-bigcard__identity">
          <Go href={`/a/${a.id}`} className="loom-bigcard__face" label={`Open ${a.label}’s window`}><AgentAvatar a={a.mark} size={face} state={a.face} /></Go>
          <div className="loom-bigcard__info"><span className="loom-bigcard__eb loom-data">{a.status.word}</span>
            <h2 className="loom-bigcard__name">{a.label}{a.asks > 0 && <span className="loom-askb loom-data">ASKS YOU</span>}</h2>
            <Go href={a.open} className="loom-bigcard__link">Open conversation →</Go>
          </div>
        </header>
        {a.ask && <section className="loom-bigcard__question" data-kind="ask" aria-label="Needs your answer">
          <h3>Needs your answer</h3><Suspense fallback={<p>{plain(a.ask, a.label).title}</p>}><CardAsk key={a.ask.key} i={a.ask} who={a.label} /></Suspense>
        </section>}
        <div className="loom-bigcard__columns">
          <div><section aria-label="Current work"><h3>Current work</h3><dl className="loom-bigcard__kv">
            <div data-row="now" data-tone={a.now.tone}><dt>Now</dt><dd>{a.now.href ? <Go href={a.now.href}>{a.now.text}</Go> : a.now.text}</dd></div>
          </dl>{(a.now.tone ? a.work : a.work.slice(1)).map((w, n) => <p key={n} className="loom-bigcard__item">{w.href ? <Go href={w.href}>{w.text}</Go> : w.text}{w.where && <small>{w.where}</small>}</p>)}</section>
          <section aria-label="Recent conversations"><h3>Recent conversations</h3><dl className="loom-bigcard__kv"><div data-row="last"><dt>Last thread</dt><dd>{a.last ? <Go href={a.last.href}>{a.last.title}<span className="loom-bigcard__at"> · {a.last.at}</span></Go> : 'No conversations yet.'}</dd></div></dl>
            <Unread a={a} />
          </section></div>
          <div><section aria-label="Next wakes"><h3>Next wake</h3><dl className="loom-bigcard__kv"><div data-row="wake"><dt>Next wake</dt><dd>{a.wake ?? 'No scheduled wake reported.'}</dd></div></dl></section>
          <section aria-label="Last steps"><h3>Last steps</h3>{a.steps.length ? a.steps.map((s, n) => <p key={n} className="loom-bigcard__item">{s.text}<small>{when(s.at)} · {s.where}</small></p>) : <p className="loom-bigcard__empty">No recent steps.</p>}</section></div>
        </div>
        <Jobs a={a} />
        <Composer a={a} />
      </div>
    </article>
  );
}

/** Both sizes expose the same complete list; waiting and backlog never imply a running body. */
/** The most running jobs a rail card stacks before "+N more". */
const RUNNING_MAX = 3;
/** How long it has run: "4m", "2h". */
const ran = (since: string | undefined, now = Date.now()): string => {
  const t = since ? Date.parse(since) : NaN;
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? 'just started' : m < 120 ? `${m}m` : `${Math.round(m / 60)}h`;
};

/**
 * What an agent is doing now, one box per running job (t-2077; Jonathan, 2026-11-09: each running job is its own
 * "Art is doing X" box, and the card is a list of those): what, where, how long, and the step it's on; a tap opens
 * its thread (a job's opens to watch, t-2043). Only running work: waiting, scheduled and done are the jobs list's.
 */
function Running({ a }: { a: DeskAgent }) {
  const running = a.jobs.filter((j) => j.status === 'running');
  if (!running.length) return null;
  const step = (j: Job) => a.work.find((d) => d.href && d.href === j.href)?.activity?.action;
  return (
    <ul className="loom-doing" aria-label={`What ${a.label} is doing`} style={{ '--c': a.color } as React.CSSProperties}>
      {running.slice(0, RUNNING_MAX).map((j) => {
        const inner = <><b className="loom-doing__who loom-data">{a.label.split(' ')[0]} is doing</b><span className="loom-doing__what">{j.text}</span>
          <small className="loom-doing__meta loom-data">{[j.where, ran(j.since), step(j)].filter(Boolean).join(' · ')}</small></>;
        return <li key={j.id} {...aboutAttr(jobAbout(a, j))}>{j.href ? <Go href={j.href} className="loom-doing__box">{inner}</Go> : <span className="loom-doing__box">{inner}</span>}</li>;
      })}
      {running.length > RUNNING_MAX && <li className="loom-doing__more loom-data">+{running.length - RUNNING_MAX} more</li>}
    </ul>
  );
}

/** A job as Chat about this attaches it (about.ts): the runtime's job, its page unless that's its own thread, its agent. */
const jobAbout = (a: DeskAgent, j: Job): About => {
  const page = j.href && !j.href.startsWith('/comms') && /^\/[\w./~-]+$/.test(j.href) ? j.href.slice(1) : undefined;
  return { label: j.text.slice(0, 120), ref: `runtime:job/${j.id.replace(/[^A-Za-z0-9._@/#:-]/g, '-').slice(0, 150)}`, ...(page ? { page } : {}), agent: a.id };
};

function Jobs({ a, compact }: { a: DeskAgent; compact?: boolean }) {
  if (!a.jobs.length) return null;
  const list = <ul className="loom-jobs">{a.jobs.map((j) => <li key={j.id} data-job-status={j.status} {...aboutAttr(jobAbout(a, j))}>
    <small>{({ running: 'Running', waiting: 'Waiting', scheduled: 'Scheduled', backlog: 'Backlog' })[j.status]}</small>
    {j.href ? <Go href={j.href}>{j.text}</Go> : <span>{j.text}</span>}{j.at && <small>{when(j.at)}</small>}
  </li>)}</ul>;
  return compact ? <details className="loom-jobs-fold"><summary>All jobs · {a.jobs.length}</summary>{list}</details>
    : <section aria-label="All jobs"><h3>All jobs · {a.jobs.length}</h3>{list}</section>;
}

function Unread({ a }: { a: DeskAgent }) {
  const { go } = useEnv();
  return a.unread ? <button type="button" className="loom-bigcard__strip" data-kind="unread" onClick={() => go(a.open)}>
    <b className="loom-data">{a.unread} new</b><span>{a.first?.text ? `‘${a.first.text}’` : 'Open the thread to read it'}</span></button>
    : a.ask ? null : <span className="loom-bigcard__strip" data-kind="none">No new messages</span>;
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
    <div className="loom-rcard-wrap"><button type="button" className="loom-rcard" data-tone={a.status.tone} data-agent={a.id} style={{ '--c': a.color } as React.CSSProperties}
      onClick={() => go(a.open)} aria-label={`${a.label}: ${what}. Open the thread`}>
      <span className="loom-rcard__top">
        <span className="loom-rcard__face"><AgentAvatar a={a.mark} size={96} state={a.face} /></span>
        <span className="loom-rcard__who"><b>{a.label}</b><span className="loom-rcard__st loom-data"><span className="loom-dot" aria-hidden />{a.status.word}</span></span>
      </span>
      {/* Each running job is its own box (t-2077, under the button); the NOW line says what it's on only when none runs. */}
      {!a.jobs.some((j) => j.status === 'running') && <span className="loom-rcard__now" data-tone={a.now.tone}><i className="loom-data">NOW</i> {a.now.text}</span>}
      {a.asks > 0 && <span className="loom-askb loom-data">ASKS YOU</span>}
      {a.unread ? <span className="loom-rcard__ur"><b className="loom-data">{a.unread}</b><span>{a.first?.text ?? 'New in the thread'}</span></span>
        : <span className="loom-rcard__ur" data-none="">No new messages</span>}
    </button><Running a={a} /><Jobs a={a} compact /></div>
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
      <span className="loom-rcard__ur" data-none="">Thread open in Comms</span><Jobs a={a} compact />
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
