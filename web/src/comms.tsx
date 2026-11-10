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
import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RailContext } from './desk-rail';
import './comms.css';
import { WorkPanel } from './comms-work';
import { AgentAvatar, useEnv, type Mark } from './blocks';
import { markColor } from './look';
import { reducedMotion } from './access';
import { bits } from './plain';
import { prose } from '../../src/ui/prose';
import type { Chrome } from './loom';
import type { FaceState } from './face';
import { useFollow } from './comms-follow';
import { refBits, RefText, ThreadRefs, useHtmlRefs } from './comms-refs';
import { ThreadAskCard, type ThreadAsk } from './comms-asks';
import { onLive } from './page';
import { useOtherThreads, useThreads } from './threads-live';
import { AgentChat, AgentChatComposer, AgentChatMessage, AgentChatProgress, AgentChatThread, type AgentChatStep } from '@/components/ui/agent-chat';
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
export type { ThreadAsk };
export type CommsData = { view: 'comms'; which: 'list' | 'thread'; chrome: Chrome; member: string; asks?: ThreadAsk[];
  threads?: Thread[]; unread?: number; agents?: string[]; thread?: Thread; messages?: Msg[]; earlier?: { at: string; summary: string }[];
  /** household.json's github: a bare repo#N in a reply links under it. */
  github?: string };

/** A message's id: 16 characters of RFC 4648 base32, lowercased (comms.md, "The message id"). */
export { newId } from './comms-id';
import { newId } from './comms-id';
import { folded, groupLabel, isPlan, stepOf } from './steps';

async function post(path: string, csrf: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  try {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ ...body, _csrf: csrf }) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j as Record<string, unknown> };
  } catch { return { ok: false, status: 0, body: { error: 'loom can\'t be reached right now' } }; }
}
/** A GET that says why it failed: loom's status and its answer's `error` (status 0: not reached). */
async function getRead<T>(path: string): Promise<{ ok: true; body: T } | { ok: false; status: number; error?: unknown }> {
  try {
    const r = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (r.ok) return { ok: true, body: (await r.json()) as T };
    const j = await r.json().catch(() => ({})) as { error?: unknown };
    return { ok: false, status: r.status, error: j.error };
  } catch { return { ok: false, status: 0 }; }
}

/** A thread read loom refused, in words (comms.md §7, t-1937): a 5xx, e.g. a `503` when comms.key is missing or
 * unreadable. Null when it isn't one: not reached is the stream's Reconnecting, and a 4xx isn't a read loom failed. */
