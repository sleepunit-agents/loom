/**
 * Answering a checked query over records held in memory: core's own small types (core-types.ts) answer this way,
 * as a piece's provider would from its store. Keyset pages: the cursor is the last row's order key, and order always
 * ends with the record id, so a page never repeats or skips a row that didn't move.
 */
import type { TypeDecl } from './contract.js';
import type { Clause, OrderBy, Scalar } from './query.js';

export interface MemRecord { id: string; audience: Record<string, unknown>; expires?: number; [field: string]: unknown }

/** What a provider answers for one query (collections.md, "The answer, per query"), before core's checks. */
export interface ProviderAnswer {
  id: string;
  rows: Record<string, unknown>[];
  /** Whether more rows match past the ones sent (the provider's own word: true only beside a full page, as asked). */
  more: boolean;
  total?: { n: number; exact: boolean };
  aggregates?: Record<string, { n: number; exact: boolean; by?: Record<string, number> }>;
  error?: string;
}

export interface ProviderQuery {
  id: string;
  type: string;
  version: number;
  where: Clause[];
  order: OrderBy[];
  limit: number;
  /** The order key (the order's values, then the id) of the last row before this page; null: the first page. */
  after: unknown[] | null;
  fields: string[];
  aggregates: string[];
}

const rank = (v: unknown): number => (v === undefined || v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : 3);
export function compare(a: unknown, b: unknown): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (typeof a === 'string') return a < (b as string) ? -1 : a > (b as string) ? 1 : 0;
  return (a as number) - (b as number);
}

export function matches(r: Record<string, unknown>, where: readonly Clause[]): boolean {
  return where.every((c) => {
    const v = Object.hasOwn(r, c[0]) ? r[c[0]] : undefined;
    switch (c[1]) {
      case 'has': return v !== undefined && v !== null;
      case 'eq': return compare(v, c[2]) === 0 && rank(v) === rank(c[2]);
      case 'in': return (c[2] as Scalar[]).some((x) => compare(v, x) === 0 && rank(v) === rank(x));
      case 'prefix': return typeof v === 'string' && v.startsWith(c[2] as string);
      case 'lt': return rank(v) === rank(c[2]) && compare(v, c[2]) < 0;
      case 'lte': return rank(v) === rank(c[2]) && compare(v, c[2]) <= 0;
      case 'gt': return rank(v) === rank(c[2]) && compare(v, c[2]) > 0;
      case 'gte': return rank(v) === rank(c[2]) && compare(v, c[2]) >= 0;
    }
  });
}

const keyOf = (r: Record<string, unknown>, order: readonly OrderBy[]): unknown[] => [...order.map(([f]) => r[f] ?? null), r.id];
function cmpKeys(a: unknown[], b: unknown[], order: readonly OrderBy[]): number {
  for (let i = 0; i < a.length; i++) {
    const c = compare(a[i], b[i]);
    if (c) return i < order.length && order[i][1] === 'desc' ? -c : c;
  }
  return 0;
}

/** One query over `records` (each already the provider's choice for this viewer), as a provider answers it. */
export function answerFrom(records: readonly MemRecord[], q: ProviderQuery, decl: TypeDecl, now = Date.now()): ProviderAnswer {
  const live = records.filter((r) => (r.expires === undefined || r.expires > now) && matches(r, q.where));
  live.sort((a, b) => cmpKeys(keyOf(a, q.order), keyOf(b, q.order), q.order));
  let from = 0;
  if (q.after !== null) {
    const k = q.after;
    if (!Array.isArray(k) || k.length !== q.order.length + 1) return { id: q.id, rows: [], more: false, error: 'bad-query' };
    from = live.findIndex((r) => cmpKeys(keyOf(r, q.order), k, q.order) > 0);
    if (from < 0) from = live.length;
  }
  const page = live.slice(from, from + q.limit);
  const more = from + q.limit < live.length;
  const keep = new Set([...q.fields, ...q.order.map(([f]) => f), ...(decl.agent ? [decl.agent] : [])]);
  const rows = page.map((r) => {
    const out: Record<string, unknown> = { id: r.id, audience: r.audience, ...(r.expires !== undefined ? { expires: r.expires } : {}) };
    for (const f of keep) if (f !== 'audience' && Object.hasOwn(r, f)) out[f] = r[f];
    return out;
  });
  const aggregates: NonNullable<ProviderAnswer['aggregates']> = {};
  for (const a of q.aggregates) {
    const by = decl.aggregates?.[a]?.by;
    const counted: Record<string, number> = {};
    if (by) for (const r of live) { const k = by.map((f) => String(r[f] ?? '')).join('/'); counted[k] = (counted[k] ?? 0) + 1; }
    aggregates[a] = { n: live.length, exact: true, ...(by ? { by: counted } : {}) };
  }
  return {
    id: q.id, rows, more,
    total: { n: live.length, exact: true }, ...(q.aggregates.length ? { aggregates } : {}),
  };
}
