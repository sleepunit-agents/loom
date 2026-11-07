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
  kind: 'text' | 'textarea' | 'choice' | 'secret' | 'check' | 'checks' | 'time' | 'toggle' | 'segmented' | 'stepper';
  hint?: string;
  /** `stepper`: the bounds and step of its number, and the unit it's counted in ("days"). */
  min?: number; max?: number; step?: number; unit?: string;
  /** `time`: more than one time, posted joined with commas ("07:17,19:17"). */
  multiple?: boolean;
  value?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string; detail?: string; swatch?: string }>;
}

/** A button: posts its action (with fields) to the piece; danger asks first, with confirm. */
export interface Button { action: string; label: string; tone?: 'primary' | 'danger'; confirm?: string; fields?: Record<string, string> }

/** Every block: `cut` when loom cut one of its texts short to fit LIMITS (parsePage), so the page says so beside it. */
export type Block = BlockShape & { cut?: true };
type BlockShape =
  // A tile may carry a small trend (`spark`, up to 30 numbers, oldest first) or how full something is (`meter`, 0 to 1).
  | { type: 'stats'; items: Array<{ label: string; value: string; detail?: string; tone?: Tone; page?: string; spark?: number[]; meter?: number }> }
  // A status screen's headline: how things are, in plain words, at a glance ("All good", "One bridge is down").
  | { type: 'health'; tone: Tone; text: string; detail?: string }
  // Settings as an app's panel: each row states its current value and holds at most one control (docs/extensions.md, "Panels").
  | { type: 'panel'; title?: string; rows: PanelRow[]; action?: Button }
  // Someone, as a profile (000h's profile card, built from its parts): a cover in their colour (an agent's own, else
  // `tone`), their avatar, name and summary, badges, a few numbers, and links out.
  | { type: 'profile'; name: string; initials?: string; agent?: string; tone?: ProfileTone; summary?: string; badges?: string[];
      stats?: Array<{ label: string; value: string }>; links?: Array<{ text: string } & Target> }
  // A row's lead says who: `agent` (an agent's mark; `loom` is loom's own), `person` (a People slug: their avatar) or
  // `avatar` (initials in a plain circle). A list where some rows say who, or that says `who`, draws the rest as nobody's yet.
  // A row with `more` opens in place to those label and value pairs (a task's goal, why and done-when); its `page` or
  // `href` is then a link inside what opened, named `more.open` ("Open task"), rather than where a tap goes.
  | { type: 'list'; numbered?: boolean; wrap?: boolean; who?: boolean; pages?: Pages; items: Array<{ text: string; meta?: string; badge?: string; tone?: Tone; agent?: string; person?: string; avatar?: string; act?: Button; more?: RowMore } & Target> }
  | { type: 'table'; columns: string[]; rows: Cell[][]; pages?: Pages }
  | { type: 'kv'; items: Array<{ label: string; value: string; page?: string }> }
  | { type: 'text'; text: string; tone?: Tone }
  | { type: 'prose'; text: string }
  // busy: something is under way (a sign-in being checked): drawn with a spinner in place of its tone's icon.
  | { type: 'callout'; text: string; title?: string; tone?: Tone; busy?: boolean }
  | ({ type: 'link'; text: string } & Target)
  /** Where a task or change came from: core draws it per viewer before the page is drawn (comms.md, "From"). */
  | { type: 'from'; conversation: string }
  // `switch`: the options drawn as one segmented switch (2 to 4, a sort) rather than pills. `chips`: rows of chips under
  // it, each its own query key, any number on at once (`?<param>=a,b`; none on means all), each row one line.
  | { type: 'filters'; param: string; options: Array<{ value: string; label: string }>; search?: string; switch?: boolean; chips?: ChipRow[] }
  | { type: 'details'; summary: string; meta?: string; blocks: Block[] }
  | { type: 'form'; action: string; submit: string; fields: Field[]; title?: string; note?: string; hidden?: Record<string, string>;
      /** More ways to send it, beside `submit`: each posts the form's fields with its own (Yes and No over a box of words). */
      submits?: FormSubmit[] }
  | { type: 'buttons'; items: Button[] }
  | { type: 'meter'; items: Array<{ label: string; value: number; detail?: string; tone?: Tone }> }
  | { type: 'code'; text: string; label?: string }
  | { type: 'status'; items: Array<{ label: string; tone?: Tone; text?: string; meta?: string; page?: string }> }
  // 000h's chart: bars (grouped or stacked), an area or a line over labelled points, each series a 000h colour.
  | { type: 'chart'; kind: ChartKind; variant?: ChartVariant; caption?: string; summary?: { label: string; value: string; detail?: string };
      series: Array<{ key: string; label: string; color?: ChartColor }>; data: Array<{ label: string } & Record<string, number | string | null>> };

/**
 * One row of a panel: a label and its current value in words, and at most one way to change it. `toggle` switches at
 * once (posts its action with `on` set to "on" or ""); `choice` is a segmented control that posts at once; `edit` opens a
 * sheet with a few fields; `sheet` opens a sheet of detail (blocks); `page`/`href` goes there; `act` is a button.
 */
export interface PanelRow extends Target {
  label: string; value?: string; detail?: string; tone?: Tone; agent?: string;
  toggle?: { action: string; on: boolean; fields?: Record<string, string> };
  choice?: { action: string; name: string; value: string; options: Array<{ value: string; label: string }>; fields?: Record<string, string> };
  edit?: { action: string; title?: string; submit?: string; note?: string; fields: Field[]; hidden?: Record<string, string> };
  sheet?: { title?: string; blocks: Block[] };
  act?: Button;
}

/** What a list row opens to in place (docs/extensions.md, "Blocks", list): up to LIMITS.more label and value pairs, and
 * what its link is called there. */
export interface RowMore { items: Array<{ label: string; value: string }>; open?: string }
/** One row of a filters block's chips: a query key, a label for a screen reader, its chips. */
export interface ChipRow { param: string; label: string; options: Array<{ value: string; label: string }> }

