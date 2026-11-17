/** Numbered retry-metadata schema in the content source, not loom.db. */
import type { Database } from 'better-sqlite3';
import { OperationError } from '../../core/operations/index.js';
const migrations = [{ number: 1, sql: `CREATE TABLE mind_operation_receipts (
  viewer TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, input_hash TEXT NOT NULL,
  result TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(viewer,id))` }];
/** Startup and recovery only inspect prepared metadata; they never upgrade a
 * precious source. Preparation belongs to the making of a fresh file (`prepareSharedMemorySources`). */
export function mindReceiptsReady(db:Database){
  const has=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  if(!has('mind_source_migrations')||!has('mind_operation_receipts'))return false;
  const applied=db.prepare('SELECT number,sql FROM mind_source_migrations ORDER BY number').all() as Array<{number:number;sql:string}>;
  return applied.length===migrations.length&&applied.every((row,index)=>row.number===migrations[index].number&&row.sql===migrations[index].sql);
}
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
      db.prepare('INSERT INTO mind_source_migrations (number, sql) VALUES (?, ?)').run(migration.number, migration.sql);
    }
  }).immediate();
}

/** Which operation a receipt answers: the caller, its operation id, and what it asked for. */
export interface MindReceiptIdentity { viewer: string; id: string; name: string; inputHash: string }
/** The one reader and writer of `mind_operation_receipts`, for every operation that saves its answer
 * in the same file and transaction as its effect. Each call names its columns, so the table's
 * definition above can change without misfiling a value at a call site. */
export const mindReceipts = {
  /** The unexpired answer saved under this operation id, if any. The same id with other input is refused. */
  find(db: Database, identity: MindReceiptIdentity, now: number): { result: string; expires: number } | undefined {
    const prior = db.prepare('SELECT name, input_hash, result, expires FROM mind_operation_receipts WHERE viewer = ? AND id = ? AND expires > ?')
      .get(identity.viewer, identity.id, now) as { name: string; input_hash: string; result: string; expires: number } | undefined;
    if (!prior) return undefined;
    if (prior.name !== identity.name || prior.input_hash !== identity.inputHash) throw new OperationError('conflict', 'Operation id already used for different input');
    return { result: prior.result, expires: prior.expires };
  },
  /** Forget every receipt whose time has passed. */
  expire(db: Database, now: number): void {
    db.prepare('DELETE FROM mind_operation_receipts WHERE expires <= ?').run(now);
  },
  save(db: Database, identity: MindReceiptIdentity, result: unknown, expires: number): void {
    db.prepare('INSERT INTO mind_operation_receipts (viewer, id, name, input_hash, result, expires) VALUES (?, ?, ?, ?, ?, ?)')
      .run(identity.viewer, identity.id, identity.name, identity.inputHash, JSON.stringify(result), expires);
  },
};
