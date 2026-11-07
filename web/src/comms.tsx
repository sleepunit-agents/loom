// Comms (docs/specs/comms.md, "The app"): talking with your own agents, in threads. Its own chunk, loaded only when
// the Comms view opens, so the first page carries none of it.
//
// What loom answers here (src/ui/comms-routes.ts): GET /comms is the list, GET /comms/<thread> the thread, each a view
// (`view: 'comms'`) with the page's chrome; the thread's live stream is /comms/<thread>/events ({seq} only), and the
// rest are its routes (send, title, pin, archive, stop, read, delete). Every word a thread shows comes from those.
//
// On a phone: the list, then a thread pushed over it, its composer above the dock and clear of the keyboard. On a
// desktop: the two side by side in the app's window, or one at a time with a way back when that window (or tile) is
// narrower than two panes fit (ONE_PANE_BELOW). Each thread has its comm screen: the agent's pixel portrait in a
// Neon OS frame, its face following the thread's real state (comms.md, "The comm screen").
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './comms.css';
import { WorkPanel } from './comms-work';
import { AgentAvatar, useEnv, type Mark } from './blocks';
import { markColor } from './look';
import { reducedMotion } from './access';
import { bits, githubUrl } from './plain';
import { prose } from '../../src/ui/prose';
import { act, type Chrome } from './loom';
import type { FaceState } from './face';
import { useFollow } from './comms-follow';
import { LIVE_SAYS, useAskLive } from './ask-open';
import { AgentChat, AgentChatComposer, AgentChatMessage, AgentChatPermission, AgentChatProgress, AgentChatThread, type AgentChatStep } from '@/components/ui/agent-chat';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

const PixelFace = lazy(() => import('./pixel-face'));
const DrawnFace = lazy(() => import('./face'));

// ---- what loom answers ---------------------------------------------------------------------------

type ThreadState = { working: boolean; working_since: string | null; queued: boolean; failed: boolean };
export type Thread = {
  id: string; agent: string; title: string | null; titled_by: string | null; project: string | null; pinned: boolean; archived: string | null;
  opened: string; last: string; read_seq: number; channel: number; conversation: string; state: ThreadState; unread?: boolean; last_seq?: number;
};
export type Msg = { seq: number; at: string; kind: 'message' | 'reply' | 'card' | 'ask' | 'error'; from: string; id: string; text: string | null;
  card: Record<string, unknown> | null; run: string | null; delivered: boolean | null; delivery?: Delivery };
/** Where a message of yours is, as the server recorded it (comms.md, "Sending"): never a guess the app makes. */
type Delivery = 'sending' | 'delivered' | 'failed';
const deliveryOf = (m: Msg): Delivery => m.delivery ?? (m.delivered === true ? 'delivered' : m.delivered === false ? 'failed' : 'sending');
/**
 * Whether a message can still change where it is on its own: one of yours on its way, or a step still running. The
 * app reads the thread again from the oldest of these, so their state is the server's, not what it was when first
 * read. (Your last message, not delivered, is read again too: Send again from another tab puts it back on its way.)
 */
const unsettled = (m: Msg) => (m.kind === 'message' && deliveryOf(m) === 'sending') || (m.kind === 'card' && String(m.card?.state ?? '') === 'running');
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

/** The comm screen's channel line (t-1918): what the agent is doing now, said as a radio would. No carrier when the
 * agent can't be reached; waiting on you while it asks; else its face's state. A stream reconnecting doesn't change what
 * the agent is doing: the meter drops to one bar and the thread says Reconnecting. */
export function channelWord(face: FaceState | 'complete', link: Link): string {
  if (link === 'none' || face === 'error') return 'NO CARRIER';
  return face === 'needs-input' ? 'WAITING ON YOU' : face === 'talking' ? 'TALKING' : face === 'working' ? 'WORKING' : face === 'thinking' ? 'THINKING' : 'DONE';
}

/** A thread's page address (t-1918): its id without the `th:` (a page's path has no colon; src/comms.ts threadPath). */
export const threadPath = (id: string) => `/comms/${id.replace(/^th:/, '')}`;

/** The harness the thread's latest reply came from, when it was a switch (its card's `on`, comms.md): "Codex", or null. */
export const onOf = (messages: Msg[]): string | null => {
  const on = messages.filter((m) => m.kind === 'reply').at(-1)?.card?.on;
  return typeof on === 'string' && on ? on : null;
};

