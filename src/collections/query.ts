/**
 * Asking (docs/specs/collections.md, "Asking: queries"): a window's query checked against its type's declaration and
 * its viewer before any provider runs, and the sealed cursors that page it.
 *
 * Bounded by construction: only declared operators on declared fields, at most 8 clauses, an `in` of at most 100,
 * a page of at most the type's `max_page`, a heavy field only on a small page. A query naming a field the viewer's
 * class can't see in `where`, `order` or an aggregate's `by` is refused, since the rows that come back (or their
 * order) would tell them its value.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FieldClass, FilterOp, TypeDecl } from './contract.js';
import { majorOf, PROVIDER, TYPE } from './contract.js';

export const MAX_QUERIES = 32;
export const MAX_CLAUSES = 8;
export const MAX_IN = 100;
export const MAX_ORDER = 3;
export const MAX_STRING = 200;
const QUERY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** `<provider>/<type>@^<major>` (or `@<major>`): one consumer reads one major of a type. */
const TYPE_REF = /^([a-z][a-z0-9-]{0,39})\/([a-z][a-z0-9-]{0,31})@\^?(0|[1-9][0-9]{0,3})$/;

export type Scalar = string | number | boolean | null;
export type Clause = [string, Exclude<FilterOp, 'has' | 'in'>, Scalar] | [string, 'in', Scalar[]] | [string, 'has'];
export type OrderBy = [string, 'asc' | 'desc'];

/** A query as a window sends it. */
export interface QueryIn {
  id: string;
  type: string;
  where?: unknown;
  order?: unknown;
  limit?: unknown;
  after?: unknown;
  fields?: unknown;
  aggregates?: unknown;
  stream?: unknown;
  subscribe?: unknown;
}

/** A checked query: what the provider is asked, and what the viewer gets back. */
export interface Query {
  id: string;
  provider: string;
  type: string;
  major: number;
  where: Clause[];
  order: OrderBy[];
  limit: number;
  /** Where the page starts: the order key (order values, then id) of the last row before it, unsealed (null: first). */
  after: unknown[] | null;
  /** The fields the viewer gets, of those named (or the defaults). */
  fields: string[];
  /** Named fields the viewer's class may not see: absent from every row, and listed so a window says "hidden". */
  withheld: string[];
  aggregates: string[];
}

export type QueryError = { id: string; error: 'bad-query'; clause?: number; why: string } | { id: string; error: 'unsupported-version' | 'denied' | 'unavailable' | 'too-big'; why?: string };

/** Where a query's type points, before its declaration is looked up. */
export function typeRef(type: unknown): { provider: string; type: string; major: number } | undefined {
  if (typeof type !== 'string') return undefined;
  const m = TYPE_REF.exec(type);
  if (!m || !PROVIDER.test(m[1]) || !TYPE.test(m[2])) return undefined;
  return { provider: m[1], type: m[2], major: Number(m[3]) };
}

export const validQueryId = (id: unknown): id is string => typeof id === 'string' && QUERY_ID.test(id);

const scalar = (v: unknown): v is Scalar => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_STRING);

/**
 * A query checked against its type and what the viewer may see. `classes`: the field classes the viewer may be sent;
 * `householdOwner`: whether they may be sent a record's `audience`. `unseal` opens the window's cursor (sealed to
 * this viewer and query), undefined when it can't.
 */
