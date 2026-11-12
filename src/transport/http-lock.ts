import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Lifetime OS lock: never unlink its database; process death releases ownership. */
export function acquireHttpLock(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, 'http-daemon-lock.db'), { timeout: 0 });
  try { db.exec('BEGIN EXCLUSIVE'); }
  catch (error) {
    db.close();
    if (String((error as { code?: string }).code).startsWith('SQLITE_BUSY')) {
      throw new Error(`loom HTTP daemon already running for ${home}; stop it before starting another`);
    }
    throw error;
  }
  return () => { if (db.open) db.close(); };
}