function CommScreen({ agent, mark, channel, face: base, talk, link, on, compact }: {
  agent: string; mark: Mark; channel: number; face: FaceState; talk: { n: number; key: number } | null; link: Link; on?: string | null; compact: boolean;
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
  }, [talk?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // The 250 ms count from when the signal is on the screen, not from when it was asked for: this effect runs after the
  // render that shows it. Timed from the ask, a busy render ate into it, and a slow machine saw the static for 30 ms
  // before the talking began (t-1925, loom#589's CI).
  useEffect(() => {
    if (!signal || !talk) return;
    const t = setTimeout(() => {
      setSignal(false); setTalkNow(talk);
      // A drawn face has no beats to follow: its run is timed, a beat about 1.5 s and a breath about 0.8 s, then done.
      if (!sprite) setPhase('talking');
    }, 250);
    return () => clearTimeout(t);
  }, [signal, talk?.key]); // eslint-disable-line react-hooks/exhaustive-deps
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
      style={{ '--c': markColor(mark.bg) } as React.CSSProperties} aria-label={`${mark.label}'s comm screen, channel ${String(channel).padStart(2, '0')}`}>
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
          <span>{name} · {channelWord(phase ?? face, link)}{on ? ` · ON ${on.toUpperCase()}` : ''}</span>
          <span className="comms-screen__meter" aria-label={`signal ${meter} of 4`}>{[1, 2, 3, 4].map((i) => <i key={i} data-on={i <= meter || undefined} />)}</span>
        </footer>
      </div>
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
      <button type="button" className="comms-row__btn" data-prefetch={threadPath(t.id)} onClick={() => { if (acted.current) { acted.current = false; return; } onOpen(); }}>
        {/* A letter, the agents' small mark (t-1925 D): the pixel face is the comm screen's. */}
        <span className="loom-letter comms-row__letter" aria-hidden style={{ '--c': mark ? markColor(mark.bg) : 'var(--v-pink)', '--ls': '30px' } as React.CSSProperties}>
          {(mark?.label ?? t.agent)[0].toUpperCase()}</span>
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

function ThreadList({ threads, marks, current, csrf, onOpen, onNew, reload }: { threads: Thread[]; marks: Record<string, Mark>; current?: string; csrf: string; onOpen: (t: Thread) => void; onNew: () => void; reload: () => void }) {
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
          <ul data-motion="off">{rows.map((t) => <ThreadRowView key={t.id} t={t} marks={marks} current={t.id === current} onOpen={() => onOpen(t)}
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

/** Whether this is a touch screen: its keyboard has no Shift to reach for, so Enter stays a new line there. */
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** What a message to Comms may carry: the server's MAX_TEXT (src/comms.ts). The composer's own default is 12,000. */
const MAX_TEXT = 40_000;

/** What's typed in each thread's composer and not sent, by thread, for this tab (t-1925 F): opening another thread and
 * coming back finds it as it was. Memory only, never storage: it's gone with the tab, so nobody after you sees it. */
const drafts = new Map<string, string>();

/** The 000h agent chat composer (components/ui/agent-chat.tsx), with loom's keys and its phone's focus kept. */
function Composer({ onSend, disabled, accent, placeholder, label, draft }: { onSend: (text: string) => Promise<boolean>; disabled?: boolean; accent?: string; placeholder: string; label: string;
  /** Whose draft it keeps (a thread's id). */ draft: string }) {
  const [text, setTextNow] = useState(() => drafts.get(draft) ?? '');
  const setText = (t: string) => { setTextNow(t); if (t) drafts.set(draft, t); else drafts.delete(draft); };
  const busy = useRef(false);
  const touch = useMemo(coarse, []);
  const send = async () => {
    const t = text.trim();
    if (!t || busy.current) return;
    busy.current = true;
    if (await onSend(t)) setText('');
    busy.current = false;
  };
  return (
    <AgentChatComposer className="comms-composer" style={{ '--c': accent } as React.CSSProperties} value={text} onValueChange={setText}
      onSend={() => void send()} disabled={disabled} placeholder={placeholder} label={label} maxLength={MAX_TEXT}
      hint={touch ? 'Send sends · Return is a new line' : 'Enter to send · Shift+Enter for a new line'}
      // Enter sends and Shift+Enter is a new line, where there's a hardware keyboard (the component's own Ctrl/Cmd+Enter
      // still sends). A phone's keyboard has no Shift, so its Enter stays a new line. Never mid-composition (an IME's).
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing || touch) return;
        if (!(e.target instanceof HTMLTextAreaElement)) return;
        e.preventDefault(); void send();
      }}
      // A press on Send leaves the field focused, so a phone's keyboard stays up: were the field to blur, the keyboard
      // would start closing and --comms-kb drop, the composer jumping down from under the finger before its click.
      onMouseDown={(e) => { if ((e.target as HTMLElement).closest('.v-agent-chat__send')) e.preventDefault(); }} />
  );
}

// ---- the threads' drawer (t-1925 C) ------------------------------------------------------------

/** In a box too narrow for two panes, the threads fold out over the thread from a menu button, as chat apps do. */
type Drawer = { open: boolean; toggle: () => void };
function DrawerButton({ open, toggle }: Drawer) {
  return (
    <button type="button" className="comms-drawer-btn" onClick={toggle} aria-label="Threads" aria-expanded={open} aria-controls="comms-drawer" data-drawer-btn="">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
  );
}

/** The drawer itself: the list over the pane, a scrim beside it. Focus goes in when it opens and back to the menu
 * button when it closes; Tab stays inside it; Esc and the scrim close it. */
function ThreadsDrawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>('.comms-row[data-current] .comms-row__btn') ?? panel.current?.querySelector<HTMLElement>('.comms-row__btn, button');
    first?.focus();
    // Back to this Comms' own menu button (the panel's box holds both).
    const box = panel.current?.closest('.comms');
    return () => { box?.querySelector<HTMLElement>('[data-drawer-btn]')?.focus(); };
  }, []);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !panel.current) return;
    const all = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input,[tabindex]:not([tabindex="-1"])')];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) { e.preventDefault(); all[0].focus(); return; }
    if (e.shiftKey && i <= 0) { e.preventDefault(); all[all.length - 1].focus(); } else if (!e.shiftKey && i === all.length - 1) { e.preventDefault(); all[0].focus(); }
  };
  return (
    <div className="comms-drawer" id="comms-drawer" role="dialog" aria-modal="true" aria-label="Threads" onKeyDown={keys}>
      <div ref={panel} className="comms-drawer__panel">{children}</div>
      <button type="button" className="comms-drawer__scrim" aria-label="Close threads" tabIndex={-1} onClick={onClose} />
    </div>
  );
}

