// What loom answers (src/ui/handler.ts `view`, docs/specs/ui-app.md): the data each page is drawn from,
// and how a link or an action reaches loom. Mirrors src/ui/vocab.ts and src/ui/render.ts; no piece code here.

import type { Tint } from './tint';
import type { Prefs } from './look';
import type { ProjectCards } from '../../src/ui/project-cards';
export type Tone = 'ok' | 'warn' | 'bad' | 'muted';
export interface Source { id: string; base: string; act?: string }
export interface Ctx { source: Source; path: string; query: Record<string, string>; csrf: string; agents?: Record<string, { label: string; bg: string; fg: string; face?: { shape?: string; eyes?: string } }> }
export interface Button { action: string; label: string; tone?: 'primary' | 'danger'; confirm?: string; fields?: Record<string, string> }
export interface Field { name: string; label: string; kind: 'text' | 'textarea' | 'secret' | 'choice' | 'number' | 'date' | 'toggle' | 'check' | 'checks' | 'time' | 'segmented' | 'stepper'; value?: string; min?: number; max?: number; step?: number; unit?: string; hint?: string; required?: boolean; multiple?: boolean; options?: { value: string; label: string; detail?: string; swatch?: string }[] }
/** `cut`: loom cut one of its texts short to fit (src/ui/vocab.ts long()), and it says so beside the block. */
export type Block = BlockShape & { cut?: true };
type BlockShape =
  | { type: 'text'; text: string; tone?: Tone }
  | { type: 'prose'; text: string }
  | { type: 'callout'; text: string; title?: string; tone?: Tone; busy?: boolean }
  | { type: 'profile'; name: string; initials?: string; agent?: string; tone?: 'pink' | 'yellow' | 'olive' | 'blue'; summary?: string;
      badges?: string[]; stats?: Array<{ label: string; value: string; detail?: string; page?: string; source?: Source; tone?: Tone }>;
      links?: Array<{ text: string; page?: string; href?: string }> }
  | { type: 'list'; items: ListItem[]; numbered?: boolean; wrap?: boolean; who?: boolean }
  | { type: 'table'; columns: string[]; rows: (string | { text: string; page?: string })[][] }
  | { type: 'kv'; items: { label: string; value: string; page?: string }[] }
  | { type: 'stats'; items: { label: string; value: string; detail?: string; tone?: Tone; page?: string; spark?: number[]; meter?: number }[] }
  | { type: 'health'; tone: Tone; text: string; detail?: string }
  | { type: 'panel'; title?: string; rows: PanelRow[]; action?: Button }
  | { type: 'link'; text: string; page?: string; href?: string }
  /** Drawn by loom before a page is sent (src/comms-work.ts resolveFrom); one that reaches the app says only this much. */
  | { type: 'from'; conversation: string }
  | { type: 'details'; summary: string; meta?: string; blocks: Block[] }
  | { type: 'form'; action: string; submit: string; fields: Field[]; title?: string; note?: string; hidden?: Record<string, string>;
      submits?: { label: string; fields?: Record<string, string>; tone?: 'primary' | 'danger' }[] }
  | { type: 'buttons'; items: Button[] }
  | { type: 'meter'; items: { label: string; value: number; detail?: string; tone?: Tone }[] }
  | { type: 'status'; items: { label: string; tone?: Tone; text?: string; meta?: string }[] }
  | { type: 'code'; text: string }
  | { type: 'filters'; param: string; options: { value: string; label: string }[]; search?: string; switch?: boolean;
      chips?: { param: string; label: string; options: { value: string; label: string }[] }[] }
  | { type: 'chart'; kind: 'bar' | 'area' | 'line'; variant?: 'grouped' | 'stacked' | 'smooth' | 'step'; caption?: string; summary?: { label: string; value: string; detail?: string };
      series: { key: string; label: string; color?: 'pink' | 'blue' | 'olive' | 'yellow' | 'ink' }[]; data: ({ label: string } & Record<string, number | string | null>)[] }
  | { type: string; [k: string]: unknown };
