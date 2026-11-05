/**
 * Offers: what a managed piece declares, in its package's `loom` block, that it
 * offers through core (docs/extensions.md, "Offers"). Five sibling keys, each
 * with its own schema:
 *
 *   sections   a project section feed           docs/specs/projects.md, "Section feeds (the seam)"
 *   venues     the venues a piece adapts        docs/specs/conversations.md, "Venues" (+ `send`, agent-runtime.md)
 *   mcp_tools  tools core adds to an agent's MCP session   docs/specs/agent-runtime.md, "Seams", 2
 *   grants     the argv core asks before an agent's piece call   docs/specs/agent-runtime.md, "Permissions"
 *   delivery   the argv core forwards POST /api/loom/deliver to (the runtime's)   agent-runtime.md, "Delivery"
 *
 * This module is the one install-time validation path: `parseOffers` checks a
 * block's own declarations (called from parseLoomBlock, so an invalid offer
 * rejects the whole block), and `offerConflicts` checks them against the other
 * installed pieces (a name another piece already declares, a second grants
 * authority or delivery piece). Both are pure; the registry and the runner, which read what's
 * installed and run a piece, are in offers-registry.ts.
 */
import { TOOLS } from './clients.js';

export type VenueKind = 'live' | 'scheduled' | 'agent';

export interface ProjectSection {
  label: string;
  argv: string[];
  /** The piece can also be asked `--unfiled --since <iso>`. */
  unfiled: boolean;
}

/** A Comms thread's work (docs/specs/comms.md, "The thread feed"): run with `--conversation <cv> [--ref <ref>]…`. */
export interface ThreadSection {
  label: string;
  argv: string[];
}

export interface SectionsOffer {
  project?: ProjectSection;
  thread?: ThreadSection;
}

export interface VenueOffer {
  label: string;
  kind: VenueKind;
  /** Run with `--conversation <id>`; answers the section-feed schema. */
  render?: string[];
  /** Run with `--place <place>` and the text on stdin. */
  send?: string[];
}

export interface McpToolOffer {
  description: string;
  /** A JSON schema for the tool's arguments: an object schema. */
  input_schema: Record<string, unknown>;
  /** Run with the arguments, as JSON, on stdin. */
  argv: string[];
}

/** The offer keys of a `loom` block, as the block holds them once checked. */
export interface Offers {
  sections?: SectionsOffer;
  venues?: Record<string, VenueOffer>;
  mcp_tools?: Record<string, McpToolOffer>;
  /**
   * The argv of the grants authority: core runs it with `{agent, piece, path}` on stdin before
   * an agent's call to a piece (src/grants.ts), and it answers `{allow: true}` or
   * `{allow: false, reason}` within 2 s. Only one installed piece may declare it.
   */
  grants?: string[];
  /**
   * The argv core runs with a `deliver` body on stdin (src/delivery.ts). Only a piece whose
   * block says `"role": "runtime"` declares it, and only one installed piece may.
   */
  delivery?: string[];
  /**
   * The piece delivers on core's `wake` venue (POST /api/loom/deliver): declared in `venues` as
   * `"wake": {}`, which references core's venue rather than defining one. The clock does.
   */
  delivers_wake?: true;
}

/** The offers core runs or lists by kind (`delivers_wake` is a permission, not an offer it runs). */
export type OfferKind = 'sections' | 'venues' | 'mcp_tools' | 'grants' | 'delivery';
export const OFFER_KINDS: readonly OfferKind[] = ['sections', 'venues', 'mcp_tools', 'grants', 'delivery'];

export const MAX_ARGV = 16;
export const MAX_ARG = 200;
export const MAX_VENUES = 8;
export const MAX_MCP_TOOLS = 8;
export const MAX_TOOL_DESCRIPTION = 1000;
export const MAX_INPUT_SCHEMA_BYTES = 16 * 1024;