// ---- one thread ----------------------------------------------------------------------------------

/** The runtime's trace of a thread's replies (comms.md, "Tracing a reply"): its page, for the owner, by conversation. */
const traceHref = (conversation: string) => `/p/runtime/trace/${conversation}`;

function Message({ m, marks, agent, owner, you, conversation }: { m: Msg; marks: Record<string, Mark>; agent: string; owner?: string; you: string; conversation?: string }) {
  // An error card links to what happened: the runtime's trace of this thread (none when there's no runtime to ask).
  const card = (m.card ?? {}) as { error?: unknown };
  if (m.kind === 'error') return <div className="comms-msg comms-msg--error" role="status"><span className="loom-data">{hhmm(m.at)} · loom</span><p>{m.text}</p>
    {conversation && !['no-runtime', 'busy', 'loop'].includes(String(card.error)) && <a className="loom-data comms-trace" href={traceHref(conversation)}>What happened</a>}</div>;
  if (m.kind === 'ask') return <div className="comms-msg comms-msg--ask"><span className="loom-data">{hhmm(m.at)} · {agentName(m.from, marks).toLowerCase()}</span><p>{agentName(agent, marks)} is asking you something: it's in your Inbox.</p></div>;
  const mine = m.kind === 'message';
  const delivery = mine ? deliveryOf(m) : undefined;
  const mark = marks[m.from];
  const avatar = mine
    ? <Avatar variant="blue" className="v-agent-chat__avatar" aria-hidden="true"><AvatarFallback>{(you[0] ?? 'Y').toUpperCase()}</AvatarFallback></Avatar>
    : mark ? <AgentAvatar a={mark} size={32} className="v-agent-chat__avatar comms-msg__face" /> : undefined;
  return (
    <AgentChatMessage from={mine ? 'user' : 'agent'} author={mine ? 'You' : m.from === 'loom' ? 'loom' : agentName(m.from, marks)} avatar={avatar}
      className={mine ? 'comms-msg--mine' : 'comms-msg--agent'} data-delivery={delivery} data-undelivered={delivery === 'failed' ? '' : undefined}
      meta={<span className="loom-data">{hhmm(m.at)}{delivery === 'sending' && ' · sending…'}{delivery === 'failed' && ' · not delivered'}</span>}>
      {m.text === null ? <p className="comms-msg__gone">(older than this thread keeps)</p> : mine ? <p className="comms-msg__text">{m.text}</p> : <Reply text={m.text} owner={owner} />}
    </AgentChatMessage>
  );
}

/** A card's state as the progress list draws it. */
const stepOf = (c: Msg): AgentChatStep['status'] => { const st = String(c.card?.state ?? ''); return st === 'failed' ? 'error' : st === 'running' ? 'current' : 'complete'; };

