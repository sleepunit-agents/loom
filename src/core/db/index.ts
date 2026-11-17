/** A connection's type, and statements prepared once per connection. */
import type Database from 'better-sqlite3';
export type Db = Database.Database;
export interface Migration { number: number; sql: string }
/** Numbered steps for one piece's own tables, recorded in `core_migrations`, which the caller must have created.
 * The household database does not use this (src/core/data/database.ts upgrades it). The one caller left is the
 * dispatcher's built-in receipt table, used when it is given no receipt store, which only tests do. */
export function migrate(db: Db, piece: string, migrations: Migration[]): void {
  if (!/^[a-z][a-z0-9_]*$/.test(piece)) throw new Error('invalid piece name');
  const ordered = [...migrations].sort((a, b) => a.number - b.number);
  if (ordered.some((m, i) => !Number.isInteger(m.number) || m.number < 1 || (i > 0 && ordered[i - 1].number === m.number))) throw new Error('invalid migration numbers');
  db.transaction(() => {
    for (const m of ordered) {
      const old = db.prepare('SELECT sql FROM core_migrations WHERE piece = ? AND number = ?').get(piece, m.number) as { sql: string } | undefined;
      if (old) { if (old.sql !== m.sql) throw new Error('applied migration changed'); continue; }
      const latest = db.prepare('SELECT max(number) AS n FROM core_migrations WHERE piece = ?').get(piece) as { n: number | null };
      if (latest.n !== null && m.number < latest.n) throw new Error('migration inserted before applied history');
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
      db.exec(m.sql);
      const added = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).filter(r => !tables.has(r.name) && !r.name.startsWith('sqlite_'));
      if (added.some(r => !r.name.startsWith(`${piece}_`))) throw new Error('migration table must carry its piece prefix');
      db.prepare('INSERT INTO core_migrations VALUES (?, ?, ?)').run(piece, m.number, m.sql);
    }
  })();
}

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
