/** A connection's type, and statements prepared once per connection. */
import type Database from 'better-sqlite3';
export type Db = Database.Database;
/** Shared synchronous statements: no bound arguments, rows or results are retained. */
export interface StatementMetrics {
  sql: string; calls: number; failures: number; ms: number; prepares: number; prepareMs: number;
}
type SharedStatement = Pick<Database.Statement, 'run' | 'get' | 'all'>;
interface StatementEntry { api: SharedStatement; metrics: StatementMetrics }
interface StatementCache { entries: Map<string, StatementEntry>; evictions: number }
const statementCaches = new WeakMap<Db, StatementCache>();
const MAX_STATEMENTS = 512;
/** get/all/run only: configuration and permanent binding would contaminate reuse. */
export function statement(db: Db, sql: string): SharedStatement {
  let cache = statementCaches.get(db);
  if (!cache) { cache = { entries: new Map(), evictions: 0 }; statementCaches.set(db, cache); }
  const existing = cache.entries.get(sql);
  if (existing) {
    cache.entries.delete(sql); cache.entries.set(sql, existing);
    return existing.api;
  }
  const start = performance.now();
  const prepared = db.prepare(sql);
  const metrics: StatementMetrics = { sql, calls: 0, failures: 0, ms: 0, prepares: 1, prepareMs: performance.now() - start };
  const timed = <T>(run: () => T): T => {
    const start = performance.now(); metrics.calls++;
    try { return run(); } catch (error) { metrics.failures++; throw error; }
    finally { metrics.ms += performance.now() - start; }
  };
  const api: SharedStatement = Object.freeze({
    run: (...args: unknown[]) => timed(() => prepared.run(...args)),
    get: (...args: unknown[]) => timed(() => prepared.get(...args)),
    all: (...args: unknown[]) => timed(() => prepared.all(...args)),
  });
  if (cache.entries.size >= MAX_STATEMENTS) { cache.entries.delete(cache.entries.keys().next().value!); cache.evictions++; }
  cache.entries.set(sql, { api, metrics });
  return api;
}
/** Copies only, suitable for local monitoring. Bounded LRU history resets on eviction. */
export function statementMetrics(db: Db): { statements: StatementMetrics[]; evictions: number } {
  const cache = statementCaches.get(db);
  return { statements: [...(cache?.entries.values() ?? [])].map(entry => ({ ...entry.metrics })), evictions: cache?.evictions ?? 0 };
}
