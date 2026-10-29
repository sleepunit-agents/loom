/**
 * The shapes of loom's page data (what each JSON view carries, src/ui/handler.ts `view`), the links rule, and
 * the only HTML loom still writes itself: the sign-in pages, which come before a session. Every other page is
 * the app (web/, docs/specs/ui-app.md); the old HTML renderer went 2026-10-29. Every string that reaches the
 * sign-in pages goes through esc().
 */
import type { AgentState, Ask, Button, Reading, Tile, Tone, Doing } from './vocab.js';
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
  csrf: string;
  /** The one-time result of an action; `from` names the piece that sent it. */
  flash?: { ok: boolean; message: string; from?: string; keep?: boolean; undo?: { act: string; path: string; action: string; label?: string; fields?: Record<string, string> } };
  skipped: string[];
  /** The app shell (bottom bar, rail, scope and Places sheets); absent for the bare pages. */
  shell?: Shell;
}

/** An agent as the shell draws it: its mark is its initial on its color. */
export interface AgentView { id: string; label: string; bg: string; fg: string; href: string; current: boolean; /** What waits on this agent: its proposals, and asks that name it. */ asks?: number; /** Its status line on the Scope sheet, e.g. "active 42m ago". */ sub?: string }

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
  pieces: Array<{ label: string; href: string; current: boolean; tone?: Tone; stat?: string; kind?: 'place' | 'setting' }>;
  /** The page being shown, for the active tab: 'home', 'places', 'find', 'scope' or ''. */
  tab: string;
}

const HEAD_APP = '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icons/loom-32.png" sizes="32x32" type="image/png"><link rel="icon" href="/icons/loom-192.png" sizes="192x192" type="image/png"><link rel="apple-touch-icon" href="/icons/loom-180.png">' +
  '<meta name="theme-color" content="#F4F3EE" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0E0E0D" media="(prefers-color-scheme: dark)"><meta name="apple-mobile-web-app-capable" content="yes">';

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${HEAD_APP}<style>${STYLE}</style><script src="/app.js" defer></script></head><body>${body}</body></html>`;
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
export interface HomeAsk extends Ask { source: Source; /** The piece's tab label, for the card's source line. */ sourceLabel?: string }

// ─── Home, an agent's Today, and the sign-in pages ───

export interface ThreadRow { agent?: string; text: string; meta: string; at: string; page?: string }

/** Everything Home (or an agent's Today) shows, in the design's order. */
export interface Dashboard {
  /** 'Household', or the agent's name. */
  label: string;
  /** A headline in place of "N need you" (Activity's). */
  title?: string;
  /** An agent's Today: its mark, and Today · Mind · People · Setup. */
  agent?: { label: string; bg: string; fg: string; sub?: string; tabs: Array<{ label: string; href: string; current: boolean }> };
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

/** "40m", "2h", "3d": how long ago, short. */
export function age(iso: string | undefined, nowMs = Date.now()): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((nowMs - t) / 60_000));
  return m < 60 ? `${m}m` : m < 60 * 48 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

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

// ─── The Inbox (t-1621): folders, a list above the open item ─────────────────

export type InboxFolder = 'needs' | 'permission' | 'decision' | 'reply' | 'fyi' | 'answered';

/** One row in the Inbox: an ask (to allow, choose or answer), a notice (FYI) or one already answered. */
export interface InboxItem {
  key: string;
  /** What it is: an ask's kind, or fyi (a notice), or answered. */
  kind: 'permission' | 'decision' | 'reply' | 'fyi' | 'answered';
  /** It needs the owner: counted, and unread until opened. */
  attention: boolean;
  unread: boolean;
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
}

export const INBOX_FOLDERS: ReadonlyArray<{ id: InboxFolder; label: string; hint: string }> = [
  { id: 'needs', label: 'Needs you', hint: 'What blocks work or expires' },
  { id: 'permission', label: 'Permissions', hint: 'Approvals, secrets, boxes asking to join' },
  { id: 'decision', label: 'Decisions', hint: 'An agent asks you to choose' },
  { id: 'reply', label: 'Replies', hint: 'Someone waits on words, not a button' },
  { id: 'fyi', label: 'FYI', hint: 'News; never unread' },
  { id: 'answered', label: 'Answered', hint: 'What was decided, and what expired' },
];

/** Which items a folder holds. */
export function inFolder(f: InboxFolder, it: InboxItem): boolean {
  if (f === 'needs') return it.attention;
  return it.kind === f;
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
  /** Only what's wrong: a reading a piece marked bad or warn. Nothing here means its things are fine. */
  problems: Array<{ text: string; source: Source; page?: string; tone: 'bad' | 'warn' }>;
  /** When it was last on the tape, and where. */
  seen?: { at: string; where: string };
  readings: Array<Reading & { source: Source }>;
}

export interface HouseHome {
  headline: string;
  needs: number;
  firstNeed?: string;
  cards: AgentCard[];
  moving: Array<{ agent?: string; text: string; meta?: string }>;
  /** No pieces yet: a line, and a couple of catalog pieces to install. */
  firstRun?: Dashboard['firstRun'];
}