const VENUE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Venues core keeps for itself (conversations.md): `session` (live) and `wake` (scheduled). */
export const CORE_VENUES: readonly string[] = ['session', 'wake', 'loom'];
/** The venue only the runtime (`"role": "runtime"`) may declare. */
export const RUNTIME_VENUE = 'relay';
/**
 * Core's own MCP tools. `loom_*` is core's too: its MCP-App widget tools
 * (src/transport/mcp-app-hello.ts) are named that way.
 */
export const isCoreMcpTool = (name: string): boolean => (TOOLS as readonly string[]).includes(name) || name.startsWith('loom_');

/**
 * A declared name in an offer map (venues, mcp_tools), looked up as the map's own key only: a
 * name like `constructor` or `toString` must never find what an object inherits. The maps read
 * back from piece.json are plain objects, so every lookup goes through this.
 */
export function ownEntry<T>(map: Record<string, T> | undefined, name: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, name) ? map[name] : undefined;
}

/** A fresh map with no prototype, for the offer maps the parsers build. */
const ownMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function unknownKey(o: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(o).find((k) => !allowed.includes(k));
}

/** An argv a piece declares: 1-16 strings of at most 200, the first one of its own bins. */
function argvError(v: unknown, bins: readonly string[], where: string): string | undefined {
  if (!Array.isArray(v) || !v.length || v.length > MAX_ARGV || !v.every((a) => typeof a === 'string' && a.length <= MAX_ARG)) {
    return `${where} is a list of 1-${MAX_ARGV} strings of at most ${MAX_ARG} characters`;
  }
  if (!bins.includes(v[0] as string)) {
    return `${where}[0] must be one of the piece's own bins (${bins.length ? bins.join(', ') : 'it has none'}), not ${JSON.stringify(v[0])}`;
  }
  return undefined;
}

function parseSections(raw: unknown, bins: readonly string[]): SectionsOffer | undefined | string {
  if (!isObject(raw)) return 'loom.sections is not an object';
  const bad = unknownKey(raw, ['project', 'thread']);
  if (bad !== undefined) return `loom.sections has two keys, project and thread: not ${JSON.stringify(bad)}`;
  let thread: ThreadSection | undefined;
  if (raw.thread !== undefined) {
    const t = raw.thread;
    if (!isObject(t)) return 'loom.sections.thread is not an object';
    const badT = unknownKey(t, ['label', 'argv']);
    if (badT !== undefined) return `loom.sections.thread has no key ${JSON.stringify(badT)} (it has label, argv)`;
    if (!str(t.label, 40)) return 'loom.sections.thread.label is required: a string of at most 40 characters';
    const ta = argvError(t.argv, bins, 'loom.sections.thread.argv');
    if (ta) return ta;
    thread = { label: t.label, argv: [...(t.argv as string[])] };
  }
  if (raw.project === undefined) return thread ? { thread } : undefined;
  const p = raw.project;
  if (!isObject(p)) return 'loom.sections.project is not an object';
  const badP = unknownKey(p, ['label', 'argv', 'unfiled']);
  if (badP !== undefined) return `loom.sections.project has no key ${JSON.stringify(badP)} (it has label, argv, unfiled)`;
  if (!str(p.label, 40)) return 'loom.sections.project.label is required: a string of at most 40 characters';
  const a = argvError(p.argv, bins, 'loom.sections.project.argv');
  if (a) return a;
  if (p.unfiled !== undefined && typeof p.unfiled !== 'boolean') return 'loom.sections.project.unfiled is true or false';
  return { project: { label: p.label, argv: [...(p.argv as string[])], unfiled: p.unfiled === true }, ...(thread ? { thread } : {}) };
}

/** Core's venue a piece may say it delivers on, with an empty entry (agent-runtime.md, "Delivery"). */
export const DELIVERABLE_CORE_VENUE = 'wake';

