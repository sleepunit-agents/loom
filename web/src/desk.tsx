// Neon Noir on a big screen (Jonathan, 2026-11-05, the desktop OS prototype's "Level 1: Shell": "if 1 is done well,
// there's no need to do [the others]"). Home is a desktop: widgets on the ground, each drawn from what Home already
// has (src/ui/handler.ts house-home): what needs you, answered where it stands; one card per agent with its face and
// what it's on; the pieces' own tiles; the nightly backup. Never a number loom doesn't have.
//
// Its own chunk, loaded only on a screen this wide under Neon (App.tsx): a phone never fetches it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { readRecent } from './recent';
import './desk.css';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Button } from '@/components/ui/button';
import { ActButton, AgentAvatar, LoomMark, Nothing, useEnv, type Mark } from './blocks';
import { Arrive } from './arrive';
import { AnswersWithLines, ApprovalBox, As, Fine, useOpenItem, type InboxItem } from './views';
import { plain } from './plain';
import { tidy } from './tidy';
import { iconFor } from './safe';
import { markColor } from './look';
import { DOT } from './tones';
import type { Shell } from './loom';
import { reducedMotion } from './access';

type Doing = { text: string; kind?: string; where?: string; since?: string };
type Card = Mark & { id: string; state?: 'working' | 'available' | 'unavailable' | 'broken'; reason?: string;
  doing?: Doing[]; problems?: { text: string; tone: 'bad' | 'warn' }[]; seen?: { at: string; where: string } };
export type DeskHomeData = { headline: string; needs: number; need?: InboxItem; stack?: InboxItem[]; cards: Card[]; moving: { agent?: string; text: string; meta?: string }[] };

const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** A widget: a dark panel with a lit edge in its tint, its name in small caps with a dot, and a way to its app. */
type Tint = 'pink' | 'blue' | 'yellow' | 'olive';
function Widget({ tint, title, more, className, children }: { tint: Tint; title: string; more?: { label: string; href: string }; className?: string; children: React.ReactNode }) {
  const { go } = useEnv();
  return (
    <section className={`loom-w ${className ?? ''}`} data-tint={tint} aria-label={title}>
      <header className="loom-w__head">
        <span className="loom-w__dot" aria-hidden />
        <h2>{title}</h2>
        {more && <a href={more.href} className="loom-w__more" onClick={(e) => { e.preventDefault(); go(more.href); }}>{more.label}</a>}
      </header>
      {children}
    </section>
  );
}

// ---- what needs you, answered where it stands --------------------------------------------------

/** One thing that needs you: who, what, why, and its answers: Allow and Deny under the approval's own words (never the
 * ask's alone: inbox.tsx ApprovalBox), Yes and No for a yes/no ask, else its own buttons. Words, or anything more, open it. */
function Need({ i }: { i: InboxItem }) {
  const env = useEnv();
  const agents = env.ctx.agents ?? {};
  const who = (i.agent && agents[i.agent]?.label) || (i.agent ? i.agent[0].toUpperCase() + i.agent.slice(1) : '');
  const p = plain(i, who);
  const open = useOpenItem();
  const [busy, setBusy] = useState(false);
  const approval = i.approval && i.attention ? i.approval : undefined;
  const yesNo = !approval && i.needs?.answers === 'yes-no' && !!i.reply;
  // A yes or a no, posted as its own source's, as its sheet does (inbox.tsx useAnswer).
  const say = async (answer: 'yes' | 'no') => {
    if (busy || !i.reply) return;
    setBusy(true);
    await env.withSource(i.source).send('needs-answer', { ...i.reply.fields, answer });
    setBusy(false);
  };
  const acts = !approval && !yesNo ? (i.actions ?? []) : [];
  const lined = acts.length > 0 && !!(i.needs?.if_yes || i.needs?.if_no);
  // Answered in words: its sheet has the box for them.
  const words = !approval && !yesNo && !!i.reply;
  return (
    // Its own buttons (an approval's card that wasn't absorbed is its own Allow and Deny) stand under its words whole,
    // never cut: what a button grants is read in full beside it (views.tsx ApprovalBox's rule).
    <Arrive as="li" k={`need:${i.key}`} className="loom-need" {...(acts.length ? { 'data-whole': '' } : {})}>
      {i.agent && agents[i.agent] ? <AgentAvatar a={agents[i.agent]} size={28} /> : <LoomMark size={28} />}
      <div className="loom-need__body">
        <button type="button" className="loom-need__title" onClick={() => open(i)}>
          {i.unread && <span className="loom-need__unread" aria-label="Unread" />}{p.title}
        </button>
        {(p.why ?? i.outcome) && <p className="loom-need__why">{tidy(p.why ?? i.outcome ?? '')}</p>}
        {approval && <ApprovalBox a={approval} />}
        {(yesNo || words || (acts.length > 0 && !lined)) && (
          <div className="loom-need__acts" role="group" aria-label="Your answer">
            {yesNo && <><Button size="sm" disabled={busy} onClick={() => void say('yes')}>Yes</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void say('no')}>No</Button></>}
            {words && <Button size="sm" variant="outline" onClick={() => open(i)}>{i.reply!.label || 'Answer'}…</Button>}
            {acts.length > 0 && !lined && <As source={i.source}>{acts.map((b) => <ActButton key={b.action + b.label} b={b} />)}</As>}
          </div>
        )}
        {/* Allow beside "If you allow", Deny beside "If you deny", under the ask read whole. */}
        {lined && <As source={i.source}><AnswersWithLines actions={acts} lines={i.needs!} /></As>}
        {acts.length > 0 && <Fine text={i.fine} className="loom-need__fine" />}
      </div>
    </Arrive>
  );
}