export function readRefusal(status: number, error: unknown): string | null {
  if (status < 500) return null;
  const why = /comms\.key|^no-age|\bage\b|decrypt/i.test(String(error ?? '')) ? 'loom couldn\'t decrypt it' : 'loom couldn\'t answer';
  return `Can't open this conversation right now: ${why}.`;
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
 * A reply's words as markdown, with the loom things it names marked (`data-ref`): a task (t-N), a pull request or issue
 * (owner/repo#N), a conversation (cv-…), an approval, a note, a knowledge page, a project, a person, an @agent. Each is
 * its words, no link, until the thread knows this reader may open it, and then a chip (comms-refs.tsx). Links go only to
 * https or inside loom: the renderer (src/ui/prose.ts) drops anything else, and an http:// link is left as its words.
 */
export function replyHtml(text: string, owner?: string): string {
  // Only in the words themselves: code (a span or a fenced block), a link the agent wrote and a bare URL stay as written.
  // Marked under a word made for this call alone, so a link the agent wrote can never pass for one loom marked.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  const marked = text.split(KEEP_AS_WRITTEN).map((part, i) => (i % 2 ? part : markRefs(part, nonce, owner))).join('');
  return htmlOf(marked, nonce);
}

/** Code, a markdown link or a bare URL: a reply's parts no ref is marked in. */
const KEEP_AS_WRITTEN = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(?:^|\n)(?: {4}|\t)[^\n]*|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<https?:\/\/[^>\s]*>|https?:\/\/[^\s<>()]+)/i;

function markRefs(text: string, nonce: string, owner?: string): string {
  const mark = (ref: string, words: string) => `[${words}](${INSIDE}ref-${nonce}/${encodeURIComponent(ref)})`;
  return bits(text, owner).map((b) => b.t === 'task' ? mark(b.id, b.id)
    : b.t === 'pr' ? mark(`github:${b.repo}#${b.n}`, `${b.repo}#${b.n}`)
      : b.t === 'conv' ? mark(b.id, b.id)
        : b.t === 'path' ? `\`${b.s}\`` : refBits(b.s).map((x) => (x.t === 'text' || /^(?:t-|github:|cv-)/.test(x.ref) ? x.s
          : mark(x.ref, x.ref.startsWith('note:') ? `\`${x.s}\`` : x.s))).join('')).join('');
}

function htmlOf(marked: string, nonce: string): string {
  return prose(marked)
    .replace(/<a [^>]*href="http:\/\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    // The marked things: words, until the thread knows them.
    .replace(new RegExp(`<a [^>]*href="https://loom\\.invalid/ref-${nonce}/([^"/]*)"[^>]*>([\\s\\S]*?)</a>`, 'g'), (_m, enc: string, words: string) => {
      let ref = '';
      try { ref = decodeURIComponent(enc); } catch { return words; }
      return MARKED_REF.test(ref) && !ref.split('/').includes('..') ? `<span class="comms-ref" data-ref="${ref}">${words}</span>` : words;
    })
    // Any other link into loom an agent writes (a task's page, //evil.com, /\\host, ..) is its words: what's inside
    // loom opens only as a chip, once the reader may open it.
    .replace(/<a [^>]*href="https:\/\/loom\.invalid\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g, '$1');
}

/** The refs a reply marks, by shape (src/comms-refs.ts refShape's, with no `..` segment: src/ui/pixel-talk.test.ts checks
 * they agree). Nothing else becomes a data-ref. */
export const MARKED_REF = /^(?:t-\d{1,9}|github:[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,10}|cv-[0-9a-f]{12}|a-[0-9a-f]{8}|note:[A-Za-z0-9][\w./-]{0,199}|(?:knowledge|project|person|agent|at):[a-z0-9][a-z0-9-]{0,79})$/;

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
  const box = useRef<HTMLDivElement>(null);
  const chip = useHtmlRefs(box, html);
  return (
    <div ref={box} className="loom-prose comms-reply" dangerouslySetInnerHTML={{ __html: html }}
      onKeyDown={(e) => { chip(e); }}
      onClick={(e) => {
        // A ref that's a chip opens its card; one not known yet is words (it takes no click).
        if (chip(e)) return;
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
    // Effects can flush before the DOM mutation has painted. Cross a frame boundary before starting
    // the visible hold, so a busy commit cannot consume the signal's display time.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          setSignal(false); setTalkNow(talk);
          // A drawn face has no beats to follow: its run is timed, then done.
          if (!sprite) setPhase('talking');
        }, 250);
      });
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
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

type ThreadAction = 'title' | 'pin' | 'unpin' | 'archive' | 'unarchive' | 'project' | 'stop' | 'delete';

function ThreadContextMenu({ thread, at, close, act }: { thread: Thread; at: { x: number; y: number }; close: () => void; act: (action: ThreadAction) => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = menu.current!;
    const previous = document.activeElement as HTMLElement | null;
    const bounds = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - bounds.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - bounds.height - 8))}px`;
    el.querySelector('button')?.focus();
    const dismiss = (e: Event) => { if (!el.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', dismiss, true);
      previous?.focus();
    };
  }, [at, close]);
  const actions: [ThreadAction, string][] = [['title', 'Rename'], [thread.pinned ? 'unpin' : 'pin', thread.pinned ? 'Unpin' : 'Pin'],
    [thread.archived ? 'unarchive' : 'archive', thread.archived ? 'Unarchive' : 'Archive'], ['project', 'Project'],
    ...(thread.state.working ? [['stop', 'Stop'] as [ThreadAction, string]] : []), ['delete', 'Delete']];
  return createPortal(<div ref={menu} className="comms-menu__list comms-context-menu" role="menu" aria-label="Thread actions"
    style={{ left: at.x, top: at.y }} onContextMenu={(e) => e.preventDefault()} onKeyDown={(e) => {
      const buttons = Array.from(menu.current!.querySelectorAll('button'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>{actions.map(([action, label]) => <button key={action} type="button" role="menuitem" className={action === 'delete' ? 'comms-danger' : undefined}
      onClick={() => { close(); act(action); }}>{label}</button>)}</div>, document.body);
}

function ThreadRowView({ t, marks, current, onOpen, onArchive, onPin, onAction }: { t: Thread; marks: Record<string, Mark>; current: boolean; onOpen: () => void; onArchive: () => void; onPin: () => void; onAction: (action: ThreadAction) => void }) {
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const closeContext = useCallback(() => setContext(null), []);
  const press = useRef<number>(0);
  const touch = useRef<{ x: number; y: number } | null>(null);
  // A swipe or a long press acted already: the tap that ends it doesn't open the thread too.
  const acted = useRef(false);
  const mark = marks[t.agent];
  return (
    <li className="comms-row" data-current={current || undefined} data-unread={t.unread || undefined}
      onContextMenu={(e) => { e.preventDefault(); setContext({ x: e.clientX, y: e.clientY }); }}
      onKeyDown={(e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); setContext({ x: rect.left, y: rect.bottom });
      } }}
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
      {context && <ThreadContextMenu thread={t} at={context} close={closeContext} act={onAction} />}
    </li>
  );
}

/** The list's archived threads or Background work, live (threads-live.ts, t-2027): mounted only while the list shows
 * them, so the set is held only then. It hands the list its rows; null while it isn't live (the list asks loom then). */
function OtherThreads({ which, csrf, onRows }: { which: 'archived' | 'background' | 'both'; csrf: string; onRows: (rows: Thread[] | null) => void }) {
  const rows = useOtherThreads(csrf, which);
  const had = useRef(false);
  useEffect(() => { if (rows) { had.current = true; onRows(rows); } else if (had.current) onRows(null); }, [rows, onRows]);
  // A set that hasn't answered in OTHER_WAIT_MS isn't coming soon (the stream down, an error): loom is asked then.
  useEffect(() => { const t = setTimeout(() => { if (!had.current) onRows(null); }, OTHER_WAIT_MS); return () => clearTimeout(t); }, [onRows]);
  return null;
}
const OTHER_WAIT_MS = 2_000;

function ThreadList({ threads, live, marks, current, csrf, onOpen, onNew, reload, onRemoved }: { threads: Thread[]; live: boolean; marks: Record<string, Mark>; current?: string; csrf: string; onOpen: (t: Thread) => void; onNew: () => void; reload: () => void; onRemoved: () => void }) {
  const [archived, setArchived] = useState<Thread[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showBackground, setShowBackground] = useState(false);
  const which = showArchived && showBackground ? 'both' : showArchived ? 'archived' : showBackground ? 'background' : null;
  // Live, the other view's rows come from its own set (OtherThreads); loom is asked only while that set isn't live.
  // Kept with the view they're for, so a switch never shows one view's rows under another's name, nor asks loom.
  const [heldOther, setHeldOther] = useState<{ which: string; rows: Thread[] | null } | null>(null);
  const onOtherRows = useCallback((rows: Thread[] | null) => { setHeldOther(which ? { which, rows } : null); }, [which]);
  // Closed, its rows go: the set stopped, so reopened, they're asked for again, never shown from before.
  useEffect(() => { if (!which) setHeldOther(null); }, [which]);
  const liveOther = heldOther && heldOther.which === which ? heldOther.rows : null;
  const otherLive = live && liveOther !== null;
  // The other view's own set: until it answers, a moment, nothing is asked of loom (live means it will).
  const otherWaiting = live && which !== null && (heldOther === null || heldOther.which !== which);
  // What moves the asked-for copy: the list's rows, only while nothing's live (live, a row's move comes on the stream).
  const moved = live ? null : threads;
  useEffect(() => {
    if (!showArchived && !showBackground) return;
    if (otherLive || otherWaiting) return;
    let cancelled = false;
    void getJson<{ threads: Thread[] }>(`/comms?archived=${showArchived ? 1 : 0}&background=${showBackground ? 1 : 0}`)
      .then((r) => { if (!cancelled) setArchived(r?.threads ?? []); });
    return () => { cancelled = true; };
  }, [showArchived, showBackground, moved, otherLive, otherWaiting]);
  const groups = useMemo(() => {
    const pinned = threads.filter((t) => t.pinned), unread = threads.filter((t) => !t.pinned && t.unread), rest = threads.filter((t) => !t.pinned && !t.unread);
    return [['Pinned', pinned], ['Unread', unread], ['Threads', rest]] as const;
  }, [threads]);
  const act = async (t: Thread, verb: ThreadAction) => {
    let body: Record<string, unknown> | undefined;
    if (verb === 'title') {
      const title = prompt('Name this thread', t.title ?? '');
      if (!title?.trim()) return;
      body = { title: title.trim().slice(0, 60) };
    } else if (verb === 'project') {
      const project = prompt('File under which project? (its slug; empty to clear)', t.project ?? '');
      if (project === null) return;
      body = { project: project.trim() || null };
    } else if (verb === 'delete' && !confirm("Delete this thread and its words? This can't be undone.")) return;
    const result = await post(`/comms/${t.id}/${verb}`, csrf, body);
    if (!result.ok) { alert(String(result.body.error ?? "That didn't work.").replace(/^[a-z-]+: /, '')); return; }
    // Live, the change reaches every list on the stream; nothing is asked again.
    if (!live) reload();
    if (t.id === current && (verb === 'archive' || verb === 'delete')) onRemoved();
    if ((showArchived || showBackground) && !otherLive) {
      const result = await getJson<{ threads: Thread[] }>(`/comms?archived=${showArchived ? 1 : 0}&background=${showBackground ? 1 : 0}`);
      setArchived(result?.threads ?? []);
    }
  };
  const other = otherLive ? liveOther : archived;
  const list = showArchived || showBackground ? [[showBackground ? 'Background work' : 'Archived', other ?? []] as const] : groups;
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
            onAction={(action) => void act(t, action)} onArchive={() => void act(t, t.archived ? 'unarchive' : 'archive')} onPin={() => void act(t, t.pinned ? 'unpin' : 'pin')} />)}</ul>
        </div>
      ) : null)}
      {live && which && <OtherThreads key={which} which={which} csrf={csrf} onRows={onOtherRows} />}
      {(showArchived || showBackground) && other?.length === 0 && <p className="comms-empty">{showBackground ? 'No background work here.' : 'No archived threads.'}</p>}
      {!threads.length && !showArchived && !showBackground && <p className="comms-empty">No threads yet. Start one with one of your agents.</p>}
      <button type="button" className="comms-archived" aria-pressed={showBackground} onClick={() => { setArchived(null); setShowBackground(!showBackground); }}>Background work</button>
      <button type="button" className="comms-archived" onClick={() => { setArchived(null); setShowArchived(!showArchived); }}>{showArchived ? 'Back to active' : 'Archived'}</button>
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

/** The runtime owns preference and quota fallback; the thread supplies only its own choice. */
function ThreadModelChoice({ thread, csrf }: { thread: string; csrf: string }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void getRead<{ threadChoice: string }>(`/comms/${thread}/model`).then((r) => {
      if (!live) return;
      if (r.ok && ['auto', 'claude', 'codex'].includes(r.body.threadChoice)) setChoice(r.body.threadChoice);
      else setError('Model preference is unavailable.');
    });
    return () => { live = false; };
  }, [thread]);
  const save = async (harness: string) => {
    setBusy(true); setError(null);
    const r = await post(`/comms/${thread}/model`, csrf, { harness });
    if (r.ok && r.body.threadChoice === harness) setChoice(harness);
    else setError(String(r.body.error ?? 'The model preference was not saved.'));
    setBusy(false);
  };
  return <>
    {choice !== null && ['auto', 'claude', 'codex'].map((h) => <button key={h} role="menuitemradio" type="button" aria-checked={choice === h} disabled={busy} onClick={() => void save(h)}>
      Model: {h === 'auto' ? 'Auto' : h === 'claude' ? 'Claude' : 'Codex'}{choice === h ? ' ✓' : ''}
    </button>)}
    {error && <span role="alert">{error}</span>}
  </>;
}

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
  const card = (m.card ?? {}) as { error?: unknown; retry_at?: unknown; settled?: unknown };
  // A start the runtime is still retrying (t-1946) says when it tries next, in the reader's own time.
  const next = m.kind === 'error' && card.error === 'start-retry' && !card.settled && typeof card.retry_at === 'string' ? hhmm(card.retry_at) : '';
  if (m.kind === 'error') return <div className="comms-msg comms-msg--error" role="status"><span className="loom-data">{hhmm(m.at)} · loom</span><p>{m.text}{next && ` Next try at ${next}.`}</p>
    {conversation && !['no-runtime', 'busy', 'loop'].includes(String(card.error)) && <a className="loom-data comms-trace" href={traceHref(conversation)}>What happened</a>}</div>;
  if (m.kind === 'ask') return <div className="comms-msg comms-msg--ask"><span className="loom-data">{hhmm(m.at)} · {agentName(m.from, marks).toLowerCase()}</span><p>{agentName(agent, marks)} is asking you something: it's in your Inbox.</p></div>;
  const mine = m.kind === 'message' && m.from !== agent;
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

const asStep = (c: Msg, owner?: string): AgentChatStep => ({ id: String(c.seq), label: c.text ? <RefText text={c.text} owner={owner} /> : 'a step', status: stepOf(c) });

/**
 * A run's activity cards, one line until opened (comms.md, "The look"), then the 000h progress list: a `now:` line on
 * top (the newest step, and the plan's item when it keeps one), like steps in a row folded into one line (t-1944).
 */
function Steps({ cards: all, owner }: { cards: Msg[]; owner?: string }) {
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
        <p className="comms-steps__now loom-data">now: <RefText text={(cards.findLast((c) => stepOf(c) === 'current') ?? newest).text ?? 'a step'} owner={owner} />{plan?.text ? <><br /><RefText text={plan.text} owner={owner} /></> : null}</p>
        {folded(cards).map((g) => ('few' in g
          ? <AgentChatProgress key={g.few[0].seq} steps={g.few.map((c) => asStep(c, owner))} />
          : <details key={g.many[0].seq} className="comms-steps__group">
              <summary className="comms-steps__line loom-data">{groupLabel(g.many)} · {g.many.at(-1)!.text}</summary>
              <AgentChatProgress steps={g.many.map((c) => asStep(c, owner))} />
            </details>))}
      </>}
    </div>
  );
}

/** The thread's asks put where each was raised (comms.md, "Asks inline"): before the first message or run that came after it. */
type Shown = { key: string; msg?: Msg; cards?: Msg[]; ask?: ThreadAsk };
export function withAsks(groups: Shown[], asks: ThreadAsk[]): Shown[] {
  if (!asks.length) return groups;
  const at = (g: Shown) => Date.parse((g.msg ?? g.cards?.[0])?.at ?? '') || 0;
  const out: Shown[] = [];
  const left = [...asks].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  for (const g of groups) {
    // An ask in the same second as the agent's reply or step goes before it (a time is often to the second), never
    // before your own message: the agent asked after reading it.
    const before = (a: ThreadAsk) => { const t = Date.parse(a.at) || 0; return t < at(g) || (t === at(g) && g.msg?.kind !== 'message'); };
    while (left.length && before(left[0])) { const a = left.shift()!; out.push({ key: `ask:${a.ref}`, ask: a }); }
    out.push(g);
  }
  for (const a of left) out.push({ key: `ask:${a.ref}`, ask: a });
  return out;
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
  // Loom refused this thread's last read (a 503: comms.key missing or unreadable): its words, until a read works.
  const [refused, setRefused] = useState<string | null>(null);
  const [talk, setTalk] = useState<{ n: number; key: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const closeContext = useCallback(() => setContext(null), []);
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
    // And always the newest message with words (t-1937): a read with nothing to decrypt needs no key, so a comms.key
    // gone would go unnoticed while the thread looks current.
    const worded = shown.current.filter((m) => m.text && m.kind !== 'error').at(-1);
    const from = Math.min(oldest ? Math.min(last.current, oldest.seq - 1) : last.current, worded ? worded.seq - 1 : Infinity);
    const got = await getRead<{ thread: Thread; messages: Msg[]; asks?: ThreadAsk[] }>(`/comms/${thread.id}/since/${from}`);
    // A refused read says so (t-1937): what's shown stays, marked as possibly out of date, with Try again.
    if (!got.ok) { const why = readRefusal(got.status, got.error); if (why) setRefused(why); return; }
    setRefused(null);
    const r = got.body;
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

  // Anything loom says moved (its live stream, /events): an ask answered in the Inbox, an approval filed. The thread
  // reads again, so a card answered elsewhere shows its answer, and a new one shows its buttons (comms.md, "Asks inline").
  useEffect(() => onLive(() => { void pull(); }), [pull]);

  // Read: while the thread is on screen and the page visible, now and every 30 s (that's also "in front" for push).
  useEffect(() => {
    // And a look for asks every 30 s: an approval reaches loom's manifests on its own clock, not the thread's stream.
    // The desktop's agent cards hear it (desk-agents.tsx useAgentComms): what's unread there moves at once.
    const read = () => { if (document.visibilityState === 'visible') { void post(`/comms/${thread.id}/read`, csrf, { seq: last.current }).then(() => dispatchEvent(new Event('loom-comms-read'))); void pull(); } };
    read();
    const t = setInterval(read, 30_000);
    document.addEventListener('visibilitychange', read);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', read); };
  }, [thread.id, csrf, messages.length, pull]);

  // Follow the bottom only while the reader's there (comms-follow.ts); their own message always brings them down.
  // What the pill counts: messages and asks, never a run's step cards (they fold into one line).
  const { unread, down } = useFollow(bottom, messages.filter((m) => m.kind !== 'card').length + asks.filter((a) => a.state === 'open').length, messages.filter((m) => m.kind === 'message').at(-1)?.seq ?? 0);
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
  const face = faceOf({ failed: thread.state.failed, asking: asks.some((a) => a.state === 'open'), talking: false, working: thread.state.working, waitingOnAgent });
  const since = thread.state.working_since ? Math.max(0, Math.round((now - Date.parse(thread.state.working_since)) / 1000)) : 0;
  const swept = messages.some((m) => m.text === null && m.kind !== 'error');
  // The step it's on now: the newest card of the newest run still running, else the newest card since your message.
  const running = (() => {
    const cards = messages.filter((m) => m.kind === 'card' && !isPlan(m) && (!lastMine || m.seq > lastMine.seq));
    return (cards.filter((c) => String(c.card?.state ?? '') === 'running').at(-1) ?? cards.at(-1))?.text ?? null;
  })();
  // On a desktop, the agents' rail beside this tile opens this agent's card (desk-rail.ts).
  const rail = useContext(RailContext);
  const me = useRef({});
  useEffect(() => {
    if (!rail || !wide) return;
    rail.onAir({ agent: thread.agent }, me.current);
    return () => rail.onAir(null, me.current);
  }, [rail, wide, thread.agent]);
  // While the agents' rail is shown beside this tile, this agent's rail card is the comm screen: drawn there, at its own
  // size, and the band drops it (the avatar appears once). Rail hidden, a narrow screen or a phone: the band keeps it.
  const into = wide && rail?.screen?.agent === thread.agent ? rail.screen.el : null;
  const screen = <CommScreen agent={thread.agent} mark={mark} channel={thread.channel} face={face} talk={talk} link={link} on={onOf(messages)} compact={wide && !into ? short : !wide && compact} />;

  return (
    <article ref={pane} className="comms-thread" data-wide={wide || undefined} data-short={wide && short ? '' : undefined}>
      <header className="comms-thread__head" onContextMenu={(e) => {
        e.preventDefault(); setMenu(false); setContext({ x: e.clientX, y: e.clientY });
      }}>
        {drawer ? <DrawerButton {...drawer} /> : back && <button type="button" className="comms-back" onClick={onBack} aria-label="Back to threads">‹</button>}
        <button type="button" className="comms-thread__title" onClick={rename} title="Rename">{thread.title ?? `New thread with ${mark.label}`}</button>
        {thread.project && <span className="comms-thread__project loom-data">{thread.project}</span>}
        {thread.state.working && <button type="button" className="comms-stop" onClick={() => void verb('stop')}>Stop</button>}
        <button type="button" className="comms-menu" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Thread menu">⋯</button>
        {context && <ThreadContextMenu thread={thread} at={context} close={closeContext} act={(action) => {
          if (action === 'title') void rename(); else if (action === 'project') void project(); else void verb(action);
        }} />}
        {menu && (
          <div className="comms-menu__list" role="menu">
            <ThreadModelChoice thread={thread.id} csrf={csrf} />
            <button role="menuitem" type="button" onClick={() => void verb(thread.pinned ? 'unpin' : 'pin')}>{thread.pinned ? 'Unpin' : 'Pin'}</button>
            <button role="menuitem" type="button" onClick={() => void verb(thread.archived ? 'unarchive' : 'archive')}>{thread.archived ? 'Unarchive' : 'Archive'}</button>
            <button role="menuitem" type="button" onClick={() => void project()}>Project</button>
            <button role="menuitem" type="button" className="comms-danger" onClick={() => void verb('delete')}>Delete</button>
          </div>
        )}
      </header>
      <div className="comms-thread__body">
        {!wide && <div ref={top} className="comms-thread__strip">{screen}</div>}
        {!wide && <WorkPanel thread={thread.id} conversation={thread.conversation} csrf={csrf} replySeq={lastReply?.seq ?? 0} />}
        {/* A desktop's thread (Jonathan, 2026-11-07: "outlook-esque"): a band of fixed height over the chat, the comm screen
            at its own size on the left (never stretched), who's in the conversation and the thread's work on the right,
            scrolling inside the band so its height never changes; the chat takes the rest. */}
        {into && createPortal(screen, into)}
        {wide && (
          <div className="comms-band" data-noav={into ? '' : undefined}>
            {!into && screen}
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
              <WorkPanel thread={thread.id} conversation={thread.conversation} csrf={csrf} replySeq={lastReply?.seq ?? 0} />
            </div>
          </div>
        )}
        <ThreadRefs thread={thread.id} refresh={lastReply?.seq ?? 0}>
        <AgentChat className="comms-chat" aria-label={`Thread with ${mark.label}`} style={{ '--c': markColor(mark.bg) } as React.CSSProperties}>
          <AgentChatThread className="comms-msgs" jumpLabel="Latest">
            {swept && initial.earlier?.length ? (
              <div className="comms-earlier">
                <span className="loom-data">EARLIER, AS {mark.label.toUpperCase()} SUMMED IT UP</span>
                {initial.earlier.map((d) => <p key={d.at}>{d.summary}</p>)}
              </div>
            ) : null}
            {withAsks(grouped(messages), asksRead ? asks : []).map((g) => g.ask ? (
              <ThreadAskCard key={`ask:${g.ask.ref}`} a={g.ask} who={mark.label} member={member} csrf={csrf} owner={github} onAnswered={() => void pull()} />
            ) : g.cards ? <Steps key={g.key} cards={g.cards} owner={github} /> : (
              <Message key={g.key} m={g.msg!} marks={marks} agent={thread.agent} owner={github} you={member} conversation={thread.conversation} />
            ))}
            {lastMine && deliveryOf(lastMine) === 'failed' && <div className="comms-resend"><button type="button" onClick={() => void resend(lastMine)}>Not delivered · Send again</button> <a className="loom-data comms-trace" href={traceHref(thread.conversation)}>What happened</a></div>}
            {link === 'lost' && <div className="comms-msg comms-msg--error" role="status"><p>Reconnecting…</p></div>}
            {refused && (
              <div className="comms-msg comms-msg--error comms-refused" role="alert">
                <p>{refused}</p>
                {messages.length > 0 && <p className="comms-refused__stale">What's shown here may be out of date.</p>}
                <button type="button" className="comms-refused__retry" onClick={() => void pull()}>Try again</button>
              </div>
            )}
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
        </ThreadRefs>

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
// and a people-and-work side of 420 or more, so a work item's title reads on a line or two: 985, and room to spare make
// 1100 of Comms in a tile as it was, inside the page's 18 px padding each side and the body's 15 px scrollbar gutter.
// Comms now fills the tile's body (t-1960: an app in a tile is one surface, nothing around it), 51 px wider at the same
// window: 1151, so it changes where it did. Narrower, one pane, the threads a drawer from its header.
const ONE_PANE_BELOW = 1151;
/** The same with the comm screen in the agents' rail, not the band (its 208 and the gap gone): 880, and the same 51. */
const ONE_PANE_BELOW_RAIL = 931;

export function CommsView({ data }: { data: CommsData }) {
  const { go, wide } = useEnv();
  const csrf = data.chrome.csrf;
  const marks = useMemo(() => Object.fromEntries((data.chrome.shell?.agents ?? []).map((a) => [a.id, a as unknown as Mark])), [data.chrome]);
  const [threads, setThreads] = useState<Thread[]>(data.threads ?? []);
  const [agents, setAgents] = useState<string[]>(data.agents ?? []);
  const [making, setMaking] = useState(false);
  // The list, live (threads-live.ts, t-2027): the same set as the dock's count and the agent cards, kept current on the
  // stream, so nothing here asks loom again for it. Until it's live, the page's copy and a read of /comms, as before.
  const live = useThreads(csrf)?.list ?? null;
  const isLive = live !== null;
  const reload = useCallback(() => { void getJson<{ threads: Thread[]; agents: string[] }>('/comms').then((r) => { if (r) { setThreads(r.threads); setAgents(r.agents); } }); }, []);
  const changed = useCallback(() => { if (!isLive) reload(); }, [isLive, reload]);
  // Nothing kept the page's copy current while the set was live: when it stops being live, ask loom once.
  const wasLive = useRef(false);
  // (A thread's view already asks again then: the effect below.)
  const listView = !(data.which === 'thread' || !data.threads);
  useEffect(() => { if (wasLive.current && !isLive && listView) reload(); wasLive.current = isLive; }, [isLive, reload, listView]);
  // A thread's view doesn't carry the list: on a desktop (two panes) or for New thread, it's fetched beside it (live:
  // only once, for who can be written to).
  const listed = useRef(false);
  useEffect(() => {
    if (!(data.which === 'thread' || !data.threads)) return;
    if (isLive && listed.current) return;
    listed.current = true;
    reload();
  }, [data.which, data.threads, reload, isLive]);
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
  // Beside a shown agents' rail the thread's comm screen is the rail's, so two panes fit narrower (ONE_PANE_BELOW_RAIL).
  const shownRail = !!useContext(RailContext)?.shown;
  const hosted = useRef(shownRail);
  hosted.current = shownRail;
  useLayoutEffect(() => {
    const el = box.current;
    if (!wide || !el) return;
    // Its border box, both times: the first read and every resize after measure the same edge.
    const fit = (w: number) => setOne(w > 0 && w < (hosted.current ? ONE_PANE_BELOW_RAIL : ONE_PANE_BELOW));
    fit(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => fit(e.borderBoxSize?.[0]?.inlineSize ?? el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [wide, shownRail]);
  const asked = opening && opening.id !== (data.which === 'thread' ? data.thread?.id : undefined) ? opening : undefined;
  // One pane (t-1925 C): the threads are a drawer over it, from the menu button in its header; picking one closes it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [data.thread?.id, data.which, making, one]);
  const drawer: Drawer | undefined = wide && one ? { open: drawerOpen, toggle: () => setDrawerOpen((o) => !o) } : undefined;
  const pane = making ? <NewThread agents={agents} marks={marks} csrf={csrf} onOpened={open} onBack={back} wide={wide} back={!wide || one} drawer={drawer} />
    : asked ? <ThreadOpening key={asked.id} t={asked} marks={marks} wide={wide} back={!wide || one} onBack={back} drawer={drawer} />
    : data.which === 'thread' && data.thread ? <ThreadPane key={data.thread.id} initial={{ thread: data.thread, messages: data.messages ?? [], earlier: data.earlier, asks: data.asks }} marks={marks} member={data.member} csrf={csrf} wide={wide} back={!wide || one} onBack={back} onChanged={changed} github={data.github} drawer={drawer} />
      : null;
  const list = <ThreadList threads={live ?? threads} live={isLive} marks={marks} current={opening?.id ?? data.thread?.id} csrf={csrf} onOpen={open} onNew={() => setMaking(true)} reload={reload} onRemoved={back} />;
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
