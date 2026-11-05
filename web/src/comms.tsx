// Comms (docs/specs/comms.md, "The app"): talking with your own agents, in threads. Its own chunk, loaded only when
// the Comms view opens, so the first page carries none of it.
//
// What loom answers here (src/ui/comms-routes.ts): GET /comms is the list, GET /comms/<thread> the thread, each a view
// (`view: 'comms'`) with the page's chrome; the thread's live stream is /comms/<thread>/events ({seq} only), and the
// rest are its routes (send, title, pin, archive, stop, read, delete). Every word a thread shows comes from those.
//
// On a phone: the list, then a thread pushed over it, its composer above the dock and clear of the keyboard. On a
// desktop: the two side by side in the app's window. Each thread has its comm screen: the agent's pixel portrait in a
// Neon OS frame, its face following the thread's real state (comms.md, "The comm screen").
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './comms.css';
import { AgentAvatar, useEnv, type Mark } from './blocks';
import { markColor } from './look';
import { reducedMotion } from './access';
import { bits, githubUrl } from './plain';
import { prose } from '../../src/ui/prose';
import { act, type Chrome } from './loom';
import type { FaceState } from './face';

const PixelFace = lazy(() => import('./pixel-face'));
const DrawnFace = lazy(() => import('./face'));

// ---- what loom answers ---------------------------------------------------------------------------

type ThreadState = { working: boolean; working_since: string | null; queued: boolean; failed: boolean };
export type Thread = {
  id: string; agent: string; title: string | null; titled_by: string | null; project: string | null; pinned: boolean; archived: string | null;
  opened: string; last: string; read_seq: number; channel: number; conversation: string; state: ThreadState; unread?: boolean; last_seq?: number;
};
export type Msg = { seq: number; at: string; kind: 'message' | 'reply' | 'card' | 'ask' | 'error'; from: string; id: string; text: string | null;
  card: Record<string, unknown> | null; run: string | null; delivered: boolean | null };
/** A pending ask from this thread's agent, asked from this thread (comms.md, "Asks inline"): Allow once and Deny. */
export type ThreadAsk = { id: string; piece: string; text: string; why?: string; if_yes?: string; if_no?: string; fine?: string; at?: string;
  actions: Array<{ action: string; label: string; tone?: string; confirm?: string; fields?: Record<string, string> }> };
export type CommsData = { view: 'comms'; which: 'list' | 'thread'; chrome: Chrome; member: string; asks?: ThreadAsk[];
  threads?: Thread[]; unread?: number; agents?: string[]; thread?: Thread; messages?: Msg[]; earlier?: { at: string; summary: string }[];
  /** household.json's github: a bare repo#N in a reply links under it. */
  github?: string };

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A message's id: 16 characters of RFC 4648 base32, lowercased (comms.md, "The message id"). */
export function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => B32[x & 31]).join('');
}

async function post(path: string, csrf: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  try {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ ...body, _csrf: csrf }) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j as Record<string, unknown> };
  } catch { return { ok: false, status: 0, body: { error: 'loom can\'t be reached right now' } }; }
}
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    return r.ok ? (await r.json()) as T : null;
  } catch { return null; }
}

const agentName = (agent: string, marks: Record<string, Mark>) => marks[agent]?.label ?? agent[0].toUpperCase() + agent.slice(1);
const hhmm = (iso: string) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : ''; };
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return !Number.isFinite(m) ? '' : m < 1 ? 'now' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

// ---- what an agent says: markdown, with loom's own links (comms.md, section 6) ---------------------

const INSIDE = 'https://loom.invalid/';
/**
 * A reply's words as markdown with its references made links: t-N (the task), owner/repo#N (GitHub), cv-… (the
 * conversation). note:<path> is set as code (loom has no note page yet). Links go only to https or inside loom: the
 * renderer (src/ui/prose.ts) drops anything else, and an http:// link is left as its words.
 */