function parseVenues(raw: unknown, bins: readonly string[], role: string | undefined): { venues: Record<string, VenueOffer>; wake: boolean } | string {
  if (!isObject(raw)) return 'loom.venues is not an object';
  const names = Object.keys(raw);
  if (names.length > MAX_VENUES) return `loom.venues declares at most ${MAX_VENUES} venues`;
  const out = ownMap<VenueOffer>();
  let wake = false;
  for (const name of names) {
    if (!VENUE_NAME.test(name)) return `a venue's name is lowercase letters, digits and dashes, starting with a letter, at most 32: ${JSON.stringify(name)}`;
    if (name === DELIVERABLE_CORE_VENUE) {
      const v = raw[name];
      if (!isObject(v) || Object.keys(v).length) return `venue ${name} is core's own: a piece that delivers on it declares "${name}": {} (and defines nothing)`;
      wake = true;
      continue;
    }
    if (CORE_VENUES.includes(name)) return `venue ${name} is core's own`;
    if (name === RUNTIME_VENUE && role !== 'runtime') return `venue ${RUNTIME_VENUE} is declared only by the runtime (a loom block with "role": "runtime")`;
    const v = raw[name];
    if (!isObject(v)) return `venue ${name} is not an object`;
    const bad = unknownKey(v, ['label', 'kind', 'render', 'send']);
    if (bad !== undefined) return `venue ${name} has no key ${JSON.stringify(bad)} (it has label, kind, render, send)`;
    if (!str(v.label, 40)) return `venue ${name}: label is required, a string of at most 40 characters`;
    if (v.kind !== 'live' && v.kind !== 'scheduled' && v.kind !== 'agent') return `venue ${name}: kind is live, scheduled or agent`;
    const venue: VenueOffer = { label: v.label, kind: v.kind };
    for (const k of ['render', 'send'] as const) {
      if (v[k] === undefined) continue;
      const a = argvError(v[k], bins, `venue ${name}: ${k}`);
      if (a) return a;
      venue[k] = [...(v[k] as string[])];
    }
    out[name] = venue;
  }
  return { venues: out, wake };
}

function parseMcpTools(raw: unknown, bins: readonly string[]): Record<string, McpToolOffer> | string {
  if (!isObject(raw)) return 'loom.mcp_tools is not an object';
  const names = Object.keys(raw);
  if (names.length > MAX_MCP_TOOLS) return `loom.mcp_tools offers at most ${MAX_MCP_TOOLS} tools`;
  const out = ownMap<McpToolOffer>();
  for (const name of names) {
    if (!TOOL_NAME.test(name)) return `a tool's name is lowercase letters, digits and underscores, starting with a letter, at most 64: ${JSON.stringify(name)}`;
    if (isCoreMcpTool(name)) return `tool ${name} is core's own`;
    const t = raw[name];
    if (!isObject(t)) return `tool ${name} is not an object`;
    const bad = unknownKey(t, ['description', 'input_schema', 'argv']);
    if (bad !== undefined) return `tool ${name} has no key ${JSON.stringify(bad)} (it has description, input_schema, argv)`;
    if (!str(t.description, MAX_TOOL_DESCRIPTION)) return `tool ${name}: description is required, a string of at most ${MAX_TOOL_DESCRIPTION} characters`;
    const s = t.input_schema;
    if (!isObject(s) || s.type !== 'object') return `tool ${name}: input_schema is a JSON schema for an object ({"type": "object", …})`;
    if (s.properties !== undefined && !isObject(s.properties)) return `tool ${name}: input_schema.properties is an object`;
    if (Buffer.byteLength(JSON.stringify(s)) > MAX_INPUT_SCHEMA_BYTES) return `tool ${name}: input_schema is at most ${MAX_INPUT_SCHEMA_BYTES / 1024} KB`;
    const a = argvError(t.argv, bins, `tool ${name}: argv`);
    if (a) return a;
    out[name] = { description: t.description, input_schema: s, argv: [...(t.argv as string[])] };
  }
  return out;
}

/**
 * The offer keys of a raw `loom` block, checked against the piece's own bins
 * and its role; a string says what's wrong. An offer that declares nothing
 * (`venues: {}`) is left out, so a present key always offers.
 */
