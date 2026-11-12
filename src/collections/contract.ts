/**
 * Shared collections: the contract (docs/specs/collections.md, "Declaring a provider"). What a provider
 * publishes, checked once at install for a piece (the `collections` offer of its `loom` block) and in code for
 * core's own types, through the same structures, so core's types obey the same rules as a piece's.
 *
 * Nothing here names a client library or GraphQL type (collections.md, "Decided", 4). This module is pure: the
 * route, the viewer checks and the provider runs are in query.ts, viewer.ts and providers.ts.
 */

/** Who may ever be sent a field (collections.md, "fields"). There's no class for secret values. */
export type FieldClass = 'household' | 'member' | 'owner';
export const FIELD_CLASSES: readonly FieldClass[] = ['household', 'member', 'owner'];

export type FilterOp = 'eq' | 'in' | 'prefix' | 'lt' | 'lte' | 'gt' | 'gte' | 'has';
export const FILTER_OPS: readonly FilterOp[] = ['eq', 'in', 'prefix', 'lt', 'lte', 'gt', 'gte', 'has'];

export interface FieldDecl {
  class: FieldClass;
  filter?: FilterOp[];
  order?: boolean;
  heavy?: boolean;
  search?: boolean;
  /** false: core never stores it (its change log, its index, a held change). Always heavy too. */
  kept?: boolean;
}

export interface AggregateDecl { by?: string[] }

export interface TypeDecl {
  /** `major.minor`. */
  version: string;
  schema: Record<string, unknown>;
  /** The field naming the agent a record belongs to, if any: what core's agent rule reads. */
  agent?: string;
  fields: Record<string, FieldDecl>;
  default_fields: string[];
  max_page: number;
  aggregates?: Record<string, AggregateDecl>;
  domain: 'type' | 'provider';
  audience: 'rows' | 'ask';
  houses: boolean;
  services: boolean;
  /** The provider's counts are per viewer (it passed the conformance run's count fixtures). */
  scoped_counts: boolean;
  /** The provider's search is per viewer (it passed the hidden-field search fixtures). */
  scoped_search: boolean;
}

export interface CollectionsOffer {
  /** 2: the provider scopes agent owners to their agents. Without it, it answers household owners only. */
  owners?: 2;
  query: string[];
  /** Serve query batches over the bounded persistent request protocol (query argv plus --serve). */
  query_serve?: true;
  changes?: string[];
  search?: string[];
  types: Record<string, TypeDecl>;
}

/** Provider names: the role, else the installed name (collections.md, "Record keys"). `loom` is core's. */
export const PROVIDER = /^[a-z][a-z0-9-]{0,39}$/;
export const TYPE = /^[a-z][a-z0-9-]{0,31}$/;
/** A record's own id: never a `/`, so a key always splits in three. */
export const RECORD_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const FIELD = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const VERSION = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
export const CORE_PROVIDER = 'loom';

export const MAX_TYPES = 16;
export const MAX_FIELDS = 64;
export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_PAGE_LIMIT = 500;
export const MAX_AGGREGATES = 8;
/** Field names core keeps for itself in every row it sends. */
export const RESERVED_FIELDS: readonly string[] = ['key', 'id', 'audience', 'expires'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ownMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const unknownKey = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).find((k) => !allowed.includes(k));

/** A type's major version (`1.2` → 1). */
export const majorOf = (version: string): number => Number(version.split('.')[0]);

/** An argv check the caller supplies (offers.ts' argvError: 1-16 strings, the first one of the piece's bins). */
export type ArgvCheck = (v: unknown, where: string) => string | undefined;

function parseField(name: string, raw: unknown, where: string): FieldDecl | string {
  if (!isObject(raw)) return `${where} is not an object`;
  const bad = unknownKey(raw, ['class', 'filter', 'order', 'heavy', 'search', 'kept']);
  if (bad !== undefined) return `${where} has no key ${JSON.stringify(bad)} (it has class, filter, order, heavy, search, kept)`;
  if (!FIELD_CLASSES.includes(raw.class as FieldClass)) return `${where}.class is household, member or owner (there's no class for secret values: a token, a key or a password is not a field)`;
  const out: FieldDecl = { class: raw.class as FieldClass };
  if (raw.filter !== undefined) {
    if (!Array.isArray(raw.filter) || !raw.filter.length || raw.filter.length > FILTER_OPS.length || !raw.filter.every((o) => FILTER_OPS.includes(o as FilterOp)) || new Set(raw.filter).size !== raw.filter.length) {
      return `${where}.filter is a list of operators, each once: ${FILTER_OPS.join(', ')}`;
    }
    out.filter = [...raw.filter] as FilterOp[];
  }
  for (const k of ['order', 'heavy', 'search', 'kept'] as const) {
    if (raw[k] !== undefined) {
      if (typeof raw[k] !== 'boolean') return `${where}.${k} is true or false`;
      out[k] = raw[k] as boolean;
    }
  }
  if (out.kept === false) {
    // A field core never keeps is read per request: always heavy, never a filter, an order or a count.
    if (out.heavy === false) return `${where}: a kept: false field is always heavy`;
    if (out.filter || out.order) return `${where}: a kept: false field can't be filtered or ordered on (core never holds it)`;
    out.heavy = true;
  }
  if (out.heavy && (out.filter || out.order)) return `${where}: a heavy field can't be filtered or ordered on`;
  void name;
  return out;
}

