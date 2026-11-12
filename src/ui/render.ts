/**
 * The shapes of loom's page data (what each JSON view carries, src/ui/handler.ts `view`), the links rule, and
 * the only HTML loom still writes itself: the sign-in pages, which come before a session. Every other page is
 * the app (web/, docs/specs/ui-app.md); the old HTML renderer went 2026-10-29. Every string that reaches the
 * sign-in pages goes through esc().
 */
import type { Accent, AgentState, Ask, Button, Reading, Tile, Tone, Doing, Job } from './vocab.js';
import { splitPage } from './vocab.js';
import { STYLE } from './style.js';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whose page this is: loom's own (`loom`) or a piece's. `base` is where its
 * page links resolve; `act` is where its forms post (one agent's view in a
 * household posts to that agent).
 */
export interface Source { id: string; base: string; act?: string }

export const CORE: Source = { id: 'loom', base: '/' };
export const pieceSource = (piece: string): Source => ({ id: piece, base: `/p/${piece}/` });
/** One agent's view in a household. */
export const agentSource = (agent: string): Source => ({ id: 'loom', base: `/a/${agent}/`, act: `/a/${agent}/act/loom` });

function qs(query: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Where a page link goes. Pieces' links stay inside their own base unless they say `loom:`. */
export function pageHref(link: string, source: Source): string {
  const s = splitPage(link);
  if (!s) return '#';
  // agent:/household: are this piece's own pages under an agent or the household; loom's own pages have neither.
  if ((s.agent || s.household) && source.id === 'loom') return '#';
  const base = s.core ? CORE.base : s.agent ? `/a/${s.agent}/p/${source.id}/` : s.household ? `/p/${source.id}/` : source.base;
  const url = s.path === '' ? (base === CORE.base ? '/' : base.replace(/\/$/, '')) : base + s.path;
  return url + qs(s.query);
}

export interface Chrome {
  agent: string;
  nav: Array<{ label: string; href: string; current: boolean; piece: boolean }>;
  clock: string;
  /** loom's time zone (uiTimeZone: LOOM_TIMEZONE, else TZ), the one every page says a time in, for the app's own clock
   * (web/src/system-bar.tsx; loom's time itself is each answer's Date header, so the page's ETag holds). */
  tz?: string;
  csrf: string;
  /** The one-time result of an action; `from` names the piece that sent it. */
  flash?: { ok: boolean; message: string; from?: string; keep?: boolean; undo?: { act: string; path: string; action: string; label?: string; fields?: Record<string, string> } };
  skipped: string[];
  /** The app shell (bottom bar, rail, scope and Places sheets); absent for the bare pages. */
  shell?: Shell;
}

/** An agent as the shell draws it: its mark is its initial on its color. */
export interface TickerActivity { action: string; where?: string; observedAt: string; expiresAt: string; href?: string }
export interface AgentView { activity?: TickerActivity; activityUnavailable?: boolean; id: string; label: string; bg: string; fg: string; href: string; current: boolean; /** What waits on this agent: its proposals, and asks that name it. */ asks?: number; /** Its status line on the Scope sheet, e.g. "active 42m ago". */ sub?: string; /** A piece reports it at work (the system bar's count). */ working?: true }

export interface Shell {
  owner: string;
  /** false for an agent owner (docs/specs/owners.md): no Members, no managing pieces. */
  admin?: boolean;
  /** 'household', or the selected agent's id. */
  scope: string;
  household: boolean;
  agents: AgentView[];
  /** Asks waiting, for the scope sheet's count. */
  asks: number;
  /** Where the Home tab goes in this scope. */
  home: string;
  /** A page below the top: where its back link goes, by name ("‹ Knowledge"). */
  back?: { label: string; href: string };
  /** Loom's own places: Knowledge, People (and Mind for a lone agent). */
  core: Array<{ label: string; href: string; current: boolean; count?: number }>;
  /** Installed pieces with a tab, each with its tile's value or tone. */
  /** kind: a place (Places) or a setting (Setup), from the piece's tab.kind or the catalog. */
  /** alerts: how many of its asks say something's wrong (kind 'alert'), for the system bar's icons (Boxes). */
  pieces: Array<{ label: string; href: string; current: boolean; tone?: Tone; stat?: string; kind?: 'place' | 'setting'; icon?: string; accent?: Accent; alerts?: number }>;
  /** The nightly backup (src/backup.ts backupRow): a household owner's only, never an agent owner's. */
  backup?: { tone: 'ok' | 'warn' | 'bad'; text: string; href: string };
  /** The household's pixel icons (src/icon-set.ts), when it has a set in use: the apps it has one for (line: line-only, inverted
   * on a dark key), and its version. Each is /pixel-icons/<app>.png?v=<v>, for someone signed in. */
  icons?: { v: string; apps: Record<string, { line?: true }> };
  /** The household's Permissions page (the grants authority's), a household owner's only (t-1970). */
  permissions?: string;
  /** The page being shown, for the active tab: 'home', 'places', 'find', 'scope', 'setup', 'appearance', 'accessibility' or ''. */
  tab: string;
}

const HEAD_APP = '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icons/loom-32.png" sizes="32x32" type="image/png"><link rel="icon" href="/icons/loom-192.png" sizes="192x192" type="image/png"><link rel="apple-touch-icon" href="/icons/loom-180.png">' +
  '<meta name="theme-color" content="#F4F3EE" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0E0E0D" media="(prefers-color-scheme: dark)"><meta name="apple-mobile-web-app-capable" content="yes">';

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>${esc(title)}</title>${HEAD_APP}<style>${STYLE}</style><script src="/app.js" defer></script></head><body>${body}</body></html>`;
}

// ─── The sheets: Scope, Places, Find ───

const LOGO_LARGE = '<img class="logo" src="/icons/loom-192.png" width="64" height="64" alt="">';

/** The sheets as pages (no script, or a link straight to them), and Find. */
/** Find's other groups, from the handler: what needs doing, and the household's knowledge, people and memories. */
export interface Found {
  do: Array<{ label: string; href: string }>;
  knowledge: Array<{ label: string; href: string }>;
  people: Array<{ label: string; href: string }>;
  memories: Array<{ label: string; href: string; agent: string }>;
}

export interface HomeTile extends Tile { source: Source }
export interface HomeAsk extends Ask { source: Source; /** The piece's tab label, for the card's source line. */ sourceLabel?: string;
  /** Another agent whose request this agent passed on (a relay conversation's sender, t-1970): "Mark asks, via Art". Core's only. */
  relayedFrom?: string;
  /** The exact thing it's about, outside loom (a pull request's URL): its sheet's first button. Core's asks only. */
  href?: string;
  /** Its sheet has a box to answer the agent in words: posted as `action` with `fields` and the words as `text`. Core's only. */
  reply?: { action: string; label: string; fields: Record<string, string> };
  /** A Needs you laid out (its text is the ask): why, what happens either way, the ids it's about, and where it came from. */
  needs?: NeedsView;
  /** The approval it waits on, absorbed: that card's words and its own Allow and Deny, posted to its piece. */
  approval?: ApprovalView;
  /** The approval id it waits on (core's own; not sent). */
  waitsOnApproval?: string;
  /** The task id it waits on (core's own; not sent): folded into that task's own ask card, when there is one (t-2098). */
  waitsOnTask?: string;
  /** A memory an agent proposed (core's own): the Inbox files it under Memory reviews. */
  memory?: boolean }

export interface NeedsView { why?: string; if_yes?: string; if_no?: string; answers: 'yes-no' | 'words'; refs: string[]; details: string }
export interface ApprovalView { text: string; meta?: string; actions: Button[]; source: Source; if_yes?: string; if_no?: string; fine?: string; details?: string;
  /** The conversation the approval itself was asked from (its own card's), when it names one: its Comms thread's. */
  conversation?: string }

// ─── Home, an agent's Today, and the sign-in pages ───

/** A row of the thread: `meta` is where and how long ago ("Wake · 3h"); `where` alone ("Wake"), for a chip. */
export interface ThreadRow { agent?: string; text: string; meta: string; where?: string; at: string; page?: string }

/** Everything Home (or an agent's Today) shows, in the design's order. */
export interface Dashboard {
  /** 'Household', or the agent's name. */
  label: string;
  /** A headline in place of "N need you" (Activity's). */
  title?: string;
  /** An agent's Today: its mark, and Today · Mind · People · Setup. */
  agent?: { label: string; bg: string; fg: string; sub?: string; tabs: Array<{ label: string; href: string; current: boolean }>;
    /** Its Today opens on a profile (Jonathan, 2026-10-29): its id, the identity's opening paragraph, today's count. */
    id?: string; bio?: string; today?: number; waiting?: number; active?: string;
    /** Its window's (t-1925 D): the household's description of it, may this viewer edit it, asked to write one, working now. */
    about?: string; edit?: boolean; asked?: boolean; working?: boolean;
    /** Its page of what it can use (t-1970). */
    permissions?: string;
    /** What it is on, while working (t-1945): its newest doing row, and a link where loom has one (a Comms thread, for its member). */
    on?: { text: string; href?: string } };
  asks: HomeAsk[];
  /** A household's Home: what needs the owner is in the Inbox; Home says how much, and links there, instead of the cards. */
  inbox?: { count: number; first?: string };
  tiles: HomeTile[];
  thread: ThreadRow[];
  /** "Since you last looked" (epoch ms); rows after it get a new dot, and a line marks it. */
  sinceMs?: number;
  sinceLabel?: string;
  /** Pills over the Thread: All and each agent. */
  filters?: { param: string; current: string; options: Array<{ value: string; label: string }> };
  shared?: { pages: number; people: number };
  more?: { label: string; href: string };
  /** First run (no pieces yet): a line under the headline, and a couple of catalog pieces to install. */
  firstRun?: { line: string; starters: Array<{ name: string; label: string; what: string }> };
}

/** "now", "40m", "2h", "3d": how long ago, short (under a minute is "now", never "0m"). */
export function age(iso: string | undefined, nowMs = Date.now()): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((nowMs - t) / 60_000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 60 * 48 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/** "just now", "40m ago": an age in a sentence. */
export const agoText = (iso: string | undefined, nowMs = Date.now()): string => { const a = age(iso, nowMs); return a === 'now' ? 'just now' : a ? `${a} ago` : ''; };

export type AgentHead = NonNullable<Dashboard['agent']>;

/** A one-time sign-in link's page: a button, so a link preview can't spend it. */
export function renderLoginLink(code: string, error?: string): string {
  return document(
    'loom',
    error
      ? `<div class="login"><h1>loom</h1><p class="err">${esc(error)}</p><p class="sub">Ask for a new link (<code>loom token link</code>), or <a href="/login">sign in with a token</a>.</p></div>`
      : `<form class="login" method="post" action="/login/${esc(code)}"><h1>loom</h1><p class="sub">This link signs this browser in, once. It keeps a cookie for 30 days.</p><button type="submit">Sign in</button></form>`,
  );
}

const PASSKEY_ICON = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="7" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M2.5 17c.6-3 2.8-4.6 5.5-4.6 1.2 0 2.3.3 3.2.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="15" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15 12v5l1.2-1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Sign in, per its board: loom's mark in the middle; at the bottom a passkey (where they work), "or", a token and Go. */
export function renderLogin(error?: string, passkey: { rp?: string; here: boolean } = { here: false }): string {
  // A passkey button only where passkeys work (LOOM_PUBLIC_URL's origin); the script is loom's one (/login/passkey.js).
  const pk = passkey.here
    ? `<button type="button" id="passkey-signin" class="pk">${PASSKEY_ICON}<span>Sign in with passkey</span></button><p class="sub" id="passkey-msg" role="status"></p><div class="or" aria-hidden="true"><span>or</span></div>`
    : passkey.rp ? `<p class="sub">Passkeys work at <a href="${esc(passkey.rp)}/login">${esc(passkey.rp)}</a>.</p>` : '';
  return document(
    'loom',
    `<div class="signin"><div class="signin-mark">${LOGO_LARGE}<span>loom</span></div>` +
    `<form class="signin-bottom" method="post" action="/login">${error ? `<p class="err">${esc(error)}</p>` : ''}${pk}` +
    `<div class="token-row"><input type="password" name="token" placeholder="Token" autocomplete="current-password" ${passkey.here ? '' : 'autofocus '}aria-label="token"><button type="submit">Go</button></div>` +
    `<p class="sub hint">Or open a sign-in link (<code>loom token link</code>). This browser stays signed in for 30 days.</p></form></div>${
      passkey.here ? '<script src="/login/passkey.js" defer></script>' : ''}`,
  );
}

// ─── The Inbox (t-1621; a mail client, t-1925): folders, a list, the open item beside it ─────────────

/** The Inbox's folders (Jonathan's approved mock, 2026-11-06): what needs you, then what's open by what it wants from you
 * (a question to answer, an approval to give, an alert to look at, a memory to review), then Done: the history. */
export type InboxFolder = 'needs' | 'question' | 'approval' | 'alert' | 'memory' | 'done';
/** The folder an item files under besides Needs you. */
export type InboxBox = Exclude<InboxFolder, 'needs'>;

/** One row in the Inbox: an ask (to allow, choose or answer), a notice (FYI) or one already answered. */
export interface InboxItem {
  key: string;
  /** What it is: an ask's kind, or fyi (a notice), or answered. */
  kind: 'permission' | 'decision' | 'reply' | 'alert' | 'todo' | 'fyi' | 'answered';
  /** Its folder (inboxBox): what it wants from you while it's open, else done. */
  box: InboxBox;
  /** It needs the owner: counted, and unread until opened. */
  attention: boolean;
  unread: boolean;
  /** When this reader opened it (ISO), for its trail. */
  seen?: string;
  text: string;
  meta?: string;
  at?: string;
  expires?: string;
  agent?: string;
  source: Source;
  sourceLabel?: string;
  page?: string;
  label?: string;
  actions?: Button[];
  outcome?: string;
  href?: string;
  reply?: HomeAsk['reply'];
  needs?: NeedsView;
  approval?: ApprovalView;
  /** Approval dependency, even while its live card is unavailable. Never a conversational Yes/No. */
  waitsOnApproval?: string;
  /** Exactly what its yes allows (a piece's machine fields: a kind and a target), as small print. */
  fine?: string;
  /** The agent whose request it passes on (HomeAsk's): who asks is them, via `agent`. */
  relayedFrom?: string;
  /** The conversation a piece's ask was asked from (a cv- id): its Comms thread shows it too (comms.md, "Asks inline"). */
  conversation?: string;
}

export const INBOX_FOLDERS: ReadonlyArray<{ id: InboxFolder; label: string; hint: string }> = [
  { id: 'needs', label: 'Needs you', hint: 'Everything open that waits on you' },
  { id: 'question', label: 'Questions', hint: 'An agent asks you something: yes or no, or in words' },
  { id: 'approval', label: 'Approvals', hint: 'Allow or deny: access, secrets, boxes asking to join' },
  { id: 'alert', label: 'Alerts', hint: 'Something is wrong; nothing to choose' },
  { id: 'memory', label: 'Memory reviews', hint: 'An agent wants to remember something' },
  { id: 'done', label: 'Done', hint: 'What was answered, news, and what you did' },
];

/** An old folder's address (`?f=fyi`, before t-1925) still lands somewhere sensible. */
const OLD_FOLDER: Record<string, InboxFolder> = { permission: 'approval', decision: 'question', reply: 'question', todo: 'question', fyi: 'done', answered: 'done' };
export function folderOf(f: unknown): InboxFolder {
  if (typeof f !== 'string') return 'needs';
  return INBOX_FOLDERS.find((x) => x.id === f)?.id ?? OLD_FOLDER[f] ?? 'needs';
}

/** Which folder an item files under: done once it's history (answered, news); else, open (whether or not it's counted
 * in Needs you), an approval (a permission, or an ask that holds one), a memory to review, a question (anything that
 * wants an answer: a decision, words, a task), or an alert. */
export function inboxBox(it: { kind: InboxItem['kind']; attention: boolean; approval?: unknown; reply?: unknown; needs?: unknown; memory?: boolean }): InboxBox {
  if (it.kind === 'answered' || it.kind === 'fyi') return 'done';
  if (it.kind === 'permission' || it.approval) return 'approval';
  if (it.memory) return 'memory';
  if (it.kind === 'decision' || it.kind === 'reply' || it.kind === 'todo' || it.reply || it.needs) return 'question';
  return 'alert';
}

/** Which items a folder holds. */
export function inFolder(f: InboxFolder, it: InboxItem): boolean {
  if (f === 'needs') return it.attention;
  return it.box === f;
}

// ─── Home (t-1622): how the agents are, whether the house is OK, what's moving ─

/** An agent's card on Home: its state (the worst any piece reports), why, and the pieces' readings. */
export interface AgentCard {
  id: string;
  label: string;
  bg: string;
  fg: string;
  state: AgentState;
  reason: string;
  /** What it has going right now, from every piece: a summary, the details a tap away (Jonathan, 2026-10-29). */
  doing: Array<Doing & { source: Source }>;
  jobs?: Array<Job & { source: Source }>;
  /** Only what's wrong: a reading a piece marked bad or warn. Nothing here means its things are fine. */
  problems: Array<{ text: string; source: Source; page?: string; tone: 'bad' | 'warn' }>;
  /** When it was last on the tape, and where. */
  seen?: { at: string; where: string };
  readings: Array<Reading & { source: Source }>;
  steps?: Array<{ text: string; at: string; where: string }>;
  /** What's moving for it: each piece that says it's working, and why (Home's "moving", made per agent). */
  moving: Array<{ agent: string; text: string; meta?: string }>;
}

export interface HouseHome {
  headline: string;
  needs: number;
  /** The first of them, whole: Home draws it as its Inbox row, and it opens as it does there (to the item). */
  need?: InboxItem;
  /** The first few of them, whole, for a desktop's Home (web/src/desk.tsx): each answered where it stands. */
  stack?: InboxItem[];
  cards: AgentCard[];
  moving: Array<{ agent?: string; text: string; meta?: string }>;
  /** No pieces yet: a line, and a couple of catalog pieces to install. */
  firstRun?: Dashboard['firstRun'];
}

