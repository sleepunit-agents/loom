/** Offline backup prerequisite. No file discovery, IO, arming or public restore door. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { exportDatabase, sqliteExportRows, type SqliteRow } from './export.js';
import type { Db } from './index.js';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Row = Record<string, unknown>;
type ObjectSchema = { type: string; name: string; tbl_name: string; sql: string };
const schema = (db: Db) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as ObjectSchema[];
function value(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return ['blob', value.toString('base64')];
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'number') {
    // exportDatabase's public rows use JS numbers. Refuse loss rather than
    // publishing a rounded 64-bit integer as an apparently successful backup.
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw Error('Database export contains an unsupported number');
    return ['number', value];
  }
  return [typeof value, value];
}
const rowKey = (row: Row) => JSON.stringify(Object.keys(row).sort().map(key => [key, value(row[key])]));
function digest(rows: Row[], sqlite?: SqliteRow[]) {
  const hash = createHash('sha256');
  const keys = rows.map((row, i) => JSON.stringify([rowKey(row), sqlite ? JSON.stringify(sqlite[i], (_key,v) => typeof v === 'bigint' ? v.toString() : v) : null]));
  for (const row of keys.sort()) hash.update(String(Buffer.byteLength(row))).update(':').update(row);
  return hash.digest('hex');
}
function sequences(db: Db, names: Set<string>): Row[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) return [];
  return (db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').safeIntegers().all() as Row[]).filter(row => names.has(String(row.name)));
}
export interface DatabaseImage {
  /** Sensitive plaintext, for encryption by the owning backup worker only. */
  bytes: Buffer;
  tables: { name: string; rows: number; sha256: string }[];
  sha256: string;
}
/** Capture one committed view through the owning export filters, reconstruct a
 * fresh SQLite image, then independently reopen and compare every row/schema.
 * Never use SQLite backup/serialize on the source: its free pages and excluded
 * private rows must not leave the machine. Call outside request transactions.
 */
export function exportDatabaseImage(db: Db): DatabaseImage {
  if (db.inTransaction) throw Error('Database export requires an offline job');
  return db.transaction(() => {
    const tables = exportDatabase(db, true);
    const names = new Set(tables.map(table => table.name));
    const objects = schema(db).filter(object => names.has(object.tbl_name));
    // Views have no owning table and may expose excluded data. The current
    // next schema has none; refuse future views until their owner declares a
    // restore policy. Virtual tables likewise require their owning extension.
    if (schema(db).some(object => object.type === 'view') || tables.some(table => /^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql))) throw Error('Database export requires a schema-specific restore policy');
    const sequence = sequences(db, names);
    const expected = tables.map(table => ({ name: table.name, rows: table.rows.length, sha256: digest(table.rows as Row[], table.sqlite) }));
    const restored = new Database(':memory:');
    try {
      restored.pragma('foreign_keys = OFF');
      restored.transaction(() => {
        for (const table of tables) restored.exec(table.sql);
        for (const table of tables) {
          const columns = (restored.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all() as {name:string;hidden:number}[]).filter(column => column.hidden === 0).map(column => column.name);
          const withRowid = [...columns, ...(table.rowid ? [table.rowid] : [])];
          const insert = restored.prepare(`INSERT INTO ${quote(table.name)} (${withRowid.map(quote).join(',')}) VALUES (${withRowid.map(() => '?').join(',')})`);
          const visible = (restored.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all() as {name:string;hidden:number}[]).filter(column => column.hidden !== 1).map(column => column.name);
          for (const [i, row] of (table.rows as Row[]).entries()) {
            const values = columns.map(column => table.sqlite![i].types[visible.indexOf(column)] === 'integer' ? BigInt(row[column] as number) : row[column]);
            insert.run(...values, ...(table.rowid ? [table.sqlite![i].rowid] : []));
          }
        }
        if (sequence.length) {
          restored.exec('DELETE FROM sqlite_sequence');
          for (const row of sequence) restored.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(row.name, row.seq);
        }
        // Triggers are installed after data, so restoration cannot fire effects
        // or alter imported rows. Autoindexes are recreated by table DDL.
        for (const object of objects) if (object.type !== 'table') restored.exec(object.sql);
      })();
      const bytes = restored.serialize();
      const drill = new Database(bytes);
      try {
        if (drill.pragma('integrity_check', { simple: true }) !== 'ok' || (drill.pragma('foreign_key_check') as unknown[]).length) throw Error('Database export restore integrity failed');
        if (JSON.stringify(schema(drill)) !== JSON.stringify(objects)) throw Error('Database export restore schema differs');
        for (const table of expected) {
          const captured = sqliteExportRows(drill, table.name);
          if (captured.rows.length !== table.rows || digest(captured.rows, captured.sqlite) !== table.sha256) throw Error('Database export restore rows differ');
        }
        if (digest(sequences(drill, names)) !== digest(sequence)) throw Error('Database export restore sequences differ');
      } finally { drill.close(); }
      return { bytes, tables: expected, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally { restored.close(); }
  })();
}
