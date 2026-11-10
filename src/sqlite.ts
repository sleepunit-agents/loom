/**
 * Synchronous SQLite is fine for local tools, but a daemon must never sleep on
 * another process's lock. HTTP startup, requests and background timers run in
 * this scope. A contended synchronous operation fails promptly; only an
 * explicitly replay-safe unit may use retrySqlite to wait asynchronously.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout } from 'node:timers/promises';
import BetterSqlite3 from 'better-sqlite3';

const nonblocking = new AsyncLocalStorage<boolean>();
export const sqliteMustYield = (): boolean => nonblocking.getStore() === true;
export function withNonblockingSqlite<T>(fn: () => T): T {
  return nonblocking.run(true, fn);
}
export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED';
}

/** Retry a single transaction/read with no external side effects, never a whole request. */
export async function retrySqlite<T>(fn: () => T, waitMs = 5000): Promise<T> {
  const deadline = performance.now() + waitMs;
  let delay = 10;
  for (;;) {
    try { return fn(); } catch (error) {
      if (!isSqliteBusy(error) || performance.now() >= deadline) throw error;
      await setTimeout(Math.min(delay, Math.max(0, deadline - performance.now())));
      delay = Math.min(delay * 2, 100);
    }
  }
}

/** Keep better-sqlite3's API and types, while guarding both constructor and PRAGMA timeouts. */
const Sqlite: typeof BetterSqlite3 = new Proxy(BetterSqlite3, {
  construct(target, args) {
    if (sqliteMustYield()) args[1] = { ...args[1], timeout: 0 };
    const db = Reflect.construct(target, args) as BetterSqlite3.Database;
    const pragma = db.pragma.bind(db);
    db.pragma = ((source: string, options?: BetterSqlite3.PragmaOptions) => {
      if (sqliteMustYield() && /^\s*busy_timeout\s*=/i.test(source)) source = 'busy_timeout = 0';
      return pragma(source, options);
    }) as typeof db.pragma;
    return db;
  },
});
export default Sqlite;