export function checkQuery(q: QueryIn, decl: TypeDecl, classes: ReadonlySet<FieldClass>, householdOwner: boolean, unseal: (sealed: string, shape: string) => string | undefined): Query | QueryError {
  const id = q.id;
  const ref = typeRef(q.type)!;
  if (majorOf(decl.version) !== ref.major) return { id, error: 'unsupported-version', why: `${ref.provider}/${ref.type} is served at ${decl.version}` };
  const bad = (why: string, clause?: number): QueryError => ({ id, error: 'bad-query', why, ...(clause !== undefined ? { clause } : {}) });
  const visible = (f: string) => Object.hasOwn(decl.fields, f) && classes.has(decl.fields[f].class);
  if (q.subscribe !== undefined && q.subscribe !== false) return bad('subscriptions come with the live stream (t-2022); ask without subscribe');
  // where
  const whereIn = q.where ?? [];
  if (!Array.isArray(whereIn)) return bad('where is a list of clauses');
  if (whereIn.length > MAX_CLAUSES) return bad(`where has at most ${MAX_CLAUSES} clauses`);
  const where: Clause[] = [];
  for (let i = 0; i < whereIn.length; i++) {
    const c = whereIn[i] as unknown[];
    if (!Array.isArray(c) || c.length < 2 || c.length > 3 || typeof c[0] !== 'string' || typeof c[1] !== 'string') return bad('a clause is [field, operator, value]', i);
    const [f, op] = c as [string, string];
    // A field the viewer can't see is refused exactly as one that doesn't exist: the answer says nothing about it.
    if (!visible(f)) return bad(`there's no field ${JSON.stringify(f)} to filter on`, i);
    if (!decl.fields[f].filter?.includes(op as FilterOp)) return bad(`${f} can't be filtered with ${JSON.stringify(op)}`, i);
    if (op === 'has') { if (c.length !== 2) return bad('has takes no value', i); where.push([f, 'has']); continue; }
    if (c.length !== 3) return bad(`${op} takes a value`, i);
    if (op === 'in') {
      if (!Array.isArray(c[2]) || !c[2].length || c[2].length > MAX_IN || !c[2].every(scalar)) return bad(`in takes a list of 1-${MAX_IN} values`, i);
      where.push([f, 'in', [...c[2]] as Scalar[]]);
      continue;
    }
    if (!scalar(c[2])) return bad(`a value is a string of at most ${MAX_STRING}, a number, true, false or null`, i);
    if (op === 'prefix' && (typeof c[2] !== 'string' || !c[2].length)) return bad('prefix takes a string', i);
    where.push([f, op as Exclude<FilterOp, 'has' | 'in'>, c[2] as Scalar]);
  }
  // order
  const orderIn = q.order ?? [];
  if (!Array.isArray(orderIn) || orderIn.length > MAX_ORDER) return bad(`order is a list of at most ${MAX_ORDER} [field, asc|desc]`);
  const order: OrderBy[] = [];
  for (const o of orderIn as unknown[]) {
    if (!Array.isArray(o) || o.length !== 2 || typeof o[0] !== 'string' || (o[1] !== 'asc' && o[1] !== 'desc')) return bad('an order is [field, asc|desc]');
    if (!visible(o[0]) || !decl.fields[o[0]].order) return bad(`there's no field ${JSON.stringify(o[0])} to order by`);
    if (order.some(([f]) => f === o[0])) return bad(`${o[0]} is ordered by twice`);
    order.push([o[0], o[1]]);
  }
  // fields
  let named: string[];
  if (q.fields === undefined) named = [...decl.default_fields];
  else {
    if (!Array.isArray(q.fields) || q.fields.length > 64 || !q.fields.every((f) => typeof f === 'string')) return bad('fields is a list of field names');
    named = [...new Set(q.fields as string[])];
    const unknown = named.find((f) => f !== 'audience' && !Object.hasOwn(decl.fields, f));
    if (unknown !== undefined) return bad(`there's no field ${JSON.stringify(unknown)}`);
  }
  const fields = named.filter((f) => f === 'audience' ? householdOwner : visible(f));
  const withheld = named.filter((f) => !fields.includes(f));
  // limit
  const heavy = fields.some((f) => f !== 'audience' && decl.fields[f].heavy);
  const cap = heavy ? Math.max(1, Math.floor(decl.max_page / 10)) : decl.max_page;
  const limit = q.limit === undefined ? Math.min(50, cap) : q.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1) return bad('limit is a whole number of at least 1');
  if ((limit as number) > cap) return bad(heavy ? `a page with a heavy field has at most ${cap} records` : `a page has at most ${cap} records`);
  // aggregates
  const aggIn = q.aggregates ?? [];
  if (!Array.isArray(aggIn) || !aggIn.every((a) => typeof a === 'string')) return bad('aggregates is a list of names');
  const aggregates = [...new Set(aggIn as string[])];
  for (const a of aggregates) {
    const d = decl.aggregates && Object.hasOwn(decl.aggregates, a) ? decl.aggregates[a] : undefined;
    if (!d) return bad(`there's no aggregate ${JSON.stringify(a)}`);
    if (d.by?.some((f) => !visible(f))) return bad(`there's no aggregate ${JSON.stringify(a)}`);
  }
  // after: sealed to this viewer and this query's shape
  let after: unknown[] | null = null;
  if (q.after !== undefined && q.after !== null) {
    if (typeof q.after !== 'string' || q.after.length > 4096) return bad('after is the cursor a previous page gave');
    const open = unseal(q.after, queryShape(ref, where, order));
    let key: unknown;
    try { key = open === undefined ? undefined : JSON.parse(open); } catch { key = undefined; }
    if (!Array.isArray(key) || key.length !== order.length + 1) return bad('that cursor isn\'t this query\'s (or it expired): ask for the first page again');
    after = key;
  }
  return { id, provider: ref.provider, type: ref.type, major: ref.major, where, order, limit: limit as number, after, fields, withheld, aggregates };
}