export function parseOffers(b: Record<string, unknown>, ctx: { bins?: readonly string[]; role?: string }): Offers | string {
  const bins = ctx.bins ?? [];
  const out: Offers = {};
  if (b.sections !== undefined) {
    const s = parseSections(b.sections, bins);
    if (typeof s === 'string') return s;
    if (s) out.sections = s;
  }
  if (b.venues !== undefined) {
    const v = parseVenues(b.venues, bins, ctx.role);
    if (typeof v === 'string') return v;
    if (Object.keys(v.venues).length) out.venues = v.venues;
    if (v.wake) out.delivers_wake = true;
  }
  if (b.mcp_tools !== undefined) {
    const t = parseMcpTools(b.mcp_tools, bins);
    if (typeof t === 'string') return t;
    if (Object.keys(t).length) out.mcp_tools = t;
  }
  if (b.grants !== undefined && b.grants !== false) {
    // An argv core asks (agent-runtime.md, "Seams", 2). `true` was the placeholder before the ask existed.
    if (b.grants === true || isObject(b.grants)) return 'loom.grants is an argv core runs with {agent, piece, path} on stdin (["<bin>", ...]), not true';
    const a = argvError(b.grants, bins, 'loom.grants');
    if (a) return a;
    out.grants = [...(b.grants as string[])];
  }
  if (b.delivery !== undefined) {
    if (ctx.role !== 'runtime') return 'loom.delivery is declared only by the runtime (a loom block with "role": "runtime")';
    const a = argvError(b.delivery, bins, 'loom.delivery');
    if (a) return a;
    out.delivery = [...(b.delivery as string[])];
  }
  return out;
}

/** Just the offer keys of a checked block (a PieceRecord's `loom`). */
export function offersIn(loom: Offers): Offers {
  const out: Offers = {};
  for (const k of OFFER_KINDS) if (loom[k] !== undefined) (out as Record<string, unknown>)[k] = loom[k];
  if (loom.delivers_wake === true) out.delivers_wake = true;
  return out;
}

/**
 * What stops piece `name` from offering `offers` beside the other installed
 * pieces (its own earlier version is not one of them): a venue or tool name
 * another piece declares, a second grants authority, a second delivery piece, or a second
 * `role: runtime` piece. Undefined when nothing.
 */
export function offerConflicts(name: string, offers: Offers & { role?: string }, installed: readonly { name: string; loom: Offers & { role?: string } }[]): string | undefined {
  for (const other of installed) {
    if (other.name === name) continue;
    for (const v of Object.keys(offers.venues ?? {})) {
      if (ownEntry(other.loom.venues, v)) return `venue ${v} is already the ${other.name} piece's`;
    }
    for (const t of Object.keys(offers.mcp_tools ?? {})) {
      if (ownEntry(other.loom.mcp_tools, t)) return `tool ${t} is already the ${other.name} piece's`;
    }
    if (offers.grants && other.loom.grants) return `the ${other.name} piece is already the grants authority: there is only one`;
    if (offers.delivery && other.loom.delivery) return `the ${other.name} piece already offers delivery: there is only one`;
    // A household has one runtime (conversations.md: the runtime token is minted for the one piece).
    if (offers.role === 'runtime' && other.loom.role === 'runtime') return `the ${other.name} piece is already the runtime: a household has one`;
  }
  return undefined;
}

// ─── Feed output (projects.md "Section feeds", Output) ───────────────────────

export interface FeedItem {
  title: string;
  when?: string;
  who?: string[];
  person?: string[];
  status?: string;
  ref?: string;
  /** A page of the feed's own piece, or `loom:<page>` (projects.md, "Output"). */
  page?: string;
  /** An https URL that opens outside. */
  href?: string;
  body?: string;
}
/** `waiting`: these items wait on the owner; the Projects index counts them. */
export interface FeedGroup { title: string; waiting?: boolean; items: FeedItem[] }
export interface Feed { groups: FeedGroup[] }