/** A plan card (Claude's TodoWrite, Codex's todo list; t-1944): the plan, not a step. Its label is `Plan (2/5): …`. */
const isPlan = (c: Msg) => ['TodoWrite', 'todo_list'].includes(String(c.card?.tool ?? ''));
/** A step's kind for grouping repeats: its label's first word and its tool ("Ran", "Read", "Searched"…). */
const kindOf = (c: Msg) => `${String(c.card?.tool ?? '')}:${(c.text ?? '').split(' ')[0]}`;
const GROUP_WORDS: Record<string, string> = { Ran: 'Ran N commands', Read: 'Read N files', Searched: 'N searches', Edited: 'Edited N files', Wrote: 'Wrote N files', Listed: 'Listed N folders', Messaged: 'N messages', Changed: 'Changed files N times' };
const groupLabel = (cards: Msg[]) => {
  const w = (cards[0].text ?? '').split(' ')[0];
  return (GROUP_WORDS[w] ?? `N steps: ${w}`).replace('N', String(cards.length));
};
/** Steps as the list shows them: three or more like ones in a row, all finished well, fold into one line you can open. */
function folded(cards: Msg[]): Array<{ few: Msg[] } | { many: Msg[] }> {
  const out: Array<{ few: Msg[] } | { many: Msg[] }> = [];
  for (let i = 0; i < cards.length;) {
    let j = i;
    while (j < cards.length && kindOf(cards[j]) === kindOf(cards[i]) && stepOf(cards[j]) === 'complete' && cards[j].text !== null) j++;
    if (j - i >= 3) { out.push({ many: cards.slice(i, j) }); i = j; continue; }
    const last = out.at(-1);
    if (last && 'few' in last) last.few.push(cards[i]); else out.push({ few: [cards[i]] });
    i++;
  }
  return out;
}
const asStep = (c: Msg): AgentChatStep => ({ id: String(c.seq), label: c.text ?? 'a step', status: stepOf(c) });

/**
 * A run's activity cards, one line until opened (comms.md, "The look"), then the 000h progress list: a `now:` line on
 * top (the newest step, and the plan's item when it keeps one), like steps in a row folded into one line (t-1944).
 */
