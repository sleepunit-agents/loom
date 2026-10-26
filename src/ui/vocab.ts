/**
 * The page vocabulary (docs/extensions.md, "The page").
 *
 * loom's page is built from these shapes, both loom's own pages and the
 * installed pieces'. A piece answers `ui --json` (a manifest), `ui page --json`
 * (a page) and `ui act --json` (an action's result) in this vocabulary. Pieces
 * send data, never markup: loom renders every block itself and escapes every
 * string, so a piece can't put HTML or script on loom's page. Anything that
 * doesn't validate is dropped whole (a piece that sends garbage just isn't
 * shown), never half-rendered.
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

/** Where a link goes: a page of the same source, one of loom's (`loom:` prefix), or outside. */
export interface Target { page?: string; href?: string }

export type Cell = string | { text: string; page?: string };

export interface Field {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'choice' | 'secret';
  hint?: string;
  value?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string; detail?: string; swatch?: string }>;
}

/** A button: posts its action (with fields) to the piece; danger asks first, with confirm. */
export interface Button { action: string; label: string; tone?: 'primary' | 'danger'; confirm?: string; fields?: Record<string, string> }

export type Block =
  | { type: 'stats'; items: Array<{ label: string; value: string; detail?: string; tone?: Tone; page?: string }> }
  | { type: 'list'; numbered?: boolean; items: Array<{ text: string; meta?: string; badge?: string; tone?: Tone; agent?: string; avatar?: string; act?: Button } & Target> }
  | { type: 'table'; columns: string[]; rows: Cell[][] }
  | { type: 'kv'; items: Array<{ label: string; value: string; page?: string }> }
  | { type: 'text'; text: string; tone?: Tone }
  | { type: 'prose'; text: string }
  | { type: 'callout'; text: string; title?: string; tone?: Tone }
  | ({ type: 'link'; text: string } & Target)
  | { type: 'filters'; param: string; options: Array<{ value: string; label: string }>; search?: string }
  | { type: 'details'; summary: string; meta?: string; blocks: Block[] }
  | { type: 'form'; action: string; submit: string; fields: Field[]; title?: string; note?: string; hidden?: Record<string, string> }
  | { type: 'buttons'; items: Button[] }
  | { type: 'meter'; items: Array<{ label: string; value: number; detail?: string; tone?: Tone }> }
  | { type: 'code'; text: string; label?: string }
  | { type: 'status'; items: Array<{ label: string; tone?: Tone; text?: string; meta?: string; page?: string }> };

export interface Section {
  id: string;
  title?: string;
  side?: boolean;
  tone?: Tone;
  blocks: Block[];
}

export interface Page {
  title: string;
  intro?: string;
  sections: Section[];
  /** Seconds between reloads, 2 to 300, while something is changing (an install, a session starting). */
  refresh?: number;
  /** The board's "+" beside the title: where adding one goes (a page of this source, or loom's with `loom:`). */
  add?: { page: string; label: string };
}

export interface Tile { label: string; value: string; detail?: string; tone?: Tone; page?: string }
/** A decision only the owner can make. `tone` tints its card; `at` (ISO time) gives its age; `agent` puts that agent's mark on it. */
export interface Ask { text: string; meta?: string; page?: string; label?: string; tone?: Tone; at?: string; agent?: string; /** Up to two buttons on its card (Ratify and Reject): posted to the piece, like a buttons block's. */ actions?: Button[] }

export interface Manifest {
  /** The piece narrows its data to the agent in LOOM_SCOPE; without it, loom says it shows the whole household. */
  scope?: boolean;
  /** kind: 'setting' puts it under Setup (rarely visited: boxes, subscriptions); a place by default. */
  tab?: { label: string; kind?: 'place' | 'setting' };
  tile?: Tile;
  asks: Ask[];
  /** A first-version answer: these sections become the piece's page. */
  legacy?: Section[];
}

/** keep: the message is something to copy (a token shown once), so it stays until it's closed. */
/** An action that takes this one back, offered as Undo on the message: posted to the same source, like a button. */
export interface Undo { action: string; label?: string; fields?: Record<string, string> }
export interface ActResult { ok: boolean; message: string; page?: string; keep?: boolean; undo?: Undo }