function Needs({ d }: { d: DeskHomeData }) {
  const { go } = useEnv();
  const stack = d.stack ?? (d.need ? [d.need] : []);
  const rest = d.needs - stack.length;
  return (
    <Widget tint="pink" title={d.needs ? `Needs you · ${d.needs}` : 'Needs you'} className="loom-w--needs" more={{ label: 'Inbox', href: '/inbox' }}>
      {stack.length ? <ul className="loom-needs">{stack.map((i) => <Need key={i.key} i={i} />)}</ul>
        : <p className="loom-w__quiet">Nothing needs you.</p>}
      {rest > 0 && <a href="/inbox" className="loom-w__foot" onClick={(e) => { e.preventDefault(); go('/inbox'); }}>{rest} more in the Inbox</a>}
    </Widget>
  );
}

// ---- the agents ---------------------------------------------------------------------------------

const EYEBROW = (c: Card) => {
  const doing = c.doing ?? [], problems = c.problems ?? [];
  return problems.length ? (c.state === 'broken' ? 'Something’s broken' : 'Needs a look')
    : c.state === 'working' || doing.length ? `Working${doing.length > 1 ? ` · ${doing.length} things` : ''}`
    : c.state === 'unavailable' ? 'Unavailable' : 'Up · quiet';
};

/** An agent: its face, big and alive (the pixel face where it has one), how it is, and the one thing it's on. */
function Agent({ c }: { c: Card }) {
  const { go } = useEnv();
  const problems = c.problems ?? [];
  const doing = c.doing ?? [];
  const lit = markColor(c.bg);
  const state = c.state === 'broken' || problems.length ? 'error' : c.state === 'working' || doing.length ? 'working' : 'idle';
  // Its status line: trouble first, then what it's on, else why it's quiet.
  const line = problems[0]?.text ?? doing[0]?.text ?? c.reason;
  const where = problems.length ? undefined : doing[0] ? [doing[0].where, doing[0].since && ago(doing[0].since)].filter(Boolean).join(' · ') : undefined;
  return (
    <a href={`/a/${c.id}`} className="loom-w loom-w--agent" style={{ '--acc': lit } as React.CSSProperties} data-state={state}
      onClick={(e) => { e.preventDefault(); go(`/a/${c.id}`); }} aria-label={`${c.label}: ${EYEBROW(c)}${line ? `. ${line}` : ''}`}>
      <span className="loom-agent__face"><AgentAvatar a={c} size={96} state={state} /></span>
      <span className="loom-agent__who">
        <span className="loom-agent__eyebrow" data-trouble={problems.length ? '' : undefined}>{EYEBROW(c)}</span>
        <span className="loom-agent__name">{c.label}</span>
      </span>
      {line && <Arrive as="span" k={`line:${c.id}\0${line}`} className="loom-agent__line" {...(problems[0] ? { 'data-tone': problems[0].tone } : {})}>
        <AnimatedIcon name={iconFor(problems.length ? 'triangle-alert' : doing.length ? 'activity' : 'moon')} size="sm" />
        <span><span className="loom-agent__text">{line}</span>{where && <span className="loom-agent__where">{where}</span>}</span></Arrive>}
      <span className="loom-agent__foot">
        <span>Open {c.label}</span>
        {c.seen && <span className="loom-data">seen {ago(c.seen.at)}{c.seen.where ? ` · ${c.seen.where}` : ''}</span>}
      </span>
    </a>
  );
}