function Steps({ cards: all }: { cards: Msg[] }) {
  const [open, setOpen] = useState(false);
  const plan = all.filter(isPlan).at(-1);
  const cards = all.filter((c) => !isPlan(c));
  const newest = cards.at(-1) ?? plan!;
  return (
    <div className="comms-steps" data-open={open || undefined}>
      <button type="button" className="comms-steps__line loom-data" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} {cards.length} step{cards.length === 1 ? '' : 's'} · {newest.text ?? 'a step'}
      </button>
      {open && <>
        <p className="comms-steps__now loom-data">now: {(cards.findLast((c) => stepOf(c) === 'current') ?? newest).text ?? 'a step'}{plan?.text ? <><br />{plan.text}</> : null}</p>
        {folded(cards).map((g) => ('few' in g
          ? <AgentChatProgress key={g.few[0].seq} steps={g.few.map(asStep)} />
          : <details key={g.many[0].seq} className="comms-steps__group">
              <summary className="comms-steps__line loom-data">{groupLabel(g.many)} · {g.many.at(-1)!.text}</summary>
              <AgentChatProgress steps={g.many.map(asStep)} />
            </details>))}
      </>}
    </div>
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

function ThreadPane({ initial, marks, member, csrf, wide, back, onBack, onChanged, github, drawer }: {
  /** One pane in a narrow box (t-1925 C): the threads fold out from a menu button, not a way back. */
  drawer?: Drawer;
  initial: { thread: Thread; messages: Msg[]; earlier?: { at: string; summary: string }[]; asks?: ThreadAsk[] }; marks: Record<string, Mark>; member: string; csrf: string; wide: boolean; github?: string;
  /** Whether it shows its own way back to the list: a phone's, or one pane at a time in a narrow window or tile. */
  back: boolean;
  onBack: () => void; onChanged: () => void;
}) {
  const [thread, setThread] = useState(initial.thread);
  const [messages, setMessages] = useState(initial.messages);
  const [asks, setAsks] = useState<ThreadAsk[]>(initial.asks ?? []);
  // Its asks are offered once this pane has read the thread itself (t-1925 F): a copy kept from before can hold an ask
  // answered since, and its Allow must never be pressed from that.
  const [asksRead, setAsksRead] = useState(false);
  const [link, setLink] = useState<Link>(initial.thread.state.failed ? 'none' : 'ok');
  const [talk, setTalk] = useState<{ n: number; key: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [compact, setCompact] = useState(false);
  // A desktop thread in a short tile (under 520 px tall): the band folds to a strip so the chat keeps its room.
  const pane = useRef<HTMLElement>(null);
  const [short, setShort] = useState(false);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!wide || !el) return;
    const fit = (h: number) => setShort(h > 0 && h < SHORT_BELOW);
    fit(el.getBoundingClientRect().height);
    const ro = new ResizeObserver(([e]) => fit(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [wide]);
  const [now, setNow] = useState(Date.now());
  const last = useRef(initial.messages.at(-1)?.seq ?? 0);
  // The oldest message that can still change (unsettled): each read starts there, so it's read again until it settles.
  const shown = useRef(initial.messages);
  useEffect(() => { shown.current = messages; }, [messages]);
  const seenReply = useRef(initial.messages.filter((m) => m.kind === 'reply').at(-1)?.seq ?? 0);
  const bottom = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const mark = marks[thread.agent] ?? { label: agentName(thread.agent, marks), bg: 'pink', fg: '#000' };
  useKeyboardInset();

  // New messages: fetched after the last seq we have, once the stream says the thread moved.
  const pull = useCallback(async () => {
    const lastMine = shown.current.filter((m) => m.kind === 'message').at(-1);
    const oldest = shown.current.slice(-100).find((m) => unsettled(m) || (m === lastMine && deliveryOf(m) === 'failed'));
    const from = oldest ? Math.min(last.current, oldest.seq - 1) : last.current;
    const r = await getJson<{ thread: Thread; messages: Msg[]; asks?: ThreadAsk[] }>(`/comms/${thread.id}/since/${from}`);
    if (!r) return;
    // Only when it moved: a read that changed nothing redraws nothing.
    setThread((t) => (JSON.stringify(t) === JSON.stringify(r.thread) ? t : r.thread));
    setAsks(r.asks ?? []);
    setAsksRead(true);
    if (r.thread.state.failed) setLink('none');
    // What's new or moved (a read from an unsettled message brings back some the app already has, unchanged).
    const had = new Map(shown.current.map((m) => [m.seq, m]));
    const moved = r.messages.filter((m) => { const o = had.get(m.seq); return !o || o.delivered !== m.delivered || o.delivery !== m.delivery || o.text !== m.text || JSON.stringify(o.card) !== JSON.stringify(m.card); });
    if (!moved.length) return;
    last.current = Math.max(last.current, r.messages.at(-1)!.seq);
    shown.current = [...new Map([...shown.current, ...moved].map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
    setMessages((ms) => {
      const kept = new Map(ms.map((m) => [m.seq, m]));
      for (const m of moved) kept.set(m.seq, m);
      return [...kept.values()].sort((a, b) => a.seq - b.seq);
    });
    const reply = moved.filter((m) => m.kind === 'reply' && m.seq > seenReply.current).at(-1);
    if (reply) {
      seenReply.current = reply.seq;
      // The beats for what landed now; the player adds them to a run already going and stops at 4 (PIXEL.talkMax).
      const n = moved.filter((m) => m.kind === 'reply').reduce((k, m) => k + talkBeats((m.text ?? '').length), 0);
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

  // Follow the bottom only while the reader's there (comms-follow.ts); their own message always brings them down.
  // What the pill counts: messages and asks, never a run's step cards (they fold into one line).
  const { unread, down } = useFollow(bottom, messages.filter((m) => m.kind !== 'card').length + asks.length, messages.filter((m) => m.kind === 'message').at(-1)?.seq ?? 0);
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
  // Send again: where it is as the server answers at once (sent again, or already on its way, or delivered), drawn
  // from that answer, never assumed; a refused one stays Not delivered and says why.
  const resend = async (m: Msg) => {
    if (!m.text) return;
    const r = await post(`/comms/${thread.id}/send`, csrf, { id: m.id, text: m.text });
    const d = r.body.delivery;
    if (r.ok && (d === 'sending' || d === 'delivered' || d === 'failed')) {
      setMessages((ms) => ms.map((x) => (x.seq === m.seq ? { ...x, delivered: d === 'sending' ? null : d === 'delivered', delivery: d } : x)));
    } else alert(String(r.body.error ?? 'That didn\'t send.').replace(/^[a-z-]+: /, ''));
    await pull();
  };
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
  // A turn over with no reply (its no-reply message, t-1900) ends the wait as a reply does: not thinking any more.
  const lastAnswer = messages.filter((m) => m.kind === 'reply' || (m.kind === 'error' && m.card?.error === 'no-reply')).at(-1);
  const waitingOnAgent = !!lastMine && deliveryOf(lastMine) !== 'failed' && (!lastAnswer || lastAnswer.seq < lastMine.seq);
  // An ask waiting on you wins over everything but an error (comms.md's precedence).
  const face = faceOf({ failed: thread.state.failed, asking: asks.length > 0, talking: false, working: thread.state.working, waitingOnAgent });
  const since = thread.state.working_since ? Math.max(0, Math.round((now - Date.parse(thread.state.working_since)) / 1000)) : 0;
  const swept = messages.some((m) => m.text === null && m.kind !== 'error');
  // The step it's on now: the newest card of the newest run still running, else the newest card since your message.
  const running = (() => {
    const cards = messages.filter((m) => m.kind === 'card' && !isPlan(m) && (!lastMine || m.seq > lastMine.seq));
    return (cards.filter((c) => String(c.card?.state ?? '') === 'running').at(-1) ?? cards.at(-1))?.text ?? null;
  })();
  const screen = <CommScreen agent={thread.agent} mark={mark} channel={thread.channel} face={face} talk={talk} link={link} on={onOf(messages)} compact={wide ? short : compact} />;

  return (
    <article ref={pane} className="comms-thread" data-wide={wide || undefined} data-short={wide && short ? '' : undefined}>
      <header className="comms-thread__head">
        {drawer ? <DrawerButton {...drawer} /> : back && <button type="button" className="comms-back" onClick={onBack} aria-label="Back to threads">‹</button>}
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
        {!wide && <WorkPanel thread={thread.id} replySeq={lastReply?.seq ?? 0} />}
        {/* A desktop's thread (Jonathan, 2026-11-07: "outlook-esque"): a band of fixed height over the chat, the comm screen
            at its own size on the left (never stretched), who's in the conversation and the thread's work on the right,
            scrolling inside the band so its height never changes; the chat takes the rest. */}
        {wide && (
          <div className="comms-band">
            {screen}
            <div className="comms-band__side">
              <section className="comms-people" aria-labelledby={`people-${thread.id}`}>
                <h2 id={`people-${thread.id}`} className="comms-people__head loom-data">IN THIS CONVERSATION</h2>
                <ul>
                  <li><span className="loom-letter" aria-hidden style={{ '--c': markColor(mark.bg), '--ls': '24px' } as React.CSSProperties}>{mark.label[0]}</span>
                    <span className="comms-people__name">{mark.label}</span><span className="comms-people__what loom-data">{channelWord(face, link).toLowerCase()}</span></li>
                  <li><span className="loom-letter" aria-hidden style={{ '--c': 'var(--v-blue)', '--ls': '24px' } as React.CSSProperties}>{(member[0] ?? 'Y').toUpperCase()}</span>
                    <span className="comms-people__name">{member.split('-').map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1)).join(' ')}</span><span className="comms-people__what loom-data">you</span></li>
                </ul>
              </section>
              <WorkPanel thread={thread.id} replySeq={lastReply?.seq ?? 0} />
            </div>
          </div>
        )}
        <AgentChat className="comms-chat" aria-label={`Thread with ${mark.label}`} style={{ '--c': markColor(mark.bg) } as React.CSSProperties}>
          {/* No living morph on the log's avatars and marks (data-motion="off", cojeev-motion category.ts): each host
              reads computed style after the last one wrote it, and a thread of 40 messages spent seconds there
              before its first frame on a busy machine (t-1925 F). */}
          <AgentChatThread className="comms-msgs" jumpLabel="Latest" data-motion="off">
            {swept && initial.earlier?.length ? (
              <div className="comms-earlier">
                <span className="loom-data">EARLIER, AS {mark.label.toUpperCase()} SUMMED IT UP</span>
                {initial.earlier.map((d) => <p key={d.at}>{d.summary}</p>)}
              </div>
            ) : null}
            {grouped(messages).map((g) => g.cards ? <Steps key={g.key} cards={g.cards} /> : (
              <Message key={g.key} m={g.msg!} marks={marks} agent={thread.agent} owner={github} you={member} conversation={thread.conversation} />
            ))}
            {asksRead && asks.map((a) => <AskCard key={a.id} a={a} csrf={csrf} agentName={mark.label} onAnswered={() => void pull()} />)}
            {lastMine && deliveryOf(lastMine) === 'failed' && <div className="comms-resend"><button type="button" onClick={() => void resend(lastMine)}>Not delivered · Send again</button> <a className="loom-data comms-trace" href={traceHref(thread.conversation)}>What happened</a></div>}
            {link === 'lost' && <div className="comms-msg comms-msg--error" role="status"><p>Reconnecting…</p></div>}
            {/* The working line (t-1918): what the agent is on as it happens, the newest step and how long, under the thread. */}
            {(face === 'working' || face === 'thinking') && (
              <div className="comms-live loom-data" role="status" data-face={face}>
                <i aria-hidden />{face === 'working'
                  ? <>{mark.label} is working{running ? <> · <span className="comms-live__step">{running}</span></> : null} · {Math.floor(since / 60)}:{String(since % 60).padStart(2, '0')}</>
                  : <>{mark.label} is thinking…</>}
              </div>
            )}
            <div ref={bottom} className="comms-end" />
          </AgentChatThread>
          {unread > 0 && <button type="button" className="comms-newpill" onClick={down}>{unread === 1 ? 'New message' : `${unread} new messages`} ↓</button>}
        </AgentChat>

      </div>
      <Composer onSend={send} disabled={!!thread.archived} accent={markColor(mark.bg)} label={`Message ${mark.label}`} placeholder={thread.archived ? 'Archived: unarchive it to write here' : `Message ${mark.label}`} draft={thread.id} />
    </article>
  );
}

/** A thread on its way (t-1925 F): what the list knows of it (its name, who with), at once, until its page lands and
 * the thread itself takes this place. Only the pane changes: the list beside it stays as it was. */
function ThreadOpening({ t, marks, wide, back, onBack, drawer }: { t: Thread; marks: Record<string, Mark>; wide: boolean; back: boolean; onBack: () => void; drawer?: Drawer }) {
  const mark = marks[t.agent] ?? { label: agentName(t.agent, marks), bg: 'pink', fg: '#000' };
  return (
    <article className="comms-thread comms-thread--opening" data-wide={wide || undefined} aria-busy="true">
      <header className="comms-thread__head">
        {drawer ? <DrawerButton {...drawer} /> : back && <button type="button" className="comms-back" onClick={onBack} aria-label="Back to threads">‹</button>}
        <span className="comms-thread__title">{t.title ?? `New thread with ${mark.label}`}</span>
      </header>
      <div className="comms-thread__body">
        <div className="comms-chat loom-skel-wait" aria-hidden>
          {[0, 1, 2].map((n) => <div key={n} className="comms-opening__line"><span className="loom-skel-line" /><span className="loom-skel-line" /></div>)}
        </div>
      </div>
      <Composer onSend={async () => false} accent={markColor(mark.bg)} label={`Message ${mark.label}`} placeholder={`Message ${mark.label}`} draft={t.id} />
    </article>
  );
}

/** An ask, answered here as the Inbox would answer it: its piece's own action, with this page's form token, drawn as
 *  the 000h permission (no implied consent: a deliberate Allow once or Deny). */
function AskCard({ a, csrf, agentName: who, onAnswered }: { a: ThreadAsk; csrf: string; agentName: string; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<'pending' | 'allowed' | 'denied'>('pending');
  const [said, setSaid] = useState<string | null>(null);
  const yes = a.actions.find((b) => b.tone === 'primary') ?? a.actions[0];
  const no = a.actions.find((b) => b.tone === 'danger');
  // Live only once loom says, now, it's still open; asked again right before a send (ask-open.ts, the Inbox's rule).
  const { live, check } = useAskLive({ a: a.id });
  const answer = async (d: 'allowed' | 'denied') => {
    const b = d === 'allowed' ? yes : no;
    if (!b) return;
    // A danger button (Deny) or one that says so asks first, as the Inbox's does (blocks.tsx ActButton).
    if ((b.tone === 'danger' || b.confirm) && !confirm(b.confirm ?? `${b.label}: are you sure?`)) return;
    setBusy(true);
    if (!(await check())) { setBusy(false); return; }
    const r = await act({ source: { id: a.piece, base: `/p/${a.piece}/` }, path: '', query: {}, csrf }, csrf, b.action, b.fields ?? {});
    setBusy(false);
    if (r.ok) { setDecision(d); setSaid(r.message || null); onAnswered(); } else setSaid(r.message || 'That didn\'t go through.');
  };
  return (
    <div className="comms-ask" aria-label={`${who} asks`}>
      <AgentChatPermission title={a.text} description={a.why ?? `${who} is asking you.`} decision={decision} disabled={busy || (decision === 'pending' && live !== 'live')}
        onDecision={(d) => void answer(d)} allowLabel={yes.label} denyLabel={no?.label ?? 'Deny'}
        scope={(a.if_yes || a.if_no || a.fine) ? (
          <>
            {(a.if_yes || a.if_no) && (
              <dl className="comms-ask__either">
                {a.if_yes && <><dt>If you allow</dt><dd>{a.if_yes}</dd></>}
                {a.if_no && <><dt>If you deny</dt><dd>{a.if_no}</dd></>}
              </dl>
            )}
            {a.fine && <p className="comms-ask__fine loom-data">Exactly what this allows: {a.fine}</p>}
          </>
        ) : undefined} />
      {said && <p className="comms-ask__said" role="status">{said}</p>}
      {decision === 'pending' && live !== 'live' && <p className="comms-ask__live" role="status" data-live={live}>{LIVE_SAYS[live]}</p>}
    </div>
  );
}

// ---- a new thread ------------------------------------------------------------------------------

function NewThread({ agents, marks, csrf, onOpened, onBack, wide, back, drawer }: { agents: string[]; marks: Record<string, Mark>; csrf: string; onOpened: (t: Thread) => void; onBack: () => void; wide: boolean; back: boolean; drawer?: Drawer }) {
  const [agent, setAgent] = useState(agents[0]);
  const [error, setError] = useState<string | null>(null);
  const id = useRef(newId());
  useKeyboardInset();
  const send = async (text: string) => {
    const r = await post('/comms/new', csrf, { agent, id: id.current, text });
    if (!r.ok) { setError(String(r.body.error ?? 'That didn\'t start.').replace(/^[a-z-]+: /, '')); return false; }
    onOpened(r.body.thread as Thread);
    return true;
  };
  return (
    <article className="comms-thread comms-new-thread" data-wide={wide || undefined}>
      <header className="comms-thread__head">
        {drawer ? <DrawerButton {...drawer} /> : back && <button type="button" className="comms-back" onClick={onBack} aria-label="Back to threads">‹</button>}
        <span className="comms-thread__title">New thread</span>
      </header>
      <div className="comms-pick" role="radiogroup" aria-label="Who with">
        {agents.map((a) => (
          <button key={a} type="button" role="radio" aria-checked={a === agent} className="comms-pick__agent" data-on={a === agent || undefined}
            style={{ '--c': marks[a] ? markColor(marks[a].bg) : undefined } as React.CSSProperties} onClick={() => setAgent(a)}>
            {marks[a] ? <AgentAvatar a={marks[a]} size={32} className="comms-row__avatar" /> : <span className="comms-row__face">{agentName(a, marks)[0]}</span>}{agentName(a, marks)}
          </button>
        ))}
      </div>
      {error && <p className="comms-msg comms-msg--error" role="alert">{error}</p>}
      <Composer onSend={send} accent={marks[agent] ? markColor(marks[agent].bg) : undefined} label={`Message ${agentName(agent, marks)}`} placeholder={`Message ${agentName(agent, marks)}`} draft="new" />
    </article>
  );
}

// ---- the view ----------------------------------------------------------------------------------

/** A desktop thread under this tall folds its band to a strip (the chat's room first). */
const SHORT_BELOW = 520;
// Two panes (the list beside the thread) only where the thread keeps a readable band (Jonathan, 2026-11-07): the list's
// 320 px and its edge, the band's padding (24), the comm screen (208: its 192 glass and the frame's 16), the gap (12)
// and a people-and-work side of 420 or more, so a work item's title reads on a line or two: 985, and Comms' own frame
// and a tile's padding around it make 1100. Narrower, one pane, the threads a drawer from its header.
const ONE_PANE_BELOW = 1100;

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
  // The list's own view carries it: the newest copy wins (this view stays mounted from page to page).
  useEffect(() => { if (data.threads) setThreads(data.threads); }, [data.threads]);
  // The thread asked for, from the moment it's pressed (t-1925 F): it's the one lit in the list, and its pane opens with
  // what the list knows, until its page lands. Only the pane is replaced; the list stays mounted, scrolled where it was.
  const [opening, setOpening] = useState<Thread | null>(null);
  useEffect(() => { setMaking(false); setOpening(null); }, [data.thread?.id, data.which]);
  // The thread itself, not its id: one just started, or an archived one, isn't in the list's threads.
  const open = (t: Thread) => { setMaking(false); setDrawerOpen(false); setOpening(t.id === data.thread?.id ? null : t); go(threadPath(t.id)); };
  const back = () => { setMaking(false); setOpening(null); go('/comms'); };
  // A desktop's Comms in a box narrower than two panes fit (a narrow window, a tile): one pane at a time, the list, then
  // the thread with a way back. Measured on the box, not the screen; before the first paint, so two never flash.
  const box = useRef<HTMLDivElement>(null);
  const [one, setOne] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!wide || !el) return;
    // Its border box, both times: the first read and every resize after measure the same edge.
    const fit = (w: number) => setOne(w > 0 && w < ONE_PANE_BELOW);
    fit(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => fit(e.borderBoxSize?.[0]?.inlineSize ?? el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [wide]);
  const asked = opening && opening.id !== (data.which === 'thread' ? data.thread?.id : undefined) ? opening : undefined;
  // One pane (t-1925 C): the threads are a drawer over it, from the menu button in its header; picking one closes it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [data.thread?.id, data.which, making, one]);
  const drawer: Drawer | undefined = wide && one ? { open: drawerOpen, toggle: () => setDrawerOpen((o) => !o) } : undefined;
  const pane = making ? <NewThread agents={agents} marks={marks} csrf={csrf} onOpened={open} onBack={back} wide={wide} back={!wide || one} drawer={drawer} />
    : asked ? <ThreadOpening key={asked.id} t={asked} marks={marks} wide={wide} back={!wide || one} onBack={back} drawer={drawer} />
    : data.which === 'thread' && data.thread ? <ThreadPane key={data.thread.id} initial={{ thread: data.thread, messages: data.messages ?? [], earlier: data.earlier, asks: data.asks }} marks={marks} member={data.member} csrf={csrf} wide={wide} back={!wide || one} onBack={back} onChanged={reload} github={data.github} drawer={drawer} />
      : null;
  const list = <ThreadList threads={threads} marks={marks} current={opening?.id ?? data.thread?.id} csrf={csrf} onOpen={open} onNew={() => setMaking(true)} reload={reload} />;
  if (!wide) return <div className="comms" data-phone="">{pane ?? list}</div>;
  // The same two places in both, the list's and the pane's: crossing the width keeps an open thread mounted (its
  // draft, its live messages), only the list comes and goes.
  return (
    <div ref={box} className="comms" data-wide="" data-one={one ? '' : undefined}>
      {one && pane ? null : list}
      {pane ?? (one ? null : <div className="comms-blank"><p className="loom-data">PICK A THREAD, OR START ONE</p></div>)}
      {one && pane && drawerOpen && <ThreadsDrawer onClose={() => setDrawerOpen(false)}>{list}</ThreadsDrawer>}
    </div>
  );
}

export default CommsView;