export const LIMITS = {
  sections: 10,
  blocks: 20,
  items: 200,
  columns: 12,
  string: 2000,
  asks: 10,
  fields: 30,
  hidden: 20,
  options: 50,
  query: 10,
  queryValue: 200,
  path: 200,
  /** A prose block's markdown: a page's whole body. */
  prose: 20000,
} as const;

const TONES: ReadonlySet<string> = new Set(['ok', 'warn', 'bad', 'muted']);
export const ID = /^[a-z][a-z0-9-]{0,39}$/;
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
export const QUERY_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const PATH_CHARS = /^[a-z0-9._~/-]*$/;

class Invalid extends Error {}

/** loom's own pages a link may name with `loom:`. */
const CORE_PAGES = /^(|mind|people|pieces|passkeys|people\/[a-z0-9][a-z0-9-]*|memory\/.+|knowledge|knowledge\/.+|new-agent|new-person|new-fact|a\/[a-z][a-z0-9-]{0,39}(|\/mind|\/setup|\/people|\/people\/[a-z0-9][a-z0-9-]*|\/memory\/.+))$/;

/** A page path: `""` (the main page) or lowercase segments, never `..`, never absolute. */
export function validPath(p: string): boolean {
  if (p.length > LIMITS.path || !PATH_CHARS.test(p)) return false;
  if (p === '') return true;
  if (p.startsWith('/') || p.endsWith('/')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function str(v: unknown, what: string): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') throw new Invalid(`${what} must be a string`);
  if (v.length > LIMITS.string) throw new Invalid(`${what} is longer than ${LIMITS.string}`);
  return v;
}

function optStr(v: unknown, what: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, what);
}

/** An agent's id (household.json's names): lowercase, starts with a letter. */
function agentId(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(v)) throw new Invalid(`${what} must be an agent's id`);
  return v;
}

/** A moment, as an ISO 8601 date-time. */
function when(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(v) || Number.isNaN(Date.parse(v))) throw new Invalid(`${what} must be an ISO date-time`);
  return v;
}

function bool(v: unknown): boolean | undefined {
  return v === undefined ? undefined : v === true;
}

function tone(v: unknown): Tone | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !TONES.has(v)) throw new Invalid(`tone must be one of ${[...TONES].join(', ')}`);
  return v as Tone;
}