export type ChartKind = 'bar' | 'area' | 'line';
export type ChartVariant = 'grouped' | 'stacked' | 'smooth' | 'step';
export type ChartColor = 'pink' | 'blue' | 'olive' | 'yellow' | 'ink';
const CHART_KINDS = new Set(['bar', 'area', 'line']);
const CHART_VARIANTS: Record<string, Set<string>> = { bar: new Set(['grouped', 'stacked']), area: new Set(['stacked', 'smooth']), line: new Set(['smooth', 'step']) };
const CHART_COLORS = new Set(['pink', 'blue', 'olive', 'yellow', 'ink']);
const SERIES_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** Where a section stands on its page (docs/extensions.md, "Pages"): the main column, the default, or the side column.
 * On a desktop window 1280 px and wider the side column is the window's right-hand column; narrower, and on a phone,
 * the side sections fold together into one block at the top of the page, closed. */
export type SectionPlace = 'main' | 'side';

export interface Section {
  id: string;
  title?: string;
  /** `side` puts it in the side column; absent is the main one. (A piece may still send the older `"side": true`.) */
  place?: Exclude<SectionPlace, 'main'>;
  tone?: Tone;
  /** Folds under its title: `open` starts open, `closed` folded. The viewer's choice then sticks. */
  fold?: 'open' | 'closed';
  /** 'agent': this section is about one agent (it belongs on that agent's page); the household's by default. */
  level?: Level;
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
/**
 * What an ask is, for the Inbox's folders: something to allow, to choose, or to answer in words; something wrong to look
 * at (an alert: there's no choice in it); or a task waiting on the owner (todo). Jonathan, 2026-10-30: "discord bridge
 * is down ... says it's got a decision, and well, there's no decision there".
 */
export type AskKind = 'permission' | 'decision' | 'reply' | 'alert' | 'todo';
export const ASK_KINDS: ReadonlySet<string> = new Set(['permission', 'decision', 'reply', 'alert', 'todo']);
/**
 * A decision only the owner can make. `tone` tints its card; `at` (ISO time) gives its age; `agent` puts that agent's mark on it.
 * `kind` files it (a decision when it has buttons to choose with, else an alert). `attention: false` files it without counting it as unread (a memory proposal nothing
 * waits on); otherwise it needs the owner: it counts, and may push. `expires` (ISO) is when it stops mattering.
 */
export interface Ask { text: string; meta?: string; page?: string; label?: string; tone?: Tone; at?: string; agent?: string; /** Up to two buttons on its card (Ratify and Reject): posted to the piece, like a buttons block's. */ actions?: Button[];
  kind?: AskKind; attention?: false; expires?: string;
  /** The ask laid out (docs/extensions.md, "asks"): why, one line; what happens if the owner says yes (its first,
   * primary button) and if no (its danger one), drawn beside those buttons; longer details for its sheet; and the fine
   * print, exactly what the yes allows (the machine's kind and target), under the rest. */
  why?: string; if_yes?: string; if_no?: string; details?: string; fine?: string;
  /** The conversation it was asked from (a cv- id: the approvals piece's, docs/specs/comms.md "Asks inline"): a Comms
   * thread shows it, when its agent is the thread's too. */
  conversation?: string }
/** News, never unread: what happened that the owner may want to know (a box joined, a bridge restarted). */
export interface Notice { text: string; meta?: string; page?: string; at: string; agent?: string }
/** One the owner already answered (or that expired): the Inbox's history. */
export interface Answered { text: string; outcome: string; at: string; kind?: AskKind; agent?: string; page?: string }
/** How an agent is, as one piece sees it. Loom combines the pieces' states, worst first: broken, unavailable, working, available. */
export type AgentState = 'working' | 'available' | 'unavailable' | 'broken';
export const AGENT_STATES: ReadonlySet<string> = new Set(['working', 'available', 'unavailable', 'broken']);
/** One short reading on an agent's card on Home (Fuel: 58% of the week). */
export interface Reading { label: string; value: string; detail?: string; tone?: Tone; page?: string }
/**
 * One thing an agent has going right now, for its card on Home (docs/extensions.md, "agents"): a conversation a
 * body is in, a lane or a wake running, a task, a remote session. The card lists them, simply; the details are a
 * tap away (`page`). `since` is when it started (ISO 8601).
 */
export interface Doing { text: string; kind?: DoingKind; where?: string; since?: string; page?: string }
export type DoingKind = 'talk' | 'lane' | 'task' | 'session' | 'other';
export const DOING_KINDS: ReadonlySet<string> = new Set(['talk', 'lane', 'task', 'session', 'other']);
export interface AgentReport { state?: AgentState; reason?: string; readings: Reading[]; doing?: Doing[] }
/** Where a piece's tab (or one section) belongs: the household's (the default), or each agent's own pages. */
export type Level = 'loom' | 'agent';

/** loom's palette, by its tokens' names (--v-pink, …): an app's accent is one of these, so the theme decides the shade
 * (each palette and light or dark has its own) and the ink on it stays readable. */
export const ACCENTS = ['pink', 'blue', 'yellow', 'olive'] as const;
export type Accent = typeof ACCENTS[number];
/** A piece's own fit (docs/specs/desk-tiling.md, "Fit"): a minimum width and height, an ideal width, a maximum width
 * (null: it can use any), and whether it wants the big slot. Every key optional. */
export type TabFit = { min?: [number, number]; ideal?: number; max?: number | null; big?: boolean };
/** The default row a fit's missing keys fall back to (web/src/tiling/fit.ts DEFAULT_FIT), and the least it may ask. */
export const FIT_DEFAULT = { min: [420, 300] as [number, number], ideal: 720, max: null as number | null };
export const FIT_LEAST = { w: 320, h: 240 };
const FIT_MOST = 10000;

export interface Manifest {
  /** The piece narrows its data to the agent in LOOM_SCOPE; without it, loom says it shows the whole household. */
  scope?: boolean;
  /**
   * 2: the piece understands agent owners (docs/specs/owners.md): it reads the caller's
   * `who` and `agents`, scopes what it shows and refuses what isn't theirs. Without it,
   * only household owners see the piece at all.
   */
  owners?: 2;
  /** kind: 'setting' puts it under Setup (rarely visited: boxes, subscriptions); a place by default. level: 'agent' puts it on each agent's pages.
   * icon: a lucide icon's name for its tile and tab (`alarm-clock`); one loom can't draw is a plain one.
   * accent: its colour everywhere it's drawn (tile, dock, its page's header), one of loom's palette (ACCENTS), so it
   * holds in light and dark and under every palette; without one, loom's own for a catalog piece, else one from its name.
   * fit: the room its pages can use on a tiled desktop (docs/specs/desk-tiling.md, "Fit"); a key left out is the default
   * row's (min [420, 300], ideal 720, no max, not big). */
  tab?: { label: string; kind?: 'place' | 'setting'; level?: Level; icon?: string; accent?: Accent; fit?: TabFit };
  /**
   * A tab on each agent's own pages as well (or instead, with tab.level 'agent'): served at
   * /a/<agent>/p/<piece>/, the piece called with LOOM_SCOPE=<agent>. For a piece whose things are
   * mostly each agent's (a clock's schedules) with a little of the household's (its own lanes).
   */
  agentTab?: { label: string };
  tile?: Tile;
  asks: Ask[];
  notices?: Notice[];
  answered?: Answered[];
  /** Per agent id: its state as this piece sees it, and up to four readings for its card. */
  agents?: Record<string, AgentReport>;
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
  // An ask's own buttons: a yes, a no, and one more (a request's Allow, Always allow, Deny).
  askActions: 3,
  notices: 20,
  answered: 20,
  agents: 16,
  readings: 4,
  chartSeries: 5,
  chartPoints: 60,
  spark: 30,
  /** A segmented control's choices: more than this is a choice field's job. */
  segments: 5,
  doing: 8,
  fields: 30,
  hidden: 20,
  // A form's extra submits: a Yes, a No, and one more.
  formSubmits: 3,
  options: 50,
  /** A list row's `more`: a few facts, not a page. */
  more: 6,
  /** A filters block's chip rows, and the chips in one. */
  chipRows: 3,
  chips: 12,
  /** A chip's value: a row of LIMITS.chips of them, joined with commas, stays inside queryValue. */
  chipValue: 15,
  query: 10,
  queryValue: 200,
  path: 200,
  /** A prose block's markdown: a page's whole body. */
  prose: 20000,
} as const;

const TONES: ReadonlySet<string> = new Set(['ok', 'warn', 'bad', 'muted']);
const FIELD_KINDS: ReadonlySet<string> = new Set(['text', 'textarea', 'choice', 'secret', 'check', 'checks', 'time', 'toggle', 'segmented', 'stepper']);
export type ProfileTone = 'pink' | 'yellow' | 'olive' | 'blue';
const PROFILE_TONES: ReadonlySet<string> = new Set(['pink', 'yellow', 'olive', 'blue']);
export const ID = /^[a-z][a-z0-9-]{0,39}$/;
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
export const QUERY_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const PATH_CHARS = /^[a-z0-9._~/-]*$/;

class Invalid extends Error {}

/** loom's own pages a link may name with `loom:`. */
const CORE_PAGES = /^(|inbox|activity|mind|people|projects|projects\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?|pieces|passkeys|p\/[a-z][a-z0-9-]{0,39}(?:\/.*)?|people\/[a-z0-9][a-z0-9-]*|memory\/.+|knowledge|knowledge\/.+|new-agent|new-person|new-fact|conversation\/cv-[0-9a-f]{12}|comms\/(?:th:)?[a-z2-7]{10}|a\/[a-z][a-z0-9-]{0,39}(|\/mind|\/setup|\/people|\/people\/[a-z0-9][a-z0-9-]*|\/memory\/.+|\/conversation\/cv-[0-9a-f]{12}))$/;

const COMMS_THREAD_PAGE = /^comms\/th:[a-z2-7]{10}$/;

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

/** An ask's laid-out words (Ask.why, if_yes, if_no, details, fine), each a string within its cap. */
function plainOf(a: Record<string, unknown>): Pick<Ask, 'why' | 'if_yes' | 'if_no' | 'details' | 'fine'> {
  const out: Pick<Ask, 'why' | 'if_yes' | 'if_no' | 'details' | 'fine'> = {};
  for (const [k, cap] of [['why', 300], ['if_yes', 300], ['if_no', 300], ['details', 2000], ['fine', 400]] as const) {
    const v = a[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > cap) throw new Invalid(`ask.${k} is text, at most ${cap} characters`);
    if (v.trim()) out[k] = v;
  }
  return out;
}

/**
 * A block's own words (a code block's text, a list row's, a cell): over `max` they're cut short, not refused, ending
 * in "…", and the block says so (`cut`, block()). One long record shouldn't blank a whole page (t-1861: Approvals went
 * blank when its record passed 2000 characters). Names, labels, actions and paths stay strict (str).
 */
function long(v: unknown, what: string, max: number = LIMITS.string): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') throw new Invalid(`${what} must be a string`);
  if (v.length <= max) return v;
  cuts.all.push(`${what} (${v.length} characters, at most ${max})`);
  cuts.open++;
  let kept = v.slice(0, max - 1);
  // Not half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}…`;
}
function optLong(v: unknown, what: string): string | undefined {
  return v === undefined || v === null ? undefined : long(v, what);
}
/** What this parse cut short (`all`, for the caller to log), and how many cuts no block has claimed yet (`open`). */
let cuts: { all: string[]; open: number } = { all: [], open: 0 };

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