export interface PanelRow {
  label: string; value?: string; detail?: string; tone?: Tone; agent?: string; page?: string; href?: string;
  toggle?: { action: string; on: boolean; fields?: Record<string, string> };
  choice?: { action: string; name: string; value: string; options: { value: string; label: string }[]; fields?: Record<string, string> };
  edit?: { action: string; title?: string; submit?: string; note?: string; fields: Field[]; hidden?: Record<string, string> };
  sheet?: { title?: string; blocks: Block[] };
  act?: Button;
}
export interface ListItem { text: string; meta?: string; badge?: string; tone?: Tone; agent?: string; person?: string; avatar?: string; page?: string; href?: string; act?: Button;
  /** Opens in place to these pairs; its page is then a link inside, named `open` (src/ui/vocab.ts RowMore). */
  more?: { items: { label: string; value: string }[]; open?: string } }
export interface Section { id: string; title?: string; place?: 'side'; /** The older spelling, in a copy kept from before. */ side?: boolean; tone?: Tone; fold?: 'open' | 'closed'; level?: string; blocks: Block[] }
export interface Page { title: string; intro?: string; sections: Section[]; refresh?: number }
export interface AgentView { id: string; label: string; bg: string; fg: string; face?: { shape?: string; eyes?: string; sprite?: { facings: string[]; v: string; base: string } }; href: string; current: boolean; asks?: number; sub?: string; working?: true }
export interface Shell {
  owner: string; admin?: boolean; scope: string; household: boolean; agents: AgentView[]; asks: number; home: string;
  back?: { label: string; href: string };
  core: { label: string; href: string; current: boolean; count?: number }[];
  pieces: { label: string; href: string; current: boolean; tone?: Tone; stat?: string; kind?: 'place' | 'setting'; icon?: string; accent?: Tint; alerts?: number;
    /** its own fit on a tiled desktop (a manifest's tab.fit: docs/specs/desk-tiling.md, "Fit") */
    fit?: { min?: [number, number]; ideal?: number; max?: number | null; big?: boolean } }[];
  /** The nightly backup, a household owner's (src/backup.ts backupRow). */
  backup?: { tone: 'ok' | 'warn' | 'bad'; text: string; href: string };
  /** The household's pixel icons (src/icon-set.ts), when it has a set in use: the apps it has one for. */
  icons?: { v: string; apps: Record<string, { line?: true }> };
  tab: string;
}
export interface Flash { ok: boolean; message: string; from?: string; keep?: boolean; undo?: { act: string; path: string; action: string; label?: string; fields?: Record<string, string> } }
export interface Chrome { agent: string; nav: { label: string; href: string; current: boolean; piece: boolean }[]; clock: string; tz?: string; csrf: string; flash?: Flash; skipped: string[]; shell?: Shell;
  /** The signed-in person's Appearance (look.ts), as loom keeps it. */
  prefs?: Prefs }
export interface AgentHead { label: string; bg: string; fg: string; sub?: string; tabs: { label: string; href: string; current: boolean }[];
  id?: string; bio?: string; today?: number; waiting?: number; active?: string;
  /** Its window's (t-1925 D): the household's description (never its creed), may this viewer edit it, asked to write one, working now. */
  about?: string; edit?: boolean; asked?: boolean; working?: boolean }

export type View =
  | { view: 'page'; page: Page; ctx: Ctx; chrome: Chrome; head?: AgentHead; unscoped?: string; /** The Projects index's cards (web/src/projects.tsx). */ projects?: ProjectCards }
  | { view: 'home' | 'house-home' | 'dashboard' | 'inbox' | 'sheet' | 'passkeys' | 'comms' | 'knowledge'; chrome: Chrome; ctx?: Ctx; [k: string]: unknown };

// ---- links: loom's own rule (src/ui/vocab.ts splitPage, render.ts pageHref) ----------------------

// loom's own pages, as src/ui/vocab.ts has them (a conversation's too: a Needs you links to it).
const CORE_PAGES = /^(|inbox|activity|mind|people|pieces|passkeys|p\/[a-z][a-z0-9-]{0,39}(?:\/.*)?|people\/[a-z0-9][a-z0-9-]*|memory\/.+|knowledge|knowledge\/.+|new-agent|new-person|new-fact|conversation\/cv-[0-9a-f]{12}|comms\/th:[a-z2-7]{10}|a\/[a-z][a-z0-9-]{0,39}(|\/mind|\/setup|\/people|\/people\/[a-z0-9][a-z0-9-]*|\/memory\/.+|\/conversation\/cv-[0-9a-f]{12}))$/;