/** One type's declaration, checked; a string says what's wrong. */
export function parseTypeDecl(name: string, raw: unknown, where = `collections.types.${name}`): TypeDecl | string {
  if (!TYPE.test(name)) return `a type's name is lowercase letters, digits and dashes, starting with a letter, at most 32: ${JSON.stringify(name)}`;
  if (!isObject(raw)) return `${where} is not an object`;
  const bad = unknownKey(raw, ['version', 'schema', 'agent', 'fields', 'default_fields', 'max_page', 'aggregates', 'domain', 'audience', 'houses', 'services', 'scoped_counts', 'scoped_search']);
  if (bad !== undefined) return `${where} has no key ${JSON.stringify(bad)}`;
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) return `${where}.version is major.minor (1.2)`;
  if (!isObject(raw.schema)) return `${where}.schema is a JSON schema of one record (an object)`;
  if (Buffer.byteLength(JSON.stringify(raw.schema)) > MAX_SCHEMA_BYTES) return `${where}.schema is at most ${MAX_SCHEMA_BYTES / 1024} KB`;
  if (!isObject(raw.fields) || !Object.keys(raw.fields).length) return `${where}.fields lists every field the type has`;
  const names = Object.keys(raw.fields);
  if (names.length > MAX_FIELDS) return `${where}.fields has at most ${MAX_FIELDS} fields`;
  const fields = ownMap<FieldDecl>();
  for (const f of names) {
    if (!FIELD.test(f)) return `${where}: a field's name is a letter then letters, digits and underscores, at most 64: ${JSON.stringify(f)}`;
    if (RESERVED_FIELDS.includes(f)) return `${where}: ${f} is core's own field in every row`;
    const d = parseField(f, raw.fields[f], `${where}.fields.${f}`);
    if (typeof d === 'string') return d;
    fields[f] = d;
  }
  const declared = (f: unknown): f is string => typeof f === 'string' && Object.hasOwn(fields, f);
  let agent: string | undefined;
  if (raw.agent !== undefined) {
    if (!declared(raw.agent)) return `${where}.agent names one of its fields`;
    if (fields[raw.agent].heavy) return `${where}.agent can't be a heavy field`;
    // Core's agent rule reads it for every viewer, so whether it names one of theirs is something every viewer learns.
    if (fields[raw.agent].class === 'owner') return `${where}.agent can't be an owner-class field`;
    agent = raw.agent;
  }
  if (!Array.isArray(raw.default_fields) || !raw.default_fields.every(declared) || new Set(raw.default_fields).size !== raw.default_fields.length) {
    return `${where}.default_fields lists declared fields, each once`;
  }
  if (raw.default_fields.some((f) => fields[f as string].heavy)) return `${where}.default_fields can't name a heavy field (it's left out of lists unless asked for by name)`;
  if (!Number.isInteger(raw.max_page) || (raw.max_page as number) < 1 || (raw.max_page as number) > MAX_PAGE_LIMIT) return `${where}.max_page is a whole number from 1 to ${MAX_PAGE_LIMIT}`;
  let aggregates: Record<string, AggregateDecl> | undefined;
  if (raw.aggregates !== undefined) {
    if (!isObject(raw.aggregates) || Object.keys(raw.aggregates).length > MAX_AGGREGATES) return `${where}.aggregates is an object of at most ${MAX_AGGREGATES}`;
    aggregates = ownMap<AggregateDecl>();
    for (const [a, d] of Object.entries(raw.aggregates)) {
      if (!FIELD.test(a)) return `${where}.aggregates: ${JSON.stringify(a)} isn't a name`;
      if (!isObject(d) || unknownKey(d, ['by']) !== undefined) return `${where}.aggregates.${a} is {by?: [field, …]}`;
      if (d.by !== undefined && (!Array.isArray(d.by) || d.by.length > 2 || !d.by.every(declared) || d.by.some((f) => fields[f as string].heavy))) {
        return `${where}.aggregates.${a}.by names at most two declared fields, none heavy`;
      }
      aggregates[a] = d.by ? { by: [...d.by as string[]] } : {};
    }
  }
  const choice = <T extends string>(k: string, vals: readonly T[], dflt: T): T | string => {
    if (raw[k] === undefined) return dflt;
    return vals.includes(raw[k] as T) ? raw[k] as T : `${where}.${k} is ${vals.join(' or ')}`;
  };
  const domain = choice('domain', ['type', 'provider'] as const, 'type');
  if (!['type', 'provider'].includes(domain)) return domain;
  const audience = choice('audience', ['rows', 'ask'] as const, 'rows');
  if (!['rows', 'ask'].includes(audience)) return audience;
  const flag = (k: string): boolean | string => raw[k] === undefined ? false : typeof raw[k] === 'boolean' ? raw[k] as boolean : `${where}.${k} is true or false`;
  const houses = flag('houses'), services = flag('services'), scopedCounts = flag('scoped_counts'), scopedSearch = flag('scoped_search');
  for (const v of [houses, services, scopedCounts, scopedSearch]) if (typeof v === 'string') return v;
  if (services === true && houses !== true) return `${where}.services needs houses: true (a service house is a house)`;
  // A provider's counts and search hits are numbers and matches core can't recheck: a type may say they're per viewer
  // only once its conformance run passes the per-viewer fixtures (collections.md, "Counts"), and that run (t-2026)
  // doesn't exist yet. Until it does, nothing may claim it.
  if (scopedCounts === true || scopedSearch === true) return `${where}: scoped_counts and scoped_search need a passing conformance run, which loom can't make yet (t-2026)`;
  return {
    version: raw.version, schema: raw.schema, ...(agent ? { agent } : {}), fields, default_fields: [...raw.default_fields as string[]], max_page: raw.max_page as number,
    ...(aggregates ? { aggregates } : {}), domain: domain as TypeDecl['domain'], audience: audience as TypeDecl['audience'],
    houses: houses as boolean, services: services as boolean, scoped_counts: scopedCounts as boolean, scoped_search: scopedSearch as boolean,
  };
}