// ---- vitals: the pieces' own tiles, and the nightly backup -------------------------------------

/** Box vitals, from what every page's shell already carries (never a number of its own): the Boxes place's count, its
 * tone and its open alerts, then any other place that's in trouble. Each a link to its page. */
function Vitals({ shell }: { shell: Shell }) {
  const { go } = useEnv();
  const places = shell.pieces as (Shell['pieces'][number] & { alerts?: number })[];
  const trouble = (p: (typeof places)[number]) => (p.alerts ?? 0) > 0 || p.tone === 'bad' || p.tone === 'warn';
  // One row per place: two pieces can carry the same one for a while (a piece and its successor side by side).
  const rows = [...places.filter((p) => p.label === 'Boxes'), ...places.filter((p) => p.label !== 'Boxes' && trouble(p))]
    .filter((p, n, all) => all.findIndex((x) => x.href === p.href) === n);
  if (!rows.length) return null;
  return (
    <Widget tint="blue" title="Vitals" className="loom-w--vitals">
      <ul className="loom-vitals">{rows.map((p) => {
        const alerts = p.alerts ?? 0;
        const tone = alerts || p.tone === 'bad' ? 'bad' : p.tone === 'warn' ? 'warn' : p.tone === 'ok' || !trouble(p) ? 'ok' : undefined;
        return (
          <Arrive as="li" key={p.href} k={`vital:${p.href}\0${p.stat ?? ''}\0${alerts}`}><a href={p.href} className="loom-vital" onClick={(e) => { e.preventDefault(); go(p.href); }}>
            <span className="loom-vital__label">{tone && <span className={`size-2 rounded-full ${DOT[tone]}`} />}{p.label}</span>
            {p.stat && <span className="loom-vital__value loom-data">{p.stat}</span>}
            <span className="loom-vital__detail">{alerts ? `${alerts} open alert${alerts === 1 ? '' : 's'}` : trouble(p) ? 'needs a look' : 'all quiet'}</span>
          </a></Arrive>
        );
      })}
      </ul>
    </Widget>
  );
}

function BackupW({ b }: { b: NonNullable<Shell['backup']> }) {
  const tint: Tint = b.tone === 'ok' ? 'olive' : b.tone === 'bad' ? 'pink' : 'yellow';
  return (
    <Widget tint={tint} title="Backup" className="loom-w--backup" more={{ label: 'Details', href: b.href }}>
      <p className="loom-backup" data-tone={b.tone}>
        <span className={`size-2 shrink-0 rounded-full ${b.tone === 'ok' ? 'bg-[var(--loom-ok)]' : b.tone === 'bad' ? 'bg-[var(--loom-bad)]' : 'bg-[var(--loom-warn)]'}`} />
        <span>{b.tone === 'ok' ? <>Last good copy <span className="loom-data">{b.text}</span></> : b.text}</span>
      </p>
    </Widget>
  );
}

/** What's moving: the agents' work as the pieces report it, a line each. */
function Tape({ rows }: { rows: DeskHomeData['moving'] }) {
  const { ctx } = useEnv();
  const agents = ctx.agents ?? {};
  return (
    <section className="loom-w loom-w--tape" data-tint="olive" aria-label="What's moving">
      <span className="loom-tape__label" aria-hidden>Moving</span>
      <ul className="loom-tape">{rows.filter((r, n) => rows.findIndex((x) => x.agent === r.agent && x.text === r.text) === n).slice(0, 6).map((r, n) => (
        <li key={n}><b>{(r.agent && agents[r.agent]?.label) || r.agent}</b> {r.text}{r.meta && <span className="loom-tape__meta"> · {r.meta}</span>}</li>))}
      </ul>
    </section>
  );
}

function NoAgents() {
  const { go } = useEnv();
  return <Nothing title="No agents yet" text="An agent is who does the work here. Make the first one."><Button className="mt-2" onClick={() => go('/new-agent')}>New agent</Button></Nothing>;
}

// ---- the desktop --------------------------------------------------------------------------------

