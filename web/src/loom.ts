// What loom answers (src/ui/handler.ts `view`, docs/specs/ui-app.md): the data each page is drawn from,
// and how a link or an action reaches loom. Mirrors src/ui/vocab.ts and src/ui/render.ts; no piece code here.

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';
export interface Source { id: string; base: string; act?: string }
export interface Ctx { source: Source; path: string; query: Record<string, string>; csrf: string; agents?: Record<string, { label: string; bg: string; fg: string }> }
export interface Button { action: string; label: string; tone?: 'primary' | 'danger'; confirm?: string; fields?: Record<string, string> }
export interface Field { name: string; label: string; kind: 'text' | 'textarea' | 'secret' | 'choice' | 'number' | 'date' | 'toggle' | 'check' | 'checks'; value?: string; hint?: string; required?: boolean; options?: { value: string; label: string; detail?: string; swatch?: string }[] }
export type Block =
  | { type: 'text'; text: string; tone?: Tone }
  | { type: 'prose'; text: string }
  | { type: 'callout'; text: string; title?: string; tone?: Tone }
  | { type: 'list'; items: ListItem[]; numbered?: boolean }
  | { type: 'table'; columns: string[]; rows: (string | { text: string; page?: string })[][] }
  | { type: 'kv'; items: { label: string; value: string; page?: string }[] }
  | { type: 'stats'; items: { label: string; value: string; detail?: string; tone?: Tone; page?: string }[] }
  | { type: 'link'; text: string; page?: string; href?: string }
  | { type: 'details'; summary: string; meta?: string; blocks: Block[] }
  | { type: 'form'; action: string; submit: string; fields: Field[]; title?: string; note?: string; hidden?: Record<string, string> }
  | { type: 'buttons'; items: Button[] }
  | { type: 'meter'; items: { label: string; value: number; detail?: string; tone?: Tone }[] }
  | { type: 'status'; items: { label: string; tone?: Tone; text?: string; meta?: string }[] }
  | { type: 'code'; text: string }
  | { type: 'filters'; param: string; options: { value: string; label: string }[]; search?: string }
  | { type: string; [k: string]: unknown };
export interface ListItem { text: string; meta?: string; badge?: string; tone?: Tone; agent?: string; page?: string; href?: string; act?: Button }
export interface Section { id: string; title?: string; side?: boolean; tone?: Tone; level?: string; blocks: Block[] }
export interface Page { title: string; intro?: string; sections: Section[]; refresh?: number }
export interface AgentView { id: string; label: string; bg: string; fg: string; href: string; current: boolean; asks?: number; sub?: string }
export interface Shell {
  owner: string; admin?: boolean; scope: string; household: boolean; agents: AgentView[]; asks: number; home: string;
  back?: { label: string; href: string };
  core: { label: string; href: string; current: boolean; count?: number }[];
  pieces: { label: string; href: string; current: boolean; tone?: Tone; stat?: string; kind?: 'place' | 'setting' }[];
  tab: string;
}
export interface Flash { ok: boolean; message: string; from?: string; keep?: boolean; undo?: { act: string; path: string; action: string; label?: string; fields?: Record<string, string> } }
export interface Chrome { agent: string; nav: { label: string; href: string; current: boolean; piece: boolean }[]; clock: string; csrf: string; flash?: Flash; skipped: string[]; shell?: Shell }
export interface AgentHead { label: string; bg: string; fg: string; sub?: string; tabs: { label: string; href: string; current: boolean }[] }

export type View =
  | { view: 'page'; page: Page; ctx: Ctx; chrome: Chrome; head?: AgentHead; unscoped?: string }
  | { view: 'home' | 'house-home' | 'dashboard' | 'inbox' | 'sheet' | 'passkeys'; chrome: Chrome; ctx?: Ctx; [k: string]: unknown };

// ---- links: loom's own rule (src/ui/vocab.ts splitPage, render.ts pageHref) ----------------------

const CORE_PAGES = /^(|inbox|activity|mind|people|pieces|passkeys|p\/[a-z][a-z0-9-]{0,39}(?:\/.*)?|people\/[a-z0-9][a-z0-9-]*|memory\/.+|knowledge|knowledge\/.+|new-agent|new-person|new-fact|a\/[a-z][a-z0-9-]{0,39}(|\/mind|\/setup|\/people|\/people\/[a-z0-9][a-z0-9-]*|\/memory\/.+))$/;

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

/** A view; `savedAt` when loom couldn't be reached and the service worker answered with its kept copy (src/ui/pwa.ts). */
/** A view; `redirect` when loom sent it elsewhere (the address to show, or the sign-in page to load whole). */
export async function fetchView(url: string, etag?: string): Promise<{ status: number; data?: View; redirect?: string; savedAt?: string; etag?: string }> {
  const r = await fetch(url, { headers: { accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) }, credentials: 'same-origin' });
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
    return { ok: false, message: r.status === 403 ? 'That form is stale: reload and try again.' : `loom answered ${r.status}` };
  }
  return (await r.json()) as ActResult;
}

function qs(q: Record<string, string>): string {
  const s = new URLSearchParams(q).toString();
  return s ? `?${s}` : '';
}