function fail(message: string): never { throw new Invalid(message); }

function askKind(v: unknown, what: string): AskKind {
  if (typeof v !== 'string' || !ASK_KINDS.has(v)) throw new Invalid(`${what} must be one of ${[...ASK_KINDS].join(', ')}`);
  return v as AskKind;
}

/** Only `false` says anything: an ask needs the owner unless it says it doesn't. */
function attention(v: unknown): { attention?: false } {
  if (typeof v !== 'boolean') throw new Invalid('ask.attention must be true or false');
  return v ? {} : { attention: false };
}

function level(v: unknown, what: string): Level | undefined {
  if (v === undefined) return undefined;
  if (v !== 'loom' && v !== 'agent') throw new Invalid(`${what} must be loom or agent`);
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

/** A list row's `more`: its label and value pairs, and what its link is called there. */
function rowMore(v: unknown): RowMore {
  const o = obj(v, 'list.more');
  const items = arr(o.items, 'list.more.items', LIMITS.more).map((x) => {
    const i = obj(x, 'list.more item');
    return { label: str(i.label, 'list.more.label'), value: str(i.value, 'list.more.value') };
  });
  if (!items.length) throw new Invalid('list.more needs an item');
  return { items, ...(o.open !== undefined ? { open: str(o.open, 'list.more.open') } : {}) };
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
export function splitPage(s: string): { core: boolean; path: string; query: Record<string, string>; agent?: string; household?: true } | null {
  const core = s.startsWith('loom:');
  // This piece's own pages elsewhere: `agent:<id>[/path]` on that agent's tab, `household:<path>` on the household's.
  // Never another piece's: the piece is always the one whose page the link is on.
  const ag = /^agent:([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/.exec(s);
  if (ag) {
    const inner = splitPage(ag[2] ?? '');
    return inner && !inner.core ? { ...inner, agent: ag[1] } : null;
  }
  if (s.startsWith('household:')) {
    const inner = splitPage(s.slice('household:'.length));
    return inner && !inner.core ? { ...inner, household: true } : null;
  }
  const rest = core ? s.slice(5) : s;
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  // A Comms thread's page (comms.md, "From"): loom's own, and its id carries a colon no other path may.
  if (!(core && COMMS_THREAD_PAGE.test(path)) && !validPath(path)) return null;
  // Into loom, only pages: loom's own and, as loom:p/<piece>/<path>, another piece's (a conversation's page
  // naming the task it closed, 2026-10-29: a page is only a look, and that piece still says who may see it);
  // never login, logout, actions or the JSON endpoints.
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

/** One more way to send a form: its label, its own fields (answer: yes), and a tone. */
export interface FormSubmit { label: string; fields?: Record<string, string>; tone?: 'primary' | 'danger' }
function formSubmit(x: unknown): FormSubmit {
  const o = obj(x, 'form.submits item');
  const t = o.tone;
  if (t !== undefined && t !== 'primary' && t !== 'danger') throw new Invalid('form.submits tone must be primary or danger');
  const fields = strMap(o.fields, 'form.submits fields', LIMITS.hidden);
  return { label: str(o.label, 'form.submits label'), ...(fields ? { fields } : {}), ...(t ? { tone: t as 'primary' | 'danger' } : {}) };
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
  if (typeof kind !== 'string' || !FIELD_KINDS.has(kind)) throw new Invalid(`field.kind must be one of ${[...FIELD_KINDS].join(', ')}`);
  const f: Field = { name: name(o.name, 'field.name'), label: str(o.label, 'field.label'), kind: kind as Field['kind'] };
  const hint = optStr(o.hint, 'field.hint');
  if (hint !== undefined) f.hint = hint;
  // A secret field never carries a value: the page must not be able to show one.
  if (kind !== 'secret') {
    const value = optStr(o.value, 'field.value');
    if (value !== undefined) f.value = value;
  }
  if (bool(o.required)) f.required = true;
  // `time`: a time of day, "HH:MM" (24-hour on the wire; the page shows it as people read it, and picks it with the
  // device's own picker); `multiple`, several, joined with commas.
  if (kind === 'time') {
    if (bool(o.multiple)) f.multiple = true;
    const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (f.value && !f.value.split(',').every((t) => TIME.test(t.trim()))) throw new Invalid('a time field\'s value is HH:MM, or several joined with commas');
    if (!f.multiple && f.value?.includes(',')) throw new Invalid('one time field holds one time; set multiple for several');
  }
  // `check`: one box, posted as "on" or "". `checks`: any of its options, posted as their values joined with commas.
  if (kind === 'check' && f.value !== undefined && f.value !== 'on' && f.value !== '') throw new Invalid('a check field\'s value is "on" or ""');
  // `toggle`: a switch, posted as "on" or "" like a check. `stepper`: a whole number within min and max, with − and +.
  if (kind === 'toggle' && f.value !== undefined && f.value !== 'on' && f.value !== '') throw new Invalid('a toggle field\'s value is "on" or ""');
  if (kind === 'stepper') {
    const num = (x: unknown, what: string) => {
      if (x === undefined) return undefined;
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new Invalid(`${what} must be a number`);
      return x;
    };
    const min = num(o.min, 'field.min'), max = num(o.max, 'field.max'), step = num(o.step, 'field.step');
    if (min !== undefined && max !== undefined && min > max) throw new Invalid('a stepper\'s min is above its max');
    if (step !== undefined && step <= 0) throw new Invalid('a stepper\'s step is above 0');
    if (f.value !== undefined && f.value !== '' && !Number.isFinite(Number(f.value))) throw new Invalid('a stepper\'s value is a number');
    Object.assign(f, min !== undefined ? { min } : {}, max !== undefined ? { max } : {}, step !== undefined ? { step } : {});
    const unit = optStr(o.unit, 'field.unit');
    if (unit !== undefined) f.unit = unit;
  }
  if (kind === 'segmented') {
    f.options = arr(o.options, 'field.options', LIMITS.segments).map((x) => {
      const opt = obj(x, 'option');
      return { value: str(opt.value, 'option.value'), label: str(opt.label, 'option.label') };
    });
    if (!f.options.length) throw new Invalid('a segmented field needs its options');
  }
  if (kind === 'choice' || kind === 'checks') {
    f.options = arr(o.options, 'field.options', LIMITS.options).map((x) => {
      const opt = obj(x, 'option');
      const swatch = optStr(opt.swatch, 'option.swatch');
      if (swatch !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(swatch)) throw new Invalid('option.swatch is a color like #B8A6FF');
      return { value: str(opt.value, 'option.value'), label: str(opt.label, 'option.label'), detail: optStr(opt.detail, 'option.detail'), ...(swatch ? { swatch } : {}) };
    });
    if (kind === 'checks' && f.options!.some((x) => x.value.includes(','))) throw new Invalid('a checks option\'s value can\'t hold a comma');
  }
  return f;
}

/**
 * A list or table longer than a page sends one page and says where it is (docs/extensions.md, "Pages"): the
 * query key the piece reads, this page (from 1) and how many there are. loom asks for `?<param>=<n>`, keeping
 * the page's other query keys.
 */
export interface Pages { param: string; at: number; count: number; total?: number }
function pages(v: unknown): Pages {
  const o = obj(v, 'pages');
  const param = str(o.param, 'pages.param');
  if (!QUERY_KEY.test(param)) throw new Invalid('pages.param must be a query key');
  const whole = (x: unknown, what: string, max: number) => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > max) throw new Invalid(`${what} is a whole number from 1 to ${max}`);
    return x;
  };
  const count = whole(o.count, 'pages.count', 100_000);
  const at = whole(o.at, 'pages.at', count);
  const total = o.total === undefined ? undefined : whole(o.total, 'pages.total', 100_000_000);
  return { param, at, count, ...(total !== undefined ? { total } : {}) };
}

/** A block, marked `cut` when one of its own texts was cut short (a block inside it marks itself, not this one). */
function block(v: unknown, depth = 0): Block {
  const before = cuts.open;
  const out = blockShape(v, depth);
  if (cuts.open === before) return out;
  cuts.open = before;
  return { ...out, cut: true };
}

function blockShape(v: unknown, depth: number): BlockShape {
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
            ...(o.spark !== undefined ? { spark: arr(o.spark, 'stat.spark', LIMITS.spark).map((n) => {
              if (typeof n !== 'number' || !Number.isFinite(n)) throw new Invalid('stat.spark holds numbers');
              return n;
            }) } : {}),
            ...(o.meter !== undefined ? { meter: fraction(o.meter, 'stat.meter') } : {}),
          };
        }),
      };
    case 'profile': {
      const badges = b.badges === undefined ? undefined : arr(b.badges, 'profile.badges', 6).map((x) => str(x, 'profile badge'));
      const stats = b.stats === undefined ? undefined : arr(b.stats, 'profile.stats', 4).map((x) => {
        const o = obj(x, 'profile stat');
        return { label: str(o.label, 'profile stat.label'), value: str(o.value, 'profile stat.value') };
      });
      const links = b.links === undefined ? undefined : arr(b.links, 'profile.links', 4).map((x) => {
        const o = obj(x, 'profile link');
        const t = target(o, 'profile link');
        if (t.page === undefined && t.href === undefined) throw new Invalid('profile link needs page or href');
        return { text: str(o.text, 'profile link.text'), ...t };
      });
      if (b.tone !== undefined && (typeof b.tone !== 'string' || !PROFILE_TONES.has(b.tone))) throw new Invalid('profile.tone is pink, yellow, olive or blue');
      return {
        type: 'profile', name: str(b.name, 'profile.name'),
        ...(b.initials !== undefined ? { initials: avatarOf(b.initials) } : {}),
        ...(b.agent !== undefined ? { agent: agentId(b.agent, 'profile.agent') } : {}),
        ...(b.tone !== undefined ? { tone: b.tone as ProfileTone } : {}),
        ...(b.summary !== undefined ? { summary: str(b.summary, 'profile.summary') } : {}),
        ...(badges ? { badges } : {}), ...(stats ? { stats } : {}), ...(links ? { links } : {}),
      };
    }
    case 'list':
      return {
        type: 'list',
        ...(b.numbered === true ? { numbered: true } : {}),
        ...(b.wrap === true ? { wrap: true } : {}),
        ...(b.who === true ? { who: true } : {}),
        ...(b.pages !== undefined ? { pages: pages(b.pages) } : {}),
        items: arr(b.items, 'list.items', LIMITS.items).map((i) => {
          const o = obj(i, 'list item');
          return {
            text: long(o.text, 'list.text'), meta: optLong(o.meta, 'list.meta'), badge: optStr(o.badge, 'list.badge'),
            tone: tone(o.tone), agent: agentId(o.agent, 'list.agent'), ...(o.person !== undefined ? { person: personSlug(o.person, 'list.person') } : {}),
            avatar: avatarOf(o.avatar), ...target(o, 'list item'),
            ...(o.act !== undefined ? { act: button(o.act) } : {}),
            ...(o.more !== undefined ? { more: rowMore(o.more) } : {}),
          };
        }),
      };
    case 'table': {
      const columns = arr(b.columns, 'table.columns', LIMITS.columns).map((c) => str(c, 'table column'));
      const rows = arr(b.rows, 'table.rows', LIMITS.items).map((r) =>
        arr(r, 'table row', columns.length).map((c): Cell => {
          if (typeof c === 'string' || typeof c === 'number') return long(c, 'table cell');
          const o = obj(c, 'table cell');
          const p = page(o.page, 'table cell.page');
          return p !== undefined ? { text: long(o.text, 'table cell.text'), page: p } : long(o.text, 'table cell.text');
        }));
      return { type: 'table', columns, rows, ...(b.pages !== undefined ? { pages: pages(b.pages) } : {}) };
    }
    case 'kv':
      return {
        type: 'kv',
        items: arr(b.items, 'kv.items', LIMITS.items).map((i) => {
          const o = obj(i, 'kv item');
          return { label: str(o.label, 'kv.label'), value: long(o.value, 'kv.value'), page: page(o.page, 'kv.page') };
        }),
      };
    case 'text':
      return { type: 'text', text: long(b.text, 'text'), tone: tone(b.tone) };
    case 'prose': {
      if (typeof b.text !== 'string') throw new Invalid('prose.text must be a string');
      return { type: 'prose', text: long(b.text, 'prose.text', LIMITS.prose) };
    }
    case 'callout':
      if (b.busy !== undefined && typeof b.busy !== 'boolean') throw new Invalid('callout.busy must be true or false');
      return { type: 'callout', text: long(b.text, 'callout.text'), title: optStr(b.title, 'callout.title'), tone: tone(b.tone), ...(b.busy ? { busy: true } : {}) };
    case 'from': {
      if (typeof b.conversation !== 'string' || !/^cv-[0-9a-f]{12}$/.test(b.conversation)) throw new Invalid('from.conversation is a conversation id (cv- and 12 hex digits)');
      return { type: 'from', conversation: b.conversation };
    }
    case 'link': {
      const t = target(b, 'link');
      if (t.page === undefined && t.href === undefined) throw new Invalid('link needs page or href');
      return { type: 'link', text: str(b.text, 'link.text'), ...t };
    }
    case 'filters': {
      const param = str(b.param, 'filters.param');
      if (!QUERY_KEY.test(param)) throw new Invalid('filters.param must be a query key');
      const options = arr(b.options, 'filters.options', LIMITS.options).map((x) => {
        const o = obj(x, 'filter option');
        const value = str(o.value, 'filter.value');
        if (value.length > LIMITS.queryValue) throw new Invalid('filter.value is too long');
        return { value, label: str(o.label, 'filter.label') };
      });
      if (b.switch !== undefined && typeof b.switch !== 'boolean') throw new Invalid('filters.switch must be true or false');
      if (b.switch === true && (options.length < 2 || options.length > 4)) throw new Invalid('filters.switch needs 2 to 4 options');
      const keys = new Set([param, 'q']);
      const chips = b.chips === undefined ? undefined : arr(b.chips, 'filters.chips', LIMITS.chipRows).map((x) => {
        const r = obj(x, 'chip row');
        const key = str(r.param, 'chips.param');
        if (!QUERY_KEY.test(key) || keys.has(key)) throw new Invalid('chips.param must be a query key of its own (not q, nor another row\'s)');
        keys.add(key);
        const ops = arr(r.options, 'chips.options', LIMITS.chips).map((y) => {
          const o = obj(y, 'chip');
          const value = str(o.value, 'chip.value');
          if (value === '' || value.includes(',') || value.length > LIMITS.chipValue) throw new Invalid(`chip.value is 1 to ${LIMITS.chipValue} characters, no comma`);
          return { value, label: str(o.label, 'chip.label') };
        });
        if (!ops.length) throw new Invalid('a chip row needs a chip');
        if (new Set(ops.map((o) => o.value)).size !== ops.length) throw new Invalid('a chip row\'s values are distinct');
        return { param: key, label: str(r.label, 'chips.label'), options: ops };
      });
      return {
        type: 'filters', param, options,
        search: optStr(b.search, 'filters.search'),
        ...(b.switch === true ? { switch: true } : {}),
        ...(chips?.length ? { chips } : {}),
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
        ...(b.submits === undefined ? {} : { submits: arr(b.submits, 'form.submits', LIMITS.formSubmits).map(formSubmit) }),
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
      return { type: 'code', text: long(b.text, 'code.text'), label: optStr(b.label, 'code.label') };
    case 'status':
      return {
        type: 'status',
        items: arr(b.items, 'status.items', LIMITS.items).map((i) => {
          const o = obj(i, 'status item');
          return {
            label: str(o.label, 'status.label'), tone: tone(o.tone), text: optLong(o.text, 'status.text'),
            meta: optStr(o.meta, 'status.meta'), page: page(o.page, 'status.page'),
          };
        }),
      };
    case 'chart':
      return chart(b);
    case 'health': {
      const t = tone(b.tone);
      if (!t) throw new Invalid('health.tone is ok, warn, bad or muted');
      return { type: 'health', tone: t, text: str(b.text, 'health.text'), ...(b.detail !== undefined ? { detail: long(b.detail, 'health.detail') } : {}) };
    }
    case 'panel':
      return {
        type: 'panel',
        ...(b.title !== undefined ? { title: str(b.title, 'panel.title') } : {}),
        rows: arr(b.rows, 'panel.rows', LIMITS.items).map((x) => panelRow(x, depth)),
        ...(b.action !== undefined ? { action: button(b.action) } : {}),
      };
    default:
      throw new Invalid(`unknown block type ${JSON.stringify(b.type)}`);
  }
}