export function replyHtml(text: string, owner?: string): string {
  // As the Inbox's sheet links them (inbox.tsx Ref): a task's page in the tasks piece, task/<id>.
  const linked = bits(text, owner).map((b) => b.t === 'task' ? `[${b.id}](${INSIDE}p/tasks/task/${b.id})`
    : b.t === 'pr' ? `[${b.repo}#${b.n}](${githubUrl(b.repo, b.n)})`
      : b.t === 'conv' ? `[${b.id}](${INSIDE}conversation/${b.id})`
        : b.t === 'path' ? `\`${b.s}\`` : b.s).join('')
    .replace(/(^|\s)note:([\w./-]+)/g, (_m, sp: string, p: string) => `${sp}\`note:${p}\``);
  return prose(linked)
    .replace(/<a [^>]*href="http:\/\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g, '$1')
    // Inside loom only for the pages a reply may link to, by exact shape; any other inside-looking link (one an agent
    // wrote to reach //evil.com, /\\host or ..) is left as its words.
    .replace(/<a ([^>]*)href="https:\/\/loom\.invalid\/([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (_m, pre: string, path: string, post: string, words: string) =>
      (insidePath(path) ? `<a ${pre}data-inside="" href="/${path}"${post}>${words}</a>` : words));
}

/** The loom pages a reply may link to: a task's, a conversation's. Nothing with a scheme, a leading slash, .. or //. */
const INSIDE_PAGES = /^(?:p\/tasks\/task\/t-\d{1,9}|conversation\/cv-[0-9a-f]{12})$/;
export const insidePath = (path: string) => INSIDE_PAGES.test(path);

/** Whether an inside link really stays inside: this origin, and one of the allowed pages. */
export function staysInside(href: string, here: string = location.href): boolean {
  try {
    const u = new URL(href, here);
    return u.origin === new URL(here).origin && insidePath(u.pathname.slice(1)) && !u.search && !u.hash;
  } catch { return false; }
}

function Reply({ text, owner }: { text: string; owner?: string }) {
  const { go } = useEnv();
  const html = useMemo(() => replyHtml(text, owner), [text, owner]);
  return (
    <div className="loom-prose comms-reply" dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a[data-inside]');
        if (!a || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        const href = a.getAttribute('href') ?? '';
        if (staysInside(href)) go(href);
      }} />
  );
}

// ---- the comm screen (comms.md, "The comm screen") ------------------------------------------------

/** How many talking beats a reply plays: one per 150 characters, 1 to 4 (comms.md, "How talking plays"). */
export const talkBeats = (chars: number) => Math.min(4, Math.max(1, Math.ceil(chars / 150)));

/**
 * The face state a thread shows, by precedence (comms.md's table): an error, then an ask pending, then talking, then
 * working, then thinking (a message is with the agent and nothing's come back yet), else idle.
 */
export function faceOf(s: { failed: boolean; asking: boolean; talking: boolean; working: boolean; waitingOnAgent: boolean }): FaceState {
  if (s.failed) return 'error';
  if (s.asking) return 'needs-input';
  if (s.talking) return 'talking';
  if (s.working) return 'working';
  if (s.waitingOnAgent) return 'thinking';
  return 'idle';
}

type Link = 'ok' | 'lost' | 'none';
const LINK_WORDS: Record<Link, string> = { ok: 'LINK OK', lost: 'LINK LOST', none: 'NO CARRIER' };

