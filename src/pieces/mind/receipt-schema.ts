/** Numbered retry-metadata schema in the content source, not loom.db. */
import type { Database } from 'better-sqlite3';
const migrations = [{ number: 1, sql: `CREATE TABLE mind_operation_receipts (
  viewer TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, input_hash TEXT NOT NULL,
  result TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(viewer,id))` }];
export function migrateMindReceipts(db: Database) {
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS mind_source_migrations (number INTEGER PRIMARY KEY, sql TEXT NOT NULL)');
    const applied = db.prepare('SELECT number, sql FROM mind_source_migrations ORDER BY number').all() as Array<{ number: number; sql: string }>;
    for (const old of applied) {
      if (migrations.find(m => m.number === old.number)?.sql !== old.sql) throw new Error('Unknown or changed Mind source migration');
    }
    for (const migration of migrations) {
      if (applied.some(m => m.number === migration.number)) continue;
      db.exec(migration.sql);
      db.prepare('INSERT INTO mind_source_migrations VALUES (?, ?)').run(migration.number, migration.sql);
    }
  }).immediate();
}