function fraction(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Invalid(`${what} must be a number from 0 to 1`);
  return v;
}

function panelRow(x: unknown, depth: number): PanelRow {
  const o = obj(x, 'panel row');
  const row: PanelRow = { label: str(o.label, 'panel.label'), ...target(o, 'panel row') };
  const value = optStr(o.value, 'panel.value'); if (value !== undefined) row.value = value;
  const detail = optStr(o.detail, 'panel.detail'); if (detail !== undefined) row.detail = detail;
  const t = tone(o.tone); if (t) row.tone = t;
  const ag = agentId(o.agent, 'panel.agent'); if (ag) row.agent = ag;
  const controls = ['toggle', 'choice', 'edit', 'sheet', 'act'].filter((k) => o[k] !== undefined);
  if (controls.length + (row.page !== undefined || row.href !== undefined ? 1 : 0) > 1) throw new Invalid(`a panel row holds one control or link, not ${controls.join(' and ')}`);
  if (o.toggle !== undefined) {
    const g = obj(o.toggle, 'panel.toggle');
    if (typeof g.on !== 'boolean') throw new Invalid('panel.toggle.on must be true or false');
    row.toggle = { action: name(g.action, 'panel.toggle.action'), on: g.on, ...(g.fields !== undefined ? { fields: strMap(g.fields, 'panel.toggle.fields', LIMITS.hidden) } : {}) };
  }
  if (o.choice !== undefined) {
    const c = obj(o.choice, 'panel.choice');
    const options = arr(c.options, 'panel.choice.options', LIMITS.segments).map((y) => {
      const op = obj(y, 'panel.choice option');
      return { value: str(op.value, 'option.value'), label: str(op.label, 'option.label') };
    });
    if (options.length < 2) throw new Invalid('panel.choice needs two options or more');
    row.choice = { action: name(c.action, 'panel.choice.action'), name: name(c.name, 'panel.choice.name'), value: str(c.value, 'panel.choice.value'), options,
      ...(c.fields !== undefined ? { fields: strMap(c.fields, 'panel.choice.fields', LIMITS.hidden) } : {}) };
  }
  if (o.edit !== undefined) {
    const e = obj(o.edit, 'panel.edit');
    row.edit = {
      action: name(e.action, 'panel.edit.action'), fields: arr(e.fields, 'panel.edit.fields', LIMITS.fields).map(field),
      ...(e.title !== undefined ? { title: str(e.title, 'panel.edit.title') } : {}), ...(e.submit !== undefined ? { submit: str(e.submit, 'panel.edit.submit') } : {}),
      ...(e.note !== undefined ? { note: str(e.note, 'panel.edit.note') } : {}), ...(e.hidden !== undefined ? { hidden: strMap(e.hidden, 'panel.edit.hidden', LIMITS.hidden) } : {}),
    };
    if (!row.edit.fields.length) throw new Invalid('panel.edit needs a field');
  }
  if (o.sheet !== undefined) {
    if (depth > 0) throw new Invalid('a sheet can\'t hold another sheet');
    const sh = obj(o.sheet, 'panel.sheet');
    row.sheet = { ...(sh.title !== undefined ? { title: str(sh.title, 'panel.sheet.title') } : {}), blocks: arr(sh.blocks, 'panel.sheet.blocks', LIMITS.blocks).map((y) => block(y, depth + 1)) };
  }
  if (o.act !== undefined) row.act = button(o.act);
  return row;
}