function CommScreen({ agent, mark, channel, face: base, talk, link, you, compact, wide }: {
  agent: string; mark: Mark; channel: number; face: FaceState; talk: { n: number; key: number } | null; link: Link; you?: string; compact: boolean; wide: boolean;
}) {
  const [signal, setSignal] = useState(false);
  const [talkNow, setTalkNow] = useState<{ n: number; key: number } | undefined>();
  // The talking run's phase, as the face plays it (talking, then done, then back to the thread's own state).
  const [phase, setPhase] = useState<'talking' | 'complete' | null>(null);
  const [anim, setAnim] = useState<string | undefined>();
  const sprite = mark.face?.sprite;
  // A reply lands: the signal's static and roll for 250 ms, then the talking beats (none of it with reduced motion).
  useEffect(() => {
    if (!talk || reducedMotion()) return;
    setSignal(true);
    const t = setTimeout(() => {
      setSignal(false); setTalkNow(talk);
      // A drawn face has no beats to follow: its run is timed, a beat about 1.5 s and a breath about 0.8 s, then done.
      if (!sprite) setPhase('talking');
    }, 250);
    return () => clearTimeout(t);
  }, [talk?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sprite || !phase || !talkNow) return;
    const ms = phase === 'talking' ? talkNow.n * 1530 + (talkNow.n - 1) * 800 : 900;
    const t = setTimeout(() => setPhase(phase === 'talking' ? 'complete' : null), ms);
    return () => clearTimeout(t);
  }, [phase, talkNow, sprite]);
  const onShown = useCallback((st: FaceState) => setPhase(st === 'talking' ? 'talking' : st === 'complete' ? 'complete' : null), []);
  // An error, and an ask waiting, win over talking (comms.md's precedence); else the run's phase, else the thread's state.
  const face: FaceState = base === 'error' || base === 'needs-input' ? base : phase ?? base;
  // Whole-number scales only, 2x at least (comms.md, "The comm screen"): the compact strip shrinks its box, not the pixels.
  const scale = 2;
  const size = 96 * scale;
  const small = <AgentAvatar a={mark} size={32} />;
  const drawn = (
    <Suspense fallback={<span className="comms-screen__initial">{mark.label[0]}</span>}>
      <DrawnFace bg={mark.bg} shape={mark.face?.shape as never} eyes={mark.face?.eyes as never} state={face} size={compact ? 96 : 160} label={mark.label} dark />
    </Suspense>
  );
  const name = mark.label.toUpperCase();
  const meter = link === 'ok' ? 4 : link === 'lost' ? 1 : 0;
  return (
    <section className="comms-screen" data-compact={compact || undefined} data-face={face} data-anim={sprite ? anim : undefined} data-signal={signal ? 'on' : undefined}
      style={{ '--c': markColor(mark.bg) } as React.CSSProperties} aria-label={`${mark.label}'s comm screen`}>
      <div className="comms-screen__frame">
        <div className="comms-screen__glass">
          {compact ? small : sprite ? (
            <Suspense fallback={drawn}>
              <PixelFace sprite={sprite} state={phase ?? base} size={size} scale={scale} label={mark.label} fallback={drawn} talk={talkNow} onShown={onShown} onFrom={setAnim} />
            </Suspense>
          ) : drawn}
          <span className="comms-screen__scan" aria-hidden />
          {signal && <span className="comms-screen__static" aria-hidden />}
        </div>
        <footer className="comms-screen__label loom-data">
          <span>{name} · CH {String(channel).padStart(2, '0')} · {LINK_WORDS[link]}</span>
          <span className="comms-screen__meter" aria-label={`signal ${meter} of 4`}>{[1, 2, 3, 4].map((i) => <i key={i} data-on={i <= meter || undefined} />)}</span>
        </footer>
      </div>
      {you && wide && (
        <div className="comms-screen__you">
          <span className="comms-screen__you-face" aria-hidden>{you[0].toUpperCase()}</span>
          <span className="loom-data">YOU · {you.toUpperCase()}</span>
        </div>
      )}
      <span className="sr-only">{agent}</span>
    </section>
  );
}

// ---- the list ----------------------------------------------------------------------------------

function ThreadRowView({ t, marks, current, onOpen, onArchive, onPin }: { t: Thread; marks: Record<string, Mark>; current: boolean; onOpen: () => void; onArchive: () => void; onPin: () => void }) {
  const press = useRef<number>(0);
  const touch = useRef<{ x: number; y: number } | null>(null);
  // A swipe or a long press acted already: the tap that ends it doesn't open the thread too.
  const acted = useRef(false);
  const mark = marks[t.agent];
  return (
    <li className="comms-row" data-current={current || undefined} data-unread={t.unread || undefined}
      onTouchStart={(e) => { acted.current = false; touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; press.current = window.setTimeout(() => { acted.current = true; onPin(); }, 600); }}
      onTouchMove={() => clearTimeout(press.current)}
      onTouchEnd={(e) => {
        clearTimeout(press.current);
        const s = touch.current; touch.current = null;
        if (s && s.x - e.changedTouches[0].clientX > 80 && Math.abs(s.y - e.changedTouches[0].clientY) < 40) { acted.current = true; onArchive(); }
      }}>
      <button type="button" className="comms-row__btn" onClick={() => { if (acted.current) { acted.current = false; return; } onOpen(); }}>
        <span className="comms-row__face" style={{ '--c': mark ? markColor(mark.bg) : undefined } as React.CSSProperties}>{(mark?.label ?? t.agent)[0]}</span>
        <span className="comms-row__main">
          <span className="comms-row__title">{t.title ?? `New thread with ${agentName(t.agent, marks)}`}</span>
          <span className="comms-row__sub loom-data">{t.state.working ? 'working…' : `CH ${String(t.channel).padStart(2, '0')}${t.project ? ` · ${t.project}` : ''}`}</span>
        </span>
        <span className="comms-row__time loom-data">{ago(t.last)}</span>
        {t.pinned && <span className="comms-row__pin" aria-label="pinned">▲</span>}
        {t.unread && <span className="comms-row__dot" aria-label="unread" />}
      </button>
    </li>
  );
}

