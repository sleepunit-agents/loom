import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
/** Only for completed, inventory-verified backups; never for a live WAL database. */
export function openSnapshotSqlite(path: string): Database.Database {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') throw Error('Invalid SQLite snapshot');
  // A completed backup may retain WAL format; normalize only this private buffer.
  bytes[18] = 1; bytes[19] = 1;
  return new Database(bytes, { readonly: true });
}