function chart(b: Record<string, unknown>): Block {
  if (typeof b.kind !== 'string' || !CHART_KINDS.has(b.kind)) throw new Invalid('chart.kind must be bar, area or line');
  const kind = b.kind as ChartKind;
  if (b.variant !== undefined && (typeof b.variant !== 'string' || !CHART_VARIANTS[kind].has(b.variant))) {
    throw new Invalid(`chart.variant for ${kind} must be one of ${[...CHART_VARIANTS[kind]].join(', ')}`);
  }
  const series = arr(b.series, 'chart.series', LIMITS.chartSeries).map((x) => {
    const o = obj(x, 'chart series');
    const key = str(o.key, 'chart.series.key');
    if (!SERIES_KEY.test(key) || key === 'label') throw new Invalid('chart.series.key must be lowercase letters, digits and _, not "label"');
    if (o.color !== undefined && (typeof o.color !== 'string' || !CHART_COLORS.has(o.color))) throw new Invalid('chart.series.color is pink, blue, olive, yellow or ink');
    return { key, label: str(o.label, 'chart.series.label'), ...(o.color !== undefined ? { color: o.color as ChartColor } : {}) };
  });
  if (!series.length) throw new Invalid('chart.series needs at least one');
  if (new Set(series.map((x) => x.key)).size !== series.length) throw new Invalid('chart.series keys must differ');
  const data = arr(b.data, 'chart.data', LIMITS.chartPoints).map((x) => {
    const o = obj(x, 'chart point');
    const point: { label: string } & Record<string, number | string | null> = { label: str(o.label, 'chart.data.label') };
    for (const { key } of series) {
      const v = o[key];
      if (v === undefined || v === null) { point[key] = null; continue; }
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Invalid(`chart.data.${key} must be a number`);
      point[key] = v;
    }
    return point;
  });
  let summary: { label: string; value: string; detail?: string } | undefined;
  if (b.summary !== undefined) {
    const o = obj(b.summary, 'chart.summary');
    summary = { label: str(o.label, 'chart.summary.label'), value: str(o.value, 'chart.summary.value'), detail: optStr(o.detail, 'chart.summary.detail') };
  }
  return {
    type: 'chart', kind, ...(b.variant !== undefined ? { variant: b.variant as ChartVariant } : {}),
    caption: optStr(b.caption, 'chart.caption'), ...(summary ? { summary } : {}), series, data,
  };
}