function ThreadList({ threads, marks, current, csrf, onOpen, onNew, reload }: { threads: Thread[]; marks: Record<string, Mark>; current?: string; csrf: string; onOpen: (id: string) => void; onNew: () => void; reload: () => void }) {
  const [archived, setArchived] = useState<Thread[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => { if (showArchived) void getJson<{ threads: Thread[] }>('/comms?archived=1').then((r) => setArchived(r?.threads ?? [])); }, [showArchived]);
  const groups = useMemo(() => {
    const pinned = threads.filter((t) => t.pinned), unread = threads.filter((t) => !t.pinned && t.unread), rest = threads.filter((t) => !t.pinned && !t.unread);
    return [['Pinned', pinned], ['Unread', unread], ['Threads', rest]] as const;
  }, [threads]);
  const act = async (t: Thread, verb: string) => { await post(`/comms/${t.id}/${verb}`, csrf); reload(); };
  const list = showArchived ? [['Archived', archived ?? []] as const] : groups;
  return (
    <nav className="comms-list" aria-label="Threads">
      <header className="comms-list__head">
        <h2 className="loom-data">COMMS</h2>
        <button type="button" className="comms-new" onClick={onNew}>+ New thread</button>
      </header>
      {list.map(([label, rows]) => rows.length ? (
        <div key={label} className="comms-group">
          <h3 className="comms-group__label loom-data">{label.toUpperCase()}</h3>
          <ul>{rows.map((t) => <ThreadRowView key={t.id} t={t} marks={marks} current={t.id === current} onOpen={() => onOpen(t.id)}
            onArchive={() => void act(t, t.archived ? 'unarchive' : 'archive')} onPin={() => void act(t, t.pinned ? 'unpin' : 'pin')} />)}</ul>
        </div>
      ) : null)}
      {!threads.length && !showArchived && <p className="comms-empty">No threads yet. Start one with one of your agents.</p>}
      <button type="button" className="comms-archived" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Back to threads' : 'Archived'}</button>
    </nav>
  );
}

// ---- the composer ------------------------------------------------------------------------------

/** Keeps the composer clear of the phone's keyboard: the visual viewport's bottom inset, as --comms-kb. */
function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const f = () => document.documentElement.style.setProperty('--comms-kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    f();
    vv.addEventListener('resize', f); vv.addEventListener('scroll', f);
    return () => { vv.removeEventListener('resize', f); vv.removeEventListener('scroll', f); document.documentElement.style.removeProperty('--comms-kb'); };
  }, []);
}

function Composer({ onSend, disabled, accent, placeholder }: { onSend: (text: string) => Promise<boolean>; disabled?: boolean; accent?: string; placeholder: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const a = area.current; if (a) { a.style.height = 'auto'; a.style.height = `${Math.min(a.scrollHeight, 180)}px`; } }, [text]);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    if (await onSend(t)) setText('');
    setBusy(false);
  };
  return (
    <form className="comms-composer" style={{ '--c': accent } as React.CSSProperties} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <textarea ref={area} rows={1} value={text} disabled={disabled} placeholder={placeholder} aria-label="Message" enterKeyHint="send"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <button type="submit" disabled={disabled || busy || !text.trim()} className="comms-composer__send">Send</button>
    </form>
  );
}

// ---- one thread ----------------------------------------------------------------------------------

function Message({ m, marks, agent, owner }: { m: Msg; marks: Record<string, Mark>; agent: string; owner?: string }) {
  const who = m.kind === 'message' ? 'you' : m.from === 'loom' ? 'loom' : agentName(m.from, marks).toLowerCase();
  if (m.kind === 'error') return <li className="comms-msg comms-msg--error" role="status"><span className="loom-data">{hhmm(m.at)} · loom</span><p>{m.text}</p></li>;
  if (m.kind === 'ask') return <li className="comms-msg comms-msg--ask"><span className="loom-data">{hhmm(m.at)} · {who}</span><p>{agentName(agent, marks)} is asking you something: it's in your Inbox.</p></li>;
  const mine = m.kind === 'message';
  return (
    <li className={`comms-msg ${mine ? 'comms-msg--mine' : 'comms-msg--agent'}`} data-undelivered={mine && m.delivered === false ? '' : undefined}>
      <span className="comms-msg__meta loom-data">{!mine && marks[m.from] && <AgentAvatar a={marks[m.from]} size={22} className="comms-msg__face" />}{hhmm(m.at)} · {who}</span>
      {m.text === null ? <p className="comms-msg__gone">(older than this thread keeps)</p> : mine ? <p className="comms-msg__text">{m.text}</p> : <Reply text={m.text} owner={owner} />}
    </li>
  );
}