export function DeskHome({ home, shell }: { home: DeskHomeData; shell: Shell }) {
  // Back from a window: focus on the dock key it came from, or Home's.
  useEffect(() => {
    if (!closing) return;
    const k = keyFor(closing) ?? keyFor('/');
    closing = null;
    k?.focus({ preventScroll: true });
  }, []);
  const backup = shell.backup;
  return (
    <div className="loom-desk-home">
      <div className="loom-desk-col loom-desk-col--left">
        <Needs d={home} />
      </div>
      <div className="loom-desk-col loom-desk-col--mid">
        <p className="loom-desk-headline">{home.headline}</p>
        {home.cards.length === 0 ? <NoAgents />
          : <div className="loom-desk-agents">{home.cards.map((c) => <Agent key={c.id} c={c} />)}</div>}
        {home.moving.length > 0 && <Tape rows={home.moving} />}
      </div>
      <div className="loom-desk-col loom-desk-col--right">
        <Vitals shell={shell} />
        {backup && <BackupW b={backup} />}
      </div>
    </div>
  );
}

// ---- an app's window -----------------------------------------------------------------------------

type Tab = { label: string; href: string };
/** The household dock's places, as App.tsx last drew them (DeskKeys), for the key a window grows out of. */
let tabs: Tab[] = [];
/** The page a window was closed from, for focus to go back to its key. */
let closing: string | null = null;

/** The dock key for the place a page is in. */
function keyFor(href: string): HTMLElement | null {
  const t = tabs.filter((x) => !x.href.startsWith('#')).find((x) => href === x.href || (x.href !== '/' && href.startsWith(`${x.href}/`)));
  return t ? document.querySelector<HTMLElement>(`.loom-dock-bar [data-part="item"][aria-label="${CSS.escape(t.label)}"]`) : null;
}

// ---- minimized: a window shrunk back into its key, kept where it was -------------------------------------------

/** Where each app was left when its window was minimized, by its dock key (the key's href): the page, its query, and
 * how far down it was. This session's, in this tab (sessionStorage, read once; in memory alone where it can't be kept). */
type Left = Record<string, { url: string; top: number }>;
const LEFT = 'loom-desk-left';
const left: Left = (() => { try { const v = JSON.parse(sessionStorage.getItem(LEFT) ?? '{}') as unknown; return v && typeof v === 'object' ? v as Left : {}; } catch { return {}; } })();
const keepLeft = () => { try { sessionStorage.setItem(LEFT, JSON.stringify(left)); } catch { /* a private window: in memory only */ } };

/** Minimize (Jonathan, 2026-11-05: "like a real OS"): the app whose key is `key` is kept where it is, and the window
 * shrinks back into that key (deskGo's close), the desktop behind it. Without a key (a window opened from Find) it
 * simply goes. */
export function deskMinimize(key: string | undefined, url: string, top: number, go: (href: string) => void) {
  if (key) { left[key] = { url, top: Math.max(0, Math.round(top)) }; keepLeft(); }
  go('/');
}
/** Where the app under `key` was minimized, if it was: taken, so the window opened there again is open, not kept. */
export function deskRestore(key: string): { url: string; top: number } | undefined {
  const l = left[key];
  if (l) { delete left[key]; keepLeft(); }
  return l;
}
/** Closed, not minimized: its key opens the app at its start again. */
export function deskForget(key: string | undefined) {
  if (key && left[key]) { delete left[key]; keepLeft(); }
}

type VT = { finished: Promise<void> };
type Doc = Document & { startViewTransition?: (update: () => void) => VT };

/**
 * Going into an app from the desktop, or home from one: the window grows out of its dock key and shrinks back into it,
 * the desktop crossfading behind (View Transitions, desk.css). Its own attribute (data-desk-move), so none of a phone's
 * page moves apply. A window opened from Find or a link has no key: it simply grows in. Reduced motion (access.ts), or
 * no API: the page simply changes. Returns false for any other change (App.tsx moves it as it would).
 */