/** A People slug: lowercase words joined by dashes. */
function personSlug(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length > 80 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) throw new Invalid(`${what} must be a People slug`);
  return v;
}

function section(v: unknown): Section {
  const o = obj(v, 'section');
  const id = str(o.id, 'section.id');
  if (!ID.test(id)) throw new Invalid(`section.id ${JSON.stringify(id)} must be lowercase letters, digits and dashes`);
  return {
    id,
    title: optStr(o.title, 'section.title'),
    ...(placeOf(o) === 'side' ? { place: 'side' as const } : {}),
    tone: tone(o.tone),
    ...(o.fold !== undefined ? { fold: fold(o.fold, o.title) } : {}),
    ...(o.level !== undefined ? { level: level(o.level, 'section.level') } : {}),
    blocks: arr(o.blocks, 'section.blocks', LIMITS.blocks).map((x) => block(x)),
  };
}

/** A section's place: `place` ("main" or "side"), or the older `side` (true or false). Both, saying different things, is
 * a mistake in the page, not a guess. */
function placeOf(o: Record<string, unknown>): SectionPlace {
  if (o.place !== undefined && o.place !== 'main' && o.place !== 'side') throw new Invalid('section.place must be main or side');
  const old = bool(o.side) ? 'side' : 'main';
  if (o.place !== undefined && o.side !== undefined && o.place !== old) throw new Invalid('section.place and section.side disagree: send place alone');
  return (o.place as SectionPlace | undefined) ?? old;
}

