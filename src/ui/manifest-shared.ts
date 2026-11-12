import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from 'better-sqlite3';
/** Derived manifests and live scope demand. Never persist a listener's environment or a viewer identity. */
import { randomUUID } from 'node:crypto';
import { withLog } from '../collections/log.js';

const reads = new AsyncLocalStorage<{ home: string; db: Database }>();
/** Reuse the delivery pass's read connection until it closes; async continuations then open their own. */
export function withManifestReads<T>(home: string, db: Database, f: () => T): T { return reads.run({ home, db }, f); }
function readShared<T>(home: string, f: (db: Database) => T): T {
  const held = reads.getStore();
  return held?.home === home && held.db.open ? f(held.db) : withLog(home, f);
}

export function manifestDemand(home: string, listener: string, scopes: readonly NodeJS.ProcessEnv[], now = Date.now()): NodeJS.ProcessEnv[] {
  return withLog(home, db => db.transaction(() => {
    db.prepare('DELETE FROM manifest_demand WHERE listener = ? OR until <= ?').run(listener, now);
    const add = db.prepare('INSERT OR REPLACE INTO manifest_demand VALUES (?, ?, ?, ?)');
    for (const env of scopes) add.run(listener, env.LOOM_SCOPE ?? '', env.LOOM_OWNER_SCOPE ?? '', now + 30_000);
    return db.prepare('SELECT DISTINCT scope, owners FROM manifest_demand WHERE until > ?').all(now)
      .map(row => { const r = row as { scope: string; owners: string }; return { LOOM_SCOPE: r.scope, LOOM_OWNER_SCOPE: r.owners }; });
  })());
}

export function invalidateManifest(home: string, path = ''): void {
  withLog(home, db => db.prepare('INSERT OR REPLACE INTO manifest_invalidations VALUES (?, ?)').run(path, randomUUID()));
}
export function manifestToken(home: string, path: string): string {
  return readShared(home, db => JSON.stringify(db.prepare('SELECT path, token FROM manifest_invalidations WHERE path IN (?, ?) ORDER BY path').all('', path)));
}
export function sharedManifest(home: string, key: string): { at: number; value: string } | undefined {
  return readShared(home, db => db.prepare('SELECT at, value FROM manifest_answers WHERE key = ?').get(key) as { at: number; value: string } | undefined);
}
export function saveManifest(home: string, key: string, at: number, value: string): void {
  withLog(home, db => db.transaction(() => {
    db.prepare('DELETE FROM manifest_answers WHERE at < ?').run(Date.now() - 10 * 60_000);
    db.prepare('INSERT INTO manifest_answers VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at=excluded.at, value=excluded.value WHERE excluded.at >= manifest_answers.at').run(key, at, value);
  })());
}