export function deskGo(from: string, to: string, update: () => void): boolean {
  const how = from === '/' && to !== '/' ? 'open' : from !== '/' && to === '/' ? 'close' : undefined;
  if (!how) return false;
  if (how === 'close') closing = from;
  const d = document as Doc;
  const root = document.documentElement;
  if (typeof d.startViewTransition !== 'function' || reducedMotion()) { update(); return true; }
  root.dataset.deskMove = how;
  let named: HTMLElement | null = how === 'open' ? keyFor(to) : null;
  if (named) named.style.viewTransitionName = 'loom-win';
  const vt = d.startViewTransition(() => {
    // One element per name in each state: the key gives its name to the window, or takes it back.
    if (named) named.style.viewTransitionName = '';
    update();
    if (how === 'close') { named = keyFor(from); if (named) named.style.viewTransitionName = 'loom-win'; }
  });
  const done = () => { if (root.dataset.deskMove === how) delete root.dataset.deskMove; if (named) named.style.viewTransitionName = ''; };
  vt.finished.then(done, done);
  return true;
}

/** Something open that Esc must leave alone: a sheet, a dialog, a list or a menu (Radix's, in a portal). */
const popUpOpen = () => !!document.querySelector(':is([role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]):not([data-state="closed"])');
/** A field has the keys. */
const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable); };

/** The desktop's keys: Esc closes the window back to the desktop (`close`: App.tsx, which forgets where it was), not
 * while a sheet, a dialog, a list or a menu is open (Esc closes that), nor while a field has the keys (Esc there is the
 * field's). And the dock's places, for keyFor. */
export function DeskKeys({ close, places }: { close: () => void; places: Tab[] }) {
  tabs = places;
  const now = useRef(close);
  now.current = close;
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || location.pathname === '/' || popUpOpen() || typing()) return;
      e.preventDefault();
      now.current();
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  return null;
}

/** One big window over the ground (desk.css): its title strip in the app's colour (its key, its name, where it is),
 * Close (and Esc) back to the desktop; a double-click on the strip (not on a control in it) minimizes it, as its open
 * key does (App.tsx); on a wide enough screen, where you've been lately beside it. Focus goes to its title as each page
 * opens in it, once per page (a page drawn again, Try again or a refresh, leaves focus be). */
export function DeskWindow({ tint, lead, title, url, waiting, go, close, minimize, children }: { tint: string; lead: React.ReactNode; title: string; url: string; waiting: boolean;
  go: (href: string) => void; close: () => void; minimize: () => void; children: React.ReactNode }) {
  const head = useRef<HTMLHeadingElement>(null);
  const focusedFor = useRef('');
  useEffect(() => {
    if (waiting || focusedFor.current === url) return;
    focusedFor.current = url;
    head.current?.focus({ preventScroll: true });
  }, [url, waiting]);
  const recents = useMemo(() => readRecent().filter((r) => r.href !== url).slice(0, 6), [url]);
  const path = url.split('?')[0];
  return (
    <section className="loom-window" aria-labelledby="loom-window-title" style={{ '--t': tint } as React.CSSProperties}>
      <div className="loom-window__bar" onDoubleClick={(e) => {
        if (e.button !== 0 || (e.target as Element).closest('button, a, input, select, textarea, [role="button"]')) return;
        e.preventDefault();
        minimize();
      }}>
        <span className="loom-window__key" aria-hidden>{lead}</span>
        <h2 id="loom-window-title" tabIndex={-1} ref={head}>{title || ' '}</h2>
        <span className="loom-window__path loom-data" aria-hidden>loom{path}</span>
        <button type="button" className="loom-window__close" aria-label="Close, back to the desktop" title="Close (Esc)" onClick={close}>
          <AnimatedIcon name={iconFor('x')} size="sm" /></button>
      </div>
      <div className="loom-window__body">
        {children}
        {recents.length > 0 && (
          <nav className="loom-window__side" aria-label="Recently opened">
            <h3>Lately</h3>
            <ul>{recents.map((r) => <li key={r.href}><a href={r.href} onClick={(e) => { e.preventDefault(); go(r.href); }}>{r.label}</a></li>)}</ul>
          </nav>
        )}
      </div>
    </section>
  );
}

// ---- the boot ----------------------------------------------------------------------------------

/** How long the boot stands before it leaves by itself, and how long it takes to leave (desk.css .loom-boot's fade). */
const BOOT_MS = 2200;
const BOOT_FADE_MS = 250;
/** When its last line (the licence) is up: every line is in by then, however many agents the household has. */
const BOOT_LINES_MS = 1100;

/** A name as a licence has it: "Jonathan Barket" → "Jonathan B."; one word stays as it is. */
const initialled = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  const first = w[0][0].toUpperCase() + w[0].slice(1);
  return w.length > 1 ? `${first} ${w[w.length - 1][0].toUpperCase()}.` : first;
};