/** A run's activity cards, one line until opened (comms.md, "The look"). */
function Steps({ cards }: { cards: Msg[] }) {
  const [open, setOpen] = useState(false);
  const newest = cards[cards.length - 1];
  return (
    <li className="comms-steps" data-open={open || undefined}>
      <button type="button" className="comms-steps__line loom-data" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} {cards.length} step{cards.length === 1 ? '' : 's'} · {newest.text ?? 'a step'}
      </button>
      {open && <ol>{cards.map((c) => <li key={c.seq} data-state={String(c.card?.state ?? '')}><span className="loom-data">{String(c.card?.state ?? '') === 'failed' ? '✕' : String(c.card?.state ?? '') === 'running' ? '…' : '✓'}</span> {c.text}</li>)}</ol>}
    </li>
  );
}

/** Messages, with each run's cards gathered into one line where the run's first card was. */
function grouped(messages: Msg[]): Array<{ key: string; msg?: Msg; cards?: Msg[] }> {
  const out: Array<{ key: string; msg?: Msg; cards?: Msg[] }> = [];
  const byRun = new Map<string, Msg[]>();
  for (const m of messages) {
    if (m.kind !== 'card') { out.push({ key: `m${m.seq}`, msg: m }); continue; }
    const run = m.run ?? 'run';
    let list = byRun.get(run);
    if (!list) { list = []; byRun.set(run, list); out.push({ key: `r${run}`, cards: list }); }
    list.push(m);
  }
  return out;
}