function arr(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(`${what} must be an array`);
  if (v.length > max) throw new Invalid(`${what} has more than ${max} entries`);
  return v;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Invalid(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function name(v: unknown, what: string): string {
  const s = str(v, what);
  if (!NAME.test(s)) throw new Invalid(`${what} ${JSON.stringify(s)} must be lowercase letters, digits, _ and -`);
  return s;
}

/**
 * A page link: `[loom:]<path>[?<query>]`. Split into the source (loom's own or
 * this piece's), the path and the query, or null when it isn't valid.
 */
export function splitPage(s: string): { core: boolean; path: string; query: Record<string, string> } | null {
  const core = s.startsWith('loom:');
  const rest = core ? s.slice(5) : s;
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  if (!validPath(path)) return null;
  // Into loom, only loom's own pages: not another piece's, and not login,
  // logout, actions or the JSON endpoints.
  if (core && !CORE_PAGES.test(path)) return null;
  const query: Record<string, string> = {};
  if (q !== -1) {
    const params = new URLSearchParams(rest.slice(q + 1));
    let n = 0;
    for (const [k, v] of params) {
      if (!QUERY_KEY.test(k) || v.length > LIMITS.queryValue || ++n > LIMITS.query) return null;
      query[k] = v;
    }
  }
  return { core, path, query };
}

/** A link to a page: this source's path, or `loom:<path>` for one of loom's own, either with an optional query. */
function page(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = str(v, what);
  if (!splitPage(s)) throw new Invalid(`${what} ${JSON.stringify(s)} is not a valid page link`);
  return s;
}

/** Only http(s): no javascript:, data:, or relative tricks. */
function href(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = str(v, what);
  let url: URL;
  try { url = new URL(s); } catch { throw new Invalid(`${what} must be an absolute URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Invalid(`${what} must be http(s)`);
  return url.href;
}

function target(o: Record<string, unknown>, what: string): Target {
  const p = page(o.page, `${what}.page`);
  const h = href(o.href, `${what}.href`);
  if (p !== undefined && h !== undefined) throw new Invalid(`${what} has both page and href`);
  return { ...(p !== undefined ? { page: p } : {}), ...(h !== undefined ? { href: h } : {}) };
}

/** A list item's avatar: one or two letters (a person's initials), drawn in a plain circle. */
function avatarOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !/^\p{L}{1,2}$/u.test(v)) throw new Invalid('list.avatar is one or two letters');
  return v;
}

function strMap(v: unknown, what: string, max: number): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  const o = obj(v, what);
  const keys = Object.keys(o);
  if (keys.length > max) throw new Invalid(`${what} has more than ${max} entries`);
  const out: Record<string, string> = {};
  for (const k of keys) out[name(k, `${what} key`)] = str(o[k], `${what}.${k}`);
  return out;
}

function button(x: unknown): Button {
  const o = obj(x, 'button');
  const t = o.tone;
  if (t !== undefined && t !== 'primary' && t !== 'danger') throw new Invalid('button.tone must be primary or danger');
  return {
    action: name(o.action, 'button.action'),
    label: str(o.label, 'button.label'),
    tone: t as 'primary' | 'danger' | undefined,
    confirm: optStr(o.confirm, 'button.confirm'),
    fields: strMap(o.fields, 'button.fields', LIMITS.hidden),
  };
}

function field(v: unknown): Field {
  const o = obj(v, 'field');
  const kind = o.kind;
  if (kind !== 'text' && kind !== 'textarea' && kind !== 'choice' && kind !== 'secret') {
    throw new Invalid('field.kind must be text, textarea, choice or secret');
  }
  const f: Field = { name: name(o.name, 'field.name'), label: str(o.label, 'field.label'), kind };
  const hint = optStr(o.hint, 'field.hint');
  if (hint !== undefined) f.hint = hint;
  // A secret field never carries a value: the page must not be able to show one.
  if (kind !== 'secret') {
    const value = optStr(o.value, 'field.value');
    if (value !== undefined) f.value = value;
  }
  if (bool(o.required)) f.required = true;
  if (kind === 'choice') {
    f.options = arr(o.options, 'field.options', LIMITS.options).map((x) => {
      const opt = obj(x, 'option');
      const swatch = optStr(opt.swatch, 'option.swatch');
      if (swatch !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(swatch)) throw new Invalid('option.swatch is a color like #B8A6FF');
      return { value: str(opt.value, 'option.value'), label: str(opt.label, 'option.label'), detail: optStr(opt.detail, 'option.detail'), ...(swatch ? { swatch } : {}) };
    });
  }
  return f;
}

function block(v: unknown, depth = 0): Block {
  const b = obj(v, 'block');
  switch (b.type) {
    case 'stats':
      return {
        type: 'stats',
        items: arr(b.items, 'stats.items', LIMITS.items).map((i) => {
          const o = obj(i, 'stat');
          return {
            label: str(o.label, 'stat.label'), value: str(o.value, 'stat.value'),
            detail: optStr(o.detail, 'stat.detail'), tone: tone(o.tone), page: page(o.page, 'stat.page'),
          };
        }),
      };
    case 'list':
      return {
        type: 'list',
        ...(b.numbered === true ? { numbered: true } : {}),
        items: arr(b.items, 'list.items', LIMITS.items).map((i) => {
          const o = obj(i, 'list item');
          return {
            text: str(o.text, 'list.text'), meta: optStr(o.meta, 'list.meta'), badge: optStr(o.badge, 'list.badge'),
            tone: tone(o.tone), agent: agentId(o.agent, 'list.agent'), avatar: avatarOf(o.avatar), ...target(o, 'list item'),
            ...(o.act !== undefined ? { act: button(o.act) } : {}),
          };
        }),
      };
    case 'table': {
      const columns = arr(b.columns, 'table.columns', LIMITS.columns).map((c) => str(c, 'table column'));
      const rows = arr(b.rows, 'table.rows', LIMITS.items).map((r) =>
        arr(r, 'table row', columns.length).map((c): Cell => {
          if (typeof c === 'string' || typeof c === 'number') return str(c, 'table cell');
          const o = obj(c, 'table cell');
          const p = page(o.page, 'table cell.page');
          return p !== undefined ? { text: str(o.text, 'table cell.text'), page: p } : str(o.text, 'table cell.text');
        }));
      return { type: 'table', columns, rows };
    }
    case 'kv':
      return {
        type: 'kv',
        items: arr(b.items, 'kv.items', LIMITS.items).map((i) => {
          const o = obj(i, 'kv item');
          return { label: str(o.label, 'kv.label'), value: str(o.value, 'kv.value'), page: page(o.page, 'kv.page') };
        }),
      };
    case 'text':
      return { type: 'text', text: str(b.text, 'text'), tone: tone(b.tone) };
    case 'prose': {
      if (typeof b.text !== 'string') throw new Invalid('prose.text must be a string');
      if (b.text.length > LIMITS.prose) throw new Invalid(`prose.text is longer than ${LIMITS.prose}`);
      return { type: 'prose', text: b.text };
    }
    case 'callout':
      return { type: 'callout', text: str(b.text, 'callout.text'), title: optStr(b.title, 'callout.title'), tone: tone(b.tone) };
    case 'link': {
      const t = target(b, 'link');
      if (t.page === undefined && t.href === undefined) throw new Invalid('link needs page or href');
      return { type: 'link', text: str(b.text, 'link.text'), ...t };
    }
    case 'filters': {
      const param = str(b.param, 'filters.param');
      if (!QUERY_KEY.test(param)) throw new Invalid('filters.param must be a query key');
      return {
        type: 'filters',
        param,
        options: arr(b.options, 'filters.options', LIMITS.options).map((x) => {
          const o = obj(x, 'filter option');
          const value = str(o.value, 'filter.value');
          if (value.length > LIMITS.queryValue) throw new Invalid('filter.value is too long');
          return { value, label: str(o.label, 'filter.label') };
        }),
        search: optStr(b.search, 'filters.search'),
      };
    }
    case 'details':
      if (depth > 0) throw new Invalid('details can\'t contain details');
      return {
        type: 'details',
        summary: str(b.summary, 'details.summary'),
        meta: optStr(b.meta, 'details.meta'),
        blocks: arr(b.blocks, 'details.blocks', LIMITS.blocks).map((x) => block(x, depth + 1)),
      };
    case 'form':
      return {
        type: 'form',
        action: name(b.action, 'form.action'),
        submit: str(b.submit, 'form.submit'),
        fields: arr(b.fields, 'form.fields', LIMITS.fields).map(field),
        title: optStr(b.title, 'form.title'),
        note: optStr(b.note, 'form.note'),
        hidden: strMap(b.hidden, 'form.hidden', LIMITS.hidden),
      };
    case 'buttons':
      return {
        type: 'buttons',
        items: arr(b.items, 'buttons.items', LIMITS.fields).map(button),
      };
    case 'meter':
      return {
        type: 'meter',
        items: arr(b.items, 'meter.items', LIMITS.items).map((i) => {
          const o = obj(i, 'meter item');
          if (typeof o.value !== 'number' || !Number.isFinite(o.value) || o.value < 0 || o.value > 1) {
            throw new Invalid('meter.value must be a number from 0 to 1');
          }
          return { label: str(o.label, 'meter.label'), value: o.value, detail: optStr(o.detail, 'meter.detail'), tone: tone(o.tone) };
        }),
      };
    case 'code':
      return { type: 'code', text: str(b.text, 'code.text'), label: optStr(b.label, 'code.label') };
    case 'status':
      return {
        type: 'status',
        items: arr(b.items, 'status.items', LIMITS.items).map((i) => {
          const o = obj(i, 'status item');
          return {
            label: str(o.label, 'status.label'), tone: tone(o.tone), text: optStr(o.text, 'status.text'),
            meta: optStr(o.meta, 'status.meta'), page: page(o.page, 'status.page'),
          };
        }),
      };
    default:
      throw new Invalid(`unknown block type ${JSON.stringify(b.type)}`);
  }
}

function section(v: unknown): Section {
  const o = obj(v, 'section');
  const id = str(o.id, 'section.id');
  if (!ID.test(id)) throw new Invalid(`section.id ${JSON.stringify(id)} must be lowercase letters, digits and dashes`);
  return {
    id,
    title: optStr(o.title, 'section.title'),
    side: bool(o.side),
    tone: tone(o.tone),
    blocks: arr(o.blocks, 'section.blocks', LIMITS.blocks).map((x) => block(x)),
  };
}

function sections(v: unknown): Section[] {
  return arr(v, 'sections', LIMITS.sections).map(section);
}

function attempt<T>(f: () => T): T | string {
  try { return f(); } catch (err) {
    if (err instanceof Invalid) return err.message;
    throw err;
  }
}

/** Validate a piece's `ui --json` answer (v2, or a first-version `{sections}`). */
export function parseManifest(value: unknown): Manifest | string {
  return attempt(() => {
    const top = obj(value, 'answer');
    if (top.v === undefined && top.sections !== undefined) {
      return { asks: [], legacy: sections(top.sections) };
    }
    if (top.v !== 2) throw new Invalid('v must be 2');
    const m: Manifest = { asks: [] };
    if (top.scope !== undefined) {
      if (typeof top.scope !== 'boolean') throw new Invalid('scope must be true or false');
      if (top.scope) m.scope = true;
    }
    if (top.tab !== undefined) {
      const t = obj(top.tab, 'tab');
      if (t.kind !== undefined && t.kind !== 'place' && t.kind !== 'setting') throw new Invalid('tab.kind must be place or setting');
      m.tab = { label: str(t.label, 'tab.label'), ...(t.kind ? { kind: t.kind as 'place' | 'setting' } : {}) };
    }
    if (top.tile !== undefined) {
      const t = obj(top.tile, 'tile');
      m.tile = {
        label: str(t.label, 'tile.label'), value: str(t.value, 'tile.value'),
        detail: optStr(t.detail, 'tile.detail'), tone: tone(t.tone), page: page(t.page, 'tile.page'),
      };
    }
    if (top.asks !== undefined) {
      m.asks = arr(top.asks, 'asks', LIMITS.asks).map((x) => {
        const a = obj(x, 'ask');
        return {
          text: str(a.text, 'ask.text'), meta: optStr(a.meta, 'ask.meta'), page: page(a.page, 'ask.page'), label: optStr(a.label, 'ask.label'),
          tone: tone(a.tone), at: when(a.at, 'ask.at'), agent: agentId(a.agent, 'ask.agent'),
          ...(a.actions !== undefined ? { actions: arr(a.actions, 'ask.actions', 2).map(button) } : {}),
        };
      });
    }
    return m;
  });
}

/** Validate a piece's `ui page --json` answer. */
export function parsePage(value: unknown): Page | string {
  return attempt(() => {
    const top = obj(value, 'page');
    const r = top.refresh;
    if (r !== undefined && (typeof r !== 'number' || !Number.isInteger(r) || r < 2 || r > 300)) throw new Invalid('refresh must be whole seconds from 2 to 300');
    const add = top.add === undefined ? undefined : obj(top.add, 'add');
    return { title: str(top.title, 'title'), intro: optStr(top.intro, 'intro'), sections: sections(top.sections), ...(r !== undefined ? { refresh: r } : {}),
      ...(add ? { add: { page: page(add.page, 'add.page') ?? '', label: str(add.label, 'add.label') } } : {}) };
  });
}

/** Validate a piece's `ui act --json` answer. */
export function parseActResult(value: unknown): ActResult | string {
  return attempt(() => {
    const top = obj(value, 'result');
    if (typeof top.ok !== 'boolean') throw new Invalid('ok must be true or false');
    if (top.keep !== undefined && typeof top.keep !== 'boolean') throw new Invalid('keep must be true or false');
    let undo: Undo | undefined;
    if (top.undo !== undefined && top.undo !== null) {
      const u = obj(top.undo, 'undo');
      undo = { action: name(u.action, 'undo.action'), label: optStr(u.label, 'undo.label'), fields: strMap(u.fields, 'undo.fields', LIMITS.hidden) };
    }
    return { ok: top.ok, message: str(top.message, 'message'), page: page(top.page, 'page'), ...(top.keep ? { keep: true } : {}), ...(undo && top.ok ? { undo } : {}) };
  });
}