type BootLine = { k: string; v: string; tone?: 'ok' | 'warn' };

/** What the boot says: only what the shell has. The link, the household and how each agent is (loom's own words for
 * it), the apps in its dock, what needs you, and the licence line, which is the one joke. */
function bootLines(shell: Shell, offline: boolean): BootLine[] {
  const n = shell.agents.length;
  const apps = shell.pieces.length;
  const shown = shell.agents.filter((a) => a.sub).slice(0, 5);
  const more = n - shown.length;
  return [
    { k: 'link', v: offline ? 'offline · saved copy' : 'live', tone: offline ? 'warn' : 'ok' },
    { k: 'household', v: `${n} agent${n === 1 ? '' : 's'}` },
    ...shown.map((a) => ({ k: a.label.toLowerCase(), v: a.sub! })),
    ...(more > 0 && shown.length ? [{ k: `+${more} more`, v: '' }] : []),
    { k: 'apps', v: String(apps) },
    { k: 'needs you', v: String(shell.asks), ...(shell.asks ? { tone: 'warn' as const } : {}) },
    { k: 'validating LOOM//OS™ license', v: 'compliant', tone: 'ok' },
  ];
}

/**
 * A desktop's boot (Jonathan, the prototype's power-on): once a session, never under reduced motion (App.tsx decides,
 * and runs the app's own arrival after it), a couple of seconds of a machine coming up. Its chatter is what loom has;
 * the licence line is the joke. Any key or tap skips it, and a tap that skips it presses nothing under it. It never takes
 * focus, and a screen reader doesn't hear it.
 */
export function DeskBoot({ shell, offline, onDone }: { shell: Shell; offline: boolean; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  // Who it's licensed to: the household owner's name as People has it ("Jonathan Barket"), as Find asks for it; until
  // that answers, the name loom's shell has.
  const [name, setName] = useState(shell.owner);
  useEffect(() => {
    const c = new AbortController();
    fetch('/find', { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: c.signal }).then((r) => r.json())
      .then((d: { suggest?: { people?: { label: string; href: string }[] } }) => {
        const me = d.suggest?.people?.find((p) => p.href === `/people/${shell.owner}`);
        if (me?.label) setName(me.label);
      }).catch(() => {});
    return () => c.abort();
  }, [shell.owner]);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let t2: ReturnType<typeof setTimeout> | undefined;
    const leave = () => { setLeaving(true); t2 = setTimeout(() => done.current(), BOOT_FADE_MS); };
    const t1 = setTimeout(leave, BOOT_MS);
    const skip = (e: Event) => { if (e.type === 'pointerdown') e.preventDefault(); clearTimeout(t1); if (!t2) leave(); };
    addEventListener('keydown', skip, true); addEventListener('pointerdown', skip, true);
    return () => { clearTimeout(t1); clearTimeout(t2); removeEventListener('keydown', skip, true); removeEventListener('pointerdown', skip, true); };
  }, []);
  const lines = bootLines(shell, offline);
  const step = (BOOT_LINES_MS - 350) / Math.max(1, lines.length - 1);
  return (
    <div className="loom-boot" data-leaving={leaving || undefined} aria-hidden="true">
      <div className="loom-boot__panel">
        <p className="loom-boot__brand">LOOM<i>//</i>OS<sup>™</sup></p>
        <p className="loom-boot__lic">licensed to {initialled(name)}</p>
        <ol className="loom-boot__log">
          {lines.map((l, i) => (
            <li key={i} style={{ '--at': `${Math.round(350 + i * step)}ms` } as React.CSSProperties}>
              <span className="loom-boot__k">{l.k}</span><span className="loom-boot__dots" /><span className="loom-boot__v" data-tone={l.tone}>{l.v}</span></li>
          ))}
        </ol>
        <p className="loom-boot__skip">any key to skip</p>
      </div>
    </div>
  );
}

/** Whether a desktop boots now: not yet this session (nor the app's arrival), and motion allowed (access.ts). Marked at
 * once, so a reload in the middle of it doesn't boot again. */
export function bootsNow(): boolean {
  if (reducedMotion()) return false;
  try {
    if (sessionStorage.getItem('loom-arrived') || sessionStorage.getItem('loom-booted')) return false;
    sessionStorage.setItem('loom-booted', '1');
    return true;
  } catch { return false; }
}
