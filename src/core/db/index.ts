import Database from 'better-sqlite3';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
export type Db = Database.Database;
export interface Migration { number: number; sql: string }
const opened = new Map<string, { db: Db; refs: number }>();
export function openDb(home: string): { db: Db; close(): void } {
  mkdirSync(home, { recursive: true });
  const path = join(realpathSync(home), 'loom.db');
  const existing = opened.get(path);
  if (existing) { existing.refs++; return lease(path, existing); }
  const db = new Database(path, { timeout: 0 });
  try {
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