export const FEED_MAX_BYTES = 64 * 1024;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** A feed item's `page`: an optional `loom:`, a page path (lowercase letters, digits and . _ ~ / -, no `..` segment),
 * an optional `?key=value&…` query. The page draws it through splitPage, which checks what a `loom:` may reach. */
const FEED_PAGE = /^(?:loom:)?(?:[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)*)?(?:\?[a-z0-9_-]+=[^&#\s]*(?:&[a-z0-9_-]+=[^&#\s]*)*)?$/;
/** No `..` segment, anywhere. */
const DOTDOT = /(?:^|:|\/)\.\.(?:\/|\?|$)/;
const HTTPS = /^https:\/\/[^\s<>"]+$/;

function strList(v: unknown, maxItems: number, maxLen: number, re?: RegExp): v is string[] {
  return Array.isArray(v) && v.length <= maxItems && v.every((x) => str(x, maxLen) && (!re || re.test(x)));
}

/**
 * A section feed's answer (also a venue's `render`): `{groups: [{title, items}]}`,
 * at most 8 groups and 50 items in all, every key known. A string says what's wrong.
 */
export function parseFeed(v: unknown): Feed | string {
  if (!isObject(v)) return 'not a JSON object';
  const bad = unknownKey(v, ['groups']);
  if (bad !== undefined) return `unknown key ${JSON.stringify(bad)}`;
  if (!Array.isArray(v.groups) || v.groups.length > 8) return 'groups is a list of at most 8';
  let items = 0;
  const groups: FeedGroup[] = [];
  for (const [gi, g] of v.groups.entries()) {
    if (!isObject(g)) return `groups[${gi}] is not an object`;
    const bg = unknownKey(g, ['title', 'waiting', 'items']);
    if (bg !== undefined) return `groups[${gi}]: unknown key ${JSON.stringify(bg)}`;
    if (!str(g.title, 80)) return `groups[${gi}].title is required, at most 80 characters`;
    if (!Array.isArray(g.items)) return `groups[${gi}].items is a list`;
    if (g.waiting !== undefined && typeof g.waiting !== 'boolean') return `groups[${gi}].waiting is true or false`;
    items += g.items.length;
    if (items > 50) return 'at most 50 items in all';
    const out: FeedItem[] = [];
    for (const [ii, it] of g.items.entries()) {
      const at = `groups[${gi}].items[${ii}]`;
      if (!isObject(it)) return `${at} is not an object`;
      const bi = unknownKey(it, ['title', 'when', 'who', 'person', 'status', 'ref', 'page', 'href', 'body']);
      if (bi !== undefined) return `${at}: unknown key ${JSON.stringify(bi)}`;
      if (!str(it.title, 200)) return `${at}.title is required, at most 200 characters`;
      if (it.when !== undefined && !(typeof it.when === 'string' && ISO_UTC.test(it.when))) return `${at}.when is an ISO-8601 UTC time`;
      if (it.who !== undefined && !strList(it.who, 8, 80)) return `${at}.who is at most 8 names of at most 80 characters`;
      if (it.person !== undefined && !strList(it.person, 8, 80, SLUG)) return `${at}.person is at most 8 person slugs`;
      if (it.status !== undefined && !str(it.status, 24)) return `${at}.status is at most 24 characters`;
      if (it.ref !== undefined && !str(it.ref, 200)) return `${at}.ref is at most 200 characters`;
      if (it.page !== undefined && !(str(it.page, 200) && FEED_PAGE.test(it.page) && !DOTDOT.test(it.page))) return `${at}.page is a page path (or loom:<page>), at most 200 characters`;
      if (it.href !== undefined && !(str(it.href, 500) && HTTPS.test(it.href))) return `${at}.href is an https URL, at most 500 characters`;
      if (it.page !== undefined && it.href !== undefined) return `${at} has a page or an href, not both`;
      if (it.body !== undefined && !str(it.body, 600)) return `${at}.body is at most 600 characters`;
      out.push(it as unknown as FeedItem);
    }
    groups.push({ title: g.title, ...(g.waiting === true ? { waiting: true } : {}), items: out });
  }
  return { groups };
}