function fold(v: unknown, title: unknown): 'open' | 'closed' {
  if (v !== 'open' && v !== 'closed') throw new Invalid('section.fold must be open or closed');
  if (typeof title !== 'string' || !title) throw new Invalid('a section that folds needs a title');
  return v;
}

function sections(v: unknown): Section[] {
  return arr(v, 'sections', LIMITS.sections).map(section);
}

function attempt<T>(f: () => T): T | string {
  // Each parse counts its own cuts (long()).
  cuts = { all: [], open: 0 };
  try { return f(); } catch (err) {
    if (err instanceof Invalid) return err.message;
    throw err;
  }
}

/** A tab's fit: each key optional (the default row's otherwise; an ideal left out is the default's or the min's width,
 * whichever is wider); a min under 320×240, an ideal it gives under the min's width, or a max under the ideal is refused,
 * naming the field. Keys it doesn't know are left alone, as `tab`'s are. Empty, it's no fit at all (loom's row stands). */
function tabFit(v: unknown): TabFit | undefined {
  const f = obj(v, 'tab.fit');
  const px = (x: unknown, what: string) => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x <= 0 || x > FIT_MOST) throw new Invalid(`${what} must be a whole number of pixels, at most ${FIT_MOST}`);
    return x;
  };
  const out: TabFit = {};
  if (f.min !== undefined) {
    if (!Array.isArray(f.min) || f.min.length !== 2) throw new Invalid('tab.fit.min must be [width, height]');
    out.min = [px(f.min[0], 'tab.fit.min width'), px(f.min[1], 'tab.fit.min height')];
    if (out.min[0] < FIT_LEAST.w || out.min[1] < FIT_LEAST.h) throw new Invalid(`tab.fit.min must be at least [${FIT_LEAST.w}, ${FIT_LEAST.h}]: a tile narrower or shorter can't be used beside others`);
  }
  if (f.ideal !== undefined) out.ideal = px(f.ideal, 'tab.fit.ideal');
  if (f.max !== undefined) out.max = f.max === null ? null : px(f.max, 'tab.fit.max');
  if (f.big !== undefined) { if (typeof f.big !== 'boolean') throw new Invalid('tab.fit.big must be true or false'); out.big = f.big; }
  const min = out.min ?? FIT_DEFAULT.min, ideal = out.ideal ?? Math.max(FIT_DEFAULT.ideal, min[0]);
  if (out.ideal !== undefined && ideal < min[0]) throw new Invalid(`tab.fit.ideal (${ideal}) must be at least its min's width (${min[0]})`);
  if (out.max != null && out.max < ideal) throw new Invalid(`tab.fit.max (${out.max}) must be at least its ideal (${ideal})`);
  return Object.keys(out).length ? out : undefined;
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
    if (top.owners !== undefined) {
      if (top.owners !== 2) throw new Invalid('owners must be 2');
      m.owners = 2;
    }
    if (top.tab !== undefined) {
      const t = obj(top.tab, 'tab');
      if (t.kind !== undefined && t.kind !== 'place' && t.kind !== 'setting') throw new Invalid('tab.kind must be place or setting');
      const lv = level(t.level, 'tab.level');
      const icon = optStr(t.icon, 'tab.icon');
      if (icon !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(icon)) throw new Invalid('tab.icon must be a lucide icon name (alarm-clock)');
      const accent = optStr(t.accent, 'tab.accent');
      if (accent !== undefined && !(ACCENTS as readonly string[]).includes(accent)) throw new Invalid(`tab.accent must be one of loom's palette: ${ACCENTS.join(', ')}`);
      const fit = t.fit === undefined ? undefined : tabFit(t.fit);
      m.tab = { label: str(t.label, 'tab.label'), ...(t.kind ? { kind: t.kind as 'place' | 'setting' } : {}), ...(lv ? { level: lv } : {}), ...(icon ? { icon } : {}),
        ...(accent ? { accent: accent as Accent } : {}), ...(fit ? { fit } : {}) };
    }
    if (top.agentTab !== undefined) {
      const t = obj(top.agentTab, 'agentTab');
      m.agentTab = { label: str(t.label, 'agentTab.label') };
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
          ...(a.actions !== undefined ? { actions: arr(a.actions, 'ask.actions', LIMITS.askActions).map(button) } : {}),
          ...(a.kind !== undefined ? { kind: askKind(a.kind, 'ask.kind') } : {}),
          ...(a.attention !== undefined ? attention(a.attention) : {}),
          ...(a.expires !== undefined ? { expires: when(a.expires, 'ask.expires') } : {}),
          ...(typeof a.conversation === 'string' && /^cv-[0-9a-f]{12}$/.test(a.conversation) ? { conversation: a.conversation } : {}),
          ...plainOf(a),
        };
      });
    }
    if (top.notices !== undefined) {
      m.notices = arr(top.notices, 'notices', LIMITS.notices).map((x) => {
        const n = obj(x, 'notice');
        return { text: str(n.text, 'notice.text'), meta: optStr(n.meta, 'notice.meta'), page: page(n.page, 'notice.page'),
          at: when(n.at, 'notice.at') ?? fail('notice.at is required'), agent: agentId(n.agent, 'notice.agent') };
      });
    }
    if (top.answered !== undefined) {
      m.answered = arr(top.answered, 'answered', LIMITS.answered).map((x) => {
        const a = obj(x, 'answered');
        return { text: str(a.text, 'answered.text'), outcome: str(a.outcome, 'answered.outcome'), at: when(a.at, 'answered.at') ?? fail('answered.at is required'),
          ...(a.kind !== undefined ? { kind: askKind(a.kind, 'answered.kind') } : {}), agent: agentId(a.agent, 'answered.agent'), page: page(a.page, 'answered.page') };
      });
    }
    if (top.agents !== undefined) {
      const ag = obj(top.agents, 'agents');
      const ids = Object.keys(ag);
      if (ids.length > LIMITS.agents) throw new Invalid(`agents holds at most ${LIMITS.agents}`);
      m.agents = {};
      for (const id of ids) {
        agentId(id, 'an agents key');
        const r = obj(ag[id], `agents.${id}`);
        if (r.state !== undefined && (typeof r.state !== 'string' || !AGENT_STATES.has(r.state))) throw new Invalid(`agents.${id}.state must be one of ${[...AGENT_STATES].join(', ')}`);
        m.agents[id] = {
          ...(r.state !== undefined ? { state: r.state as AgentState } : {}),
          ...(r.reason !== undefined ? { reason: str(r.reason, `agents.${id}.reason`) } : {}),
          readings: (r.readings === undefined ? [] : arr(r.readings, `agents.${id}.readings`, LIMITS.readings)).map((x) => {
            const d = obj(x, 'reading');
            return { label: str(d.label, 'reading.label'), value: str(d.value, 'reading.value'), detail: optStr(d.detail, 'reading.detail'), tone: tone(d.tone), page: page(d.page, 'reading.page') };
          }),
          ...(r.doing !== undefined ? { doing: arr(r.doing, `agents.${id}.doing`, LIMITS.doing).map((x) => {
            const d = obj(x, 'doing');
            if (d.kind !== undefined && (typeof d.kind !== 'string' || !DOING_KINDS.has(d.kind))) throw new Invalid(`doing.kind must be one of ${[...DOING_KINDS].join(', ')}`);
            const since = optStr(d.since, 'doing.since');
            if (since !== undefined && !Number.isFinite(Date.parse(since))) throw new Invalid('doing.since is a time (ISO 8601)');
            return { text: str(d.text, 'doing.text'), ...(d.kind ? { kind: d.kind as DoingKind } : {}), ...(d.where !== undefined ? { where: str(d.where, 'doing.where') } : {}),
              ...(since ? { since } : {}), ...(d.page !== undefined ? { page: page(d.page, 'doing.page') } : {}) };
          }) } : {}),
        };
      }
    }
    return m;
  });
}

/**
 * Validate a piece's `ui page --json` answer. A block's own words over their limit are cut short and the block marked
 * (long()); `onCut` hears which, to log. Anything else out of bounds (too many sections, blocks or rows; a bad name or
 * path) still refuses the page.
 */
export function parsePage(value: unknown, onCut?: (fields: string[]) => void): Page | string {
  const out = attempt(() => {
    const top = obj(value, 'page');
    const r = top.refresh;
    if (r !== undefined && (typeof r !== 'number' || !Number.isInteger(r) || r < 2 || r > 300)) throw new Invalid('refresh must be whole seconds from 2 to 300');
    const add = top.add === undefined ? undefined : obj(top.add, 'add');
    return { title: str(top.title, 'title'), intro: optStr(top.intro, 'intro'), sections: sections(top.sections), ...(r !== undefined ? { refresh: r } : {}),
      ...(add ? { add: { page: page(add.page, 'add.page') ?? '', label: str(add.label, 'add.label') } } : {}) };
  });
  const cut = cuts.all;
  cuts = { all: [], open: 0 };
  if (cut.length && typeof out !== 'string') onCut?.(cut);
  return out;
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
