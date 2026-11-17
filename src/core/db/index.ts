import Database from 'better-sqlite3';
import { closeSync, constants, fchmodSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { assertHomeReady } from '../home-state.js';
export type Db = Database.Database;
export interface Migration { number: number; sql: string }
const opened = new Map<string, { db: Db; refs: number }>();
export function openDb(home: string): { db: Db; close(): void } {
  assertHomeReady(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(realpathSync(home), 'loom.db');
  const existing = opened.get(path);
  if (existing) { existing.refs++; return lease(path, existing); }
  // SQLite inherits the main file's mode for WAL/SHM. Secure it before SQLite
  // can create a journal or accept credentials, including an older public DB.
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  for (const suffix of ['-wal', '-shm']) {
    let side: number;
    try { side = openSync(path + suffix, constants.O_RDWR | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    try { fchmodSync(side, 0o600); } finally { closeSync(side); }
  }
  const db = new Database(path, { timeout: 0 });
  try {
    // A served home keeps the household database (src/core/data) at this same path. This older
    // foundation would add its own table to it, and `loom serve` would then refuse the database.
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'migrations'").get()) throw new Error('This home holds a household database, which the older foundation must not open');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE IF NOT EXISTS core_migrations (piece TEXT NOT NULL, number INTEGER NOT NULL, sql TEXT NOT NULL, PRIMARY KEY(piece, number))');
  } catch (e) { db.close(); throw e; }
  const entry = { db, refs: 1 }; opened.set(path, entry);
  return lease(path, entry);
}
function lease(path: string, entry: { db: Db; refs: number }) {
  let closed = false;
  return { db: entry.db, close() {
    if (closed) return; closed = true;
    if (--entry.refs === 0) { entry.db.close(); opened.delete(path); }
  } };
}
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