function ThreadPane({ initial, marks, member, csrf, wide, onBack, onChanged, github }: {
  initial: { thread: Thread; messages: Msg[]; earlier?: { at: string; summary: string }[]; asks?: ThreadAsk[] }; marks: Record<string, Mark>; member: string; csrf: string; wide: boolean; github?: string;
  onBack: () => void; onChanged: () => void;
}) {
  const [thread, setThread] = useState(initial.thread);
  const [messages, setMessages] = useState(initial.messages);
  const [asks, setAsks] = useState<ThreadAsk[]>(initial.asks ?? []);
  const [link, setLink] = useState<Link>(initial.thread.state.failed ? 'none' : 'ok');
  const [talk, setTalk] = useState<{ n: number; key: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [compact, setCompact] = useState(false);
  const [now, setNow] = useState(Date.now());
  const last = useRef(initial.messages.at(-1)?.seq ?? 0);
  const seenReply = useRef(initial.messages.filter((m) => m.kind === 'reply').at(-1)?.seq ?? 0);
  const bottom = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const mark = marks[thread.agent] ?? { label: agentName(thread.agent, marks), bg: 'pink', fg: '#000' };
  useKeyboardInset();

  // New messages: fetched after the last seq we have, once the stream says the thread moved.
  const pull = useCallback(async () => {
    const r = await getJson<{ thread: Thread; messages: Msg[]; asks?: ThreadAsk[] }>(`/comms/${thread.id}/since/${last.current}`);
    if (!r) return;
    setThread(r.thread);
    setAsks(r.asks ?? []);
    if (r.thread.state.failed) setLink('none');
    if (!r.messages.length) return;
    last.current = r.messages.at(-1)!.seq;
    setMessages((ms) => {
      const kept = new Map(ms.map((m) => [m.seq, m]));
      for (const m of r.messages) kept.set(m.seq, m);
      return [...kept.values()].sort((a, b) => a.seq - b.seq);
    });
    const reply = r.messages.filter((m) => m.kind === 'reply' && m.seq > seenReply.current).at(-1);
    if (reply) {
      seenReply.current = reply.seq;
      // The beats for what landed now; the player adds them to a run already going and stops at 4 (PIXEL.talkMax).
      const n = r.messages.filter((m) => m.kind === 'reply').reduce((k, m) => k + talkBeats((m.text ?? '').length), 0);
      setTalk({ n, key: reply.seq });
      setLink('ok');
    }
    onChanged();
  }, [thread.id, onChanged]);

  // The thread's own stream: {seq} only (comms.md, "Live"); a dropped one says so and catches up when it's back.
  useEffect(() => {
    let es: EventSource | null = null;
    let stop = false;
    const open = () => {
      if (stop) return;
      es = new EventSource(`/comms/${thread.id}/events?from=${last.current}`);
      es.addEventListener('message', () => { void pull(); });
      es.onopen = () => { setLink((l) => (l === 'none' ? l : 'ok')); void pull(); };
      es.onerror = () => { setLink((l) => (l === 'none' ? l : 'lost')); };
    };
    open();
    return () => { stop = true; es?.close(); };
  }, [thread.id, pull]);

  // Read: while the thread is on screen and the page visible, now and every 30 s (that's also "in front" for push).
  useEffect(() => {
    // And a look for asks every 30 s: an approval reaches loom's manifests on its own clock, not the thread's stream.
    const read = () => { if (document.visibilityState === 'visible') { void post(`/comms/${thread.id}/read`, csrf, { seq: last.current }); void pull(); } };
    read();
    const t = setInterval(read, 30_000);
    document.addEventListener('visibilitychange', read);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', read); };
  }, [thread.id, csrf, messages.length, pull]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);
  // The phone's strip collapses to the small avatar once the messages scroll under it.
  useEffect(() => {
    if (wide || !top.current) return;
    const io = new IntersectionObserver(([e]) => setCompact(!e.isIntersecting));
    io.observe(top.current);
    return () => io.disconnect();
  }, [wide]);
  useEffect(() => { if (!thread.state.working) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [thread.state.working]);

  const send = async (text: string) => {
    const id = newId();
    const r = await post(`/comms/${thread.id}/send`, csrf, { id, text });
    if (!r.ok && r.status !== 503) { alert(String(r.body.error ?? 'That didn\'t send.').replace(/^[a-z-]+: /, '')); return false; }
    await pull();
    return true;
  };
  const resend = async (m: Msg) => { if (m.text) { await post(`/comms/${thread.id}/send`, csrf, { id: m.id, text: m.text }); await pull(); } };
  const rename = async () => {
    const title = prompt('Name this thread', thread.title ?? '');
    if (title === null || !title.trim()) return;
    const r = await post(`/comms/${thread.id}/title`, csrf, { title: title.trim().slice(0, 60) });
    if (r.ok) { setThread(r.body.thread as Thread); onChanged(); }
  };
  const verb = async (v: string) => {
    setMenu(false);
    if (v === 'delete' && !confirm('Delete this thread and its words? This can\'t be undone.')) return;
    await post(`/comms/${thread.id}/${v}`, csrf);
    onChanged();
    if (v === 'delete' || v === 'archive') onBack();
    else { const r = await getJson<{ thread: Thread }>(`/comms/${thread.id}/since/${last.current}`); if (r) setThread(r.thread); }
  };
  const project = async () => {
    setMenu(false);
    const p = prompt('File under which project? (its slug; empty to clear)', thread.project ?? '');
    if (p === null) return;
    const r = await post(`/comms/${thread.id}/project`, csrf, { project: p.trim() || null });
    if (r.ok) setThread(r.body.thread as Thread); else alert(String(r.body.error ?? '').replace(/^[a-z-]+: /, ''));
  };

  const lastMine = messages.filter((m) => m.kind === 'message').at(-1);
  const lastReply = messages.filter((m) => m.kind === 'reply').at(-1);
  const waitingOnAgent = !!lastMine && lastMine.delivered !== false && (!lastReply || lastReply.seq < lastMine.seq);
  // An ask waiting on you wins over everything but an error (comms.md's precedence).
  const face = faceOf({ failed: thread.state.failed, asking: asks.length > 0, talking: false, working: thread.state.working, waitingOnAgent });
  const since = thread.state.working_since ? Math.max(0, Math.round((now - Date.parse(thread.state.working_since)) / 1000)) : 0;
  const swept = messages.some((m) => m.text === null && m.kind !== 'error');
  const screen = <CommScreen agent={thread.agent} mark={mark} channel={thread.channel} face={face} talk={talk} link={link} you={member} compact={!wide && compact} wide={wide} />;

  return (
    <article className="comms-thread" data-wide={wide || undefined}>
      <header className="comms-thread__head">
        {!wide && <button type="button" className="comms-back" onClick={onBack} aria-label="Back to threads">‹</button>}
        <button type="button" className="comms-thread__title" onClick={rename} title="Rename">{thread.title ?? `New thread with ${mark.label}`}</button>
        {thread.project && <span className="comms-thread__project loom-data">{thread.project}</span>}
        {thread.state.working && <button type="button" className="comms-stop" onClick={() => void verb('stop')}>Stop</button>}
        <button type="button" className="comms-menu" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Thread menu">⋯</button>
        {menu && (
          <div className="comms-menu__list" role="menu">
            <button role="menuitem" type="button" onClick={() => void verb(thread.pinned ? 'unpin' : 'pin')}>{thread.pinned ? 'Unpin' : 'Pin'}</button>
            <button role="menuitem" type="button" onClick={() => void verb(thread.archived ? 'unarchive' : 'archive')}>{thread.archived ? 'Unarchive' : 'Archive'}</button>
            <button role="menuitem" type="button" onClick={() => void project()}>Project</button>
            <button role="menuitem" type="button" className="comms-danger" onClick={() => void verb('delete')}>Delete</button>
          </div>
        )}
      </header>
      <div className="comms-thread__body">
        {!wide && <div ref={top} className="comms-thread__strip">{screen}</div>}
        <ol className="comms-msgs" aria-live="polite">
          {swept && initial.earlier?.length ? (
            <li className="comms-earlier">
              <span className="loom-data">EARLIER, AS {mark.label.toUpperCase()} SUMMED IT UP</span>
              {initial.earlier.map((d) => <p key={d.at}>{d.summary}</p>)}
            </li>
          ) : null}
          {grouped(messages).map((g) => g.cards ? <Steps key={g.key} cards={g.cards} /> : (
            <Message key={g.key} m={g.msg!} marks={marks} agent={thread.agent} owner={github} />
          ))}
          {asks.map((a) => <AskCard key={a.id} a={a} csrf={csrf} agentName={mark.label} onAnswered={() => void pull()} />)}
          {lastMine?.delivered === false && <li className="comms-resend"><button type="button" onClick={() => void resend(lastMine)}>Not delivered · Send again</button></li>}
          {thread.state.working && <li className="comms-working loom-data">{mark.label.toUpperCase()} · working · {Math.floor(since / 60)}:{String(since % 60).padStart(2, '0')}</li>}
          {link === 'lost' && <li className="comms-msg comms-msg--error" role="status"><p>Reconnecting…</p></li>}
          <div ref={bottom} />
        </ol>
        {wide && <aside className="comms-thread__side">{screen}</aside>}
      </div>
      <Composer onSend={send} disabled={!!thread.archived} accent={markColor(mark.bg)} placeholder={thread.archived ? 'Archived: unarchive it to write here' : `Message ${mark.label}`} />
    </article>
  );
}

/** An ask, answered here as the Inbox would answer it: its piece's own action, with this page's form token. */
function AskCard({ a, csrf, agentName: who, onAnswered }: { a: ThreadAsk; csrf: string; agentName: string; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const answer = async (b: ThreadAsk['actions'][number]) => {
    // A danger button (Deny) or one that says so asks first, as the Inbox's does (blocks.tsx ActButton).
    if ((b.tone === 'danger' || b.confirm) && !confirm(b.confirm ?? `${b.label}: are you sure?`)) return;
    setBusy(true);
    const r = await act({ source: { id: a.piece, base: `/p/${a.piece}/` }, path: '', query: {}, csrf }, csrf, b.action, b.fields ?? {});
    setSaid(r.message || (r.ok ? 'Answered.' : 'That didn\'t go through.'));
    setBusy(false);
    if (r.ok) onAnswered();
  };
  const yes = a.actions.find((b) => b.tone === 'primary') ?? a.actions[0];
  const no = a.actions.find((b) => b.tone === 'danger');
  return (
    <li className="comms-ask" role="group" aria-label={`${who} asks`}>
      <span className="loom-data comms-ask__who">{who.toUpperCase()} ASKS</span>
      <p className="comms-ask__text">{a.text}</p>
      {a.why && <p className="comms-ask__why">{a.why}</p>}
      {(a.if_yes || a.if_no) && (
        <dl className="comms-ask__either">
          {a.if_yes && <><dt>If you allow</dt><dd>{a.if_yes}</dd></>}
          {a.if_no && <><dt>If you deny</dt><dd>{a.if_no}</dd></>}
        </dl>
      )}
      {a.fine && <p className="comms-ask__fine loom-data">Exactly what this allows: {a.fine}</p>}
      {said ? <p className="comms-ask__said">{said}</p> : (
        <div className="comms-ask__buttons">
          <button type="button" disabled={busy} className="comms-ask__yes" onClick={() => void answer(yes)}>{yes.label}</button>
          {no && <button type="button" disabled={busy} className="comms-ask__no" onClick={() => void answer(no)}>{no.label}</button>}
        </div>
      )}
    </li>
  );
}

// ---- a new thread ------------------------------------------------------------------------------

function NewThread({ agents, marks, csrf, onOpened, onBack, wide }: { agents: string[]; marks: Record<string, Mark>; csrf: string; onOpened: (id: string) => void; onBack: () => void; wide: boolean }) {
  const [agent, setAgent] = useState(agents[0]);
  const [error, setError] = useState<string | null>(null);
  const id = useRef(newId());
  useKeyboardInset();
  const send = async (text: string) => {
    const r = await post('/comms/new', csrf, { agent, id: id.current, text });
    if (!r.ok) { setError(String(r.body.error ?? 'That didn\'t start.').replace(/^[a-z-]+: /, '')); return false; }
    onOpened((r.body.thread as Thread).id);
    return true;
  };
  return (
    <article className="comms-thread comms-new-thread" data-wide={wide || undefined}>
      <header className="comms-thread__head">
        {!wide && <button type="button" className="comms-back" onClick={onBack} aria-label="Back to threads">‹</button>}
        <span className="comms-thread__title">New thread</span>
      </header>
      <div className="comms-pick" role="radiogroup" aria-label="Who with">
        {agents.map((a) => (
          <button key={a} type="button" role="radio" aria-checked={a === agent} className="comms-pick__agent" data-on={a === agent || undefined}
            style={{ '--c': marks[a] ? markColor(marks[a].bg) : undefined } as React.CSSProperties} onClick={() => setAgent(a)}>
            <span className="comms-row__face">{agentName(a, marks)[0]}</span>{agentName(a, marks)}
          </button>
        ))}
      </div>
      {error && <p className="comms-msg comms-msg--error" role="alert">{error}</p>}
      <Composer onSend={send} accent={marks[agent] ? markColor(marks[agent].bg) : undefined} placeholder={`Message ${agentName(agent, marks)}`} />
    </article>
  );
}

// ---- the view ----------------------------------------------------------------------------------

export function CommsView({ data }: { data: CommsData }) {
  const { go, wide } = useEnv();
  const csrf = data.chrome.csrf;
  const marks = useMemo(() => Object.fromEntries((data.chrome.shell?.agents ?? []).map((a) => [a.id, a as unknown as Mark])), [data.chrome]);
  const [threads, setThreads] = useState<Thread[]>(data.threads ?? []);
  const [agents, setAgents] = useState<string[]>(data.agents ?? []);
  const [making, setMaking] = useState(false);
  const reload = useCallback(() => { void getJson<{ threads: Thread[]; agents: string[] }>('/comms').then((r) => { if (r) { setThreads(r.threads); setAgents(r.agents); } }); }, []);
  // A thread's view doesn't carry the list: on a desktop (two panes) or for New thread, it's fetched beside it.
  useEffect(() => { if (data.which === 'thread' || !data.threads) reload(); }, [data.which, data.threads, reload]);
  useEffect(() => { setMaking(false); }, [data.thread?.id]);
  const open = (id: string) => go(`/comms/${id}`);
  const back = () => { setMaking(false); go('/comms'); };
  const pane = making ? <NewThread agents={agents} marks={marks} csrf={csrf} onOpened={open} onBack={back} wide={wide} />
    : data.which === 'thread' && data.thread ? <ThreadPane key={data.thread.id} initial={{ thread: data.thread, messages: data.messages ?? [], earlier: data.earlier, asks: data.asks }} marks={marks} member={data.member} csrf={csrf} wide={wide} onBack={back} onChanged={reload} github={data.github} />
      : null;
  const list = <ThreadList threads={threads} marks={marks} current={data.thread?.id} csrf={csrf} onOpen={open} onNew={() => setMaking(true)} reload={reload} />;
  if (!wide) return <div className="comms" data-phone="">{pane ?? list}</div>;
  return (
    <div className="comms" data-wide="">
      {list}
      {pane ?? <div className="comms-blank"><p className="loom-data">PICK A THREAD, OR START ONE</p></div>}
    </div>
  );
}

export default CommsView;