/** What a cursor is bound to beside its viewer: the type and the filter and order it pages. */
export function queryShape(ref: { provider: string; type: string; major: number }, where: Clause[], order: OrderBy[]): string {
  return JSON.stringify([ref.provider, ref.type, ref.major, where, order]);
}

// ─── Sealed cursors ──────────────────────────────────────────────────────────

const CURSOR_TTL_MS = 60 * 60 * 1000;
export const MAX_PROVIDER_CURSOR = 1024;

/**
 * Seals a provider's cursor to a viewer and a query (collections.md: "a cursor can't be read, edited or reused by
 * another viewer or query"): AES-256-GCM under the household's cursor key, with the viewer and the query's shape as
 * associated data, so opening it under anything else fails. Every listener reads the same key file.
 */
export class Sealer {
  private key: Buffer | undefined;
  constructor(private readonly file: string) {}

  private keyOf(): Buffer {
    if (this.key) return this.key;
    try { this.key = readFileSync(this.file); } catch { /* made below */ }
    if (!this.key || this.key.length !== 32) {
      mkdirSync(dirname(this.file), { recursive: true });
      try {
        const fd = openSync(this.file, 'wx', 0o600);
        try { writeSync(fd, randomBytes(32)); } finally { closeSync(fd); }
      } catch { /* another listener made it first */ }
      this.key = readFileSync(this.file);
      if (this.key.length !== 32) throw new Error(`the collections cursor key (${this.file}) isn't 32 bytes`);
    }
    return this.key;
  }

  seal(cursor: string, viewer: string, shape: string, now = Date.now()): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keyOf(), iv);
    c.setAAD(aad(viewer, shape));
    const body = Buffer.concat([c.update(JSON.stringify({ c: cursor, x: now + CURSOR_TTL_MS }), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
  }

  unseal(sealed: string, viewer: string, shape: string, now = Date.now()): string | undefined {
    try {
      const raw = Buffer.from(sealed, 'base64url');
      if (raw.length < 29) return undefined;
      const d = createDecipheriv('aes-256-gcm', this.keyOf(), raw.subarray(0, 12));
      d.setAAD(aad(viewer, shape));
      d.setAuthTag(raw.subarray(12, 28));
      const v = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as { c?: unknown; x?: unknown };
      if (typeof v.c !== 'string' || typeof v.x !== 'number' || v.x < now) return undefined;
      return v.c;
    } catch { return undefined; }
  }
}

const aad = (viewer: string, shape: string) => createHash('sha256').update(`loom-collections-cursor\0${viewer}\0${shape}`).digest();

export const sealerFor = (home: string): Sealer => new Sealer(join(home, 'collections', 'cursor.key'));