export function pageHref(link: string, source: Source): string {
  const ag = /^agent:([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/.exec(link);
  if (ag) return source.id === 'loom' ? '#' : `/a/${ag[1]}/p/${source.id}/${ag[2] ?? ''}`.replace(/\/$/, '');
  if (link.startsWith('household:')) return source.id === 'loom' ? '#' : `/p/${source.id}/${link.slice(10)}`.replace(/\/$/, '');
  const core = link.startsWith('loom:');
  const rest = core ? link.slice(5) : link;
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  if (core && !CORE_PAGES.test(path)) return '#';
  const base = core ? '/' : source.base;
  const url = path === '' ? (base === '/' ? '/' : base.replace(/\/$/, '')) : base + path;
  return url + (q === -1 ? '' : rest.slice(q));
}

// ---- reaching loom --------------------------------------------------------------------------------

/** How far loom's clock is from this device's (ms), from the Date header of loom's latest answer (a kept copy, answered
 * by the service worker, says nothing about now). The system bar's clock is loom's (system-bar.tsx). */
let loomSkew = 0;
export const loomNow = () => Date.now() + loomSkew;
function noteLoomTime(r: Response) {
  const at = Date.parse(r.headers.get('date') ?? '');
  // The header is to the second: its middle is the best guess.
  if (!r.headers.has('x-loom-saved-at') && Number.isFinite(at)) loomSkew = at + 500 - Date.now();
}

/** A view; `savedAt` when loom couldn't be reached and the service worker answered with its kept copy (src/ui/pwa.ts). */
/** A view; `redirect` when loom sent it elsewhere (the address to show, or the sign-in page to load whole). */
export async function fetchView(url: string, etag?: string): Promise<{ status: number; data?: View; redirect?: string; savedAt?: string; etag?: string }> {
  const r = await fetch(url, { headers: { accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) }, credentials: 'same-origin' });
  noteLoomTime(r);
  if (r.status === 304) return { status: 304, etag };
  const landed = r.redirected ? new URL(r.url) : null;
  const redirect = landed && landed.origin === location.origin ? landed.pathname + landed.search : undefined;
  if (!(r.headers.get('content-type') ?? '').startsWith('application/json')) return { status: r.status, redirect: redirect ?? (landed ? r.url : undefined) };
  if (redirect) return { status: r.status, data: (await r.json()) as View, redirect, savedAt: r.headers.get('x-loom-saved-at') ?? undefined };
  return { status: r.status, data: (await r.json()) as View, savedAt: r.headers.get('x-loom-saved-at') ?? undefined, etag: r.headers.get('etag') ?? undefined };
}

export interface ActResult { ok: boolean; message: string; from?: string; keep?: boolean; undo?: Flash['undo']; go?: string }

/** An action, as loom's page posts it (src/ui/handler.ts: /act/<source> or /a/<agent>/act/<piece>). */
export async function act(ctx: Ctx, csrf: string, action: string, fields: Record<string, string>, act?: string): Promise<ActResult> {
  const body = new URLSearchParams({ _csrf: csrf, _action: action, _path: ctx.path + qs(ctx.query), ...fields });
  const r = await fetch(act ?? ctx.source.act ?? `/act/${ctx.source.id}`, {
    method: 'POST', credentials: 'same-origin', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
  }).catch(() => undefined);
  if (!r) return { ok: false, message: 'Can’t reach loom: nothing was sent. Try again when there’s a connection.' };
  if (!(r.headers.get('content-type') ?? '').startsWith('application/json')) {
    return { ok: false, message: r.status === 403 ? 'That form is stale: reload and try again.' : 'That didn’t go through: loom had a problem. Try again in a moment.' };
  }
  return (await r.json()) as ActResult;
}

function qs(q: Record<string, string>): string {
  const s = new URLSearchParams(q).toString();
  return s ? `?${s}` : '';
}

/** An Inbox item, read (src/ui/handler.ts /inbox/read): as opening it at /inbox?i=<key> would. */
export async function markRead(key: string, csrf: string): Promise<boolean> {
  const r = await fetch('/inbox/read', { method: 'POST', credentials: 'same-origin', body: new URLSearchParams({ _csrf: csrf, i: key }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' } }).catch(() => undefined);
  return !!r?.ok;
}