/** A piece's `collections` offer, checked; a string says what's wrong. */
export function parseCollectionsOffer(raw: unknown, argv: ArgvCheck): CollectionsOffer | string {
  if (!isObject(raw)) return 'loom.collections is not an object';
  const bad = unknownKey(raw, ['owners', 'query', 'query_serve', 'changes', 'search', 'types']);
  if (bad !== undefined) return `loom.collections has no key ${JSON.stringify(bad)} (it has owners, query, query_serve, changes, search, types)`;
  if (raw.owners !== undefined && raw.owners !== 2) return 'loom.collections.owners is 2 (it scopes agent owners to their agents) or absent';
  const out: Partial<CollectionsOffer> = {};
  if (raw.owners === 2) out.owners = 2;
  if (raw.query_serve !== undefined && raw.query_serve !== true) return 'loom.collections.query_serve is true or absent';
  if (raw.query_serve === true) out.query_serve = true;
  for (const k of ['query', 'changes', 'search'] as const) {
    if (raw[k] === undefined) { if (k === 'query') return 'loom.collections.query is required: the argv core runs with a batch of queries'; continue; }
    const a = argv(raw[k], `loom.collections.${k}`);
    if (a) return a;
    out[k] = [...raw[k] as string[]];
  }
  if (!isObject(raw.types) || !Object.keys(raw.types).length) return 'loom.collections.types declares at least one record type';
  if (Object.keys(raw.types).length > MAX_TYPES) return `loom.collections.types declares at most ${MAX_TYPES} types`;
  const types = ownMap<TypeDecl>();
  for (const [t, d] of Object.entries(raw.types)) {
    const p = parseTypeDecl(t, d);
    if (typeof p === 'string') return p;
    if (p.scoped_search && !out.search) return `collections.types.${t}.scoped_search needs a search argv`;
    types[t] = p;
  }
  out.types = types;
  return out as CollectionsOffer;
}

/** The name a piece publishes under: its role (a replacement keeps every key), else its installed name. */
export function providerName(piece: { name: string; loom: { role?: string } }): string {
  return piece.loom.role ?? piece.name;
}

/**
 * What stops piece `name` (role `role`, publishing `offer` or nothing) from being installed beside the others: `loom`
 * is core's, and a provider name is one piece's, whether another piece holds it as its role or its installed name
 * (collections.md, "Record keys"). Checked both ways, so a piece that publishes nothing can't later take the name of
 * one that does. Undefined when nothing.
 */
export function providerConflict(name: string, offer: CollectionsOffer | undefined, role: string | undefined, installed: readonly { name: string; loom: { role?: string; collections?: CollectionsOffer } }[]): string | undefined {
  const mine = role ?? name;
  if (offer) {
    if (!PROVIDER.test(mine)) return `provider name ${JSON.stringify(mine)} isn't a name (lowercase letters, digits and dashes)`;
    if (mine === CORE_PROVIDER) return 'provider name loom is core\'s own';
  }
  for (const other of installed) {
    if (other.name === name) continue;
    if (offer && (other.name === mine || other.loom.role === mine)) return `provider name ${mine} is already the ${other.name} piece's`;
    if (other.loom.collections && [name, role].includes(providerName(other))) return `${providerName(other)} is already the ${other.name} piece's provider name`;
  }
  return undefined;
}
