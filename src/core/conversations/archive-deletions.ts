import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { threads } from '../data/schema.js';

/** V1 commits the tombstone and removes the live thread in household.db before
 * cleaning up comms.db. A stopped archive can land between those commits. */
export function pendingThreadDeletions(household: Database.Database, destination: DataDatabase) {
  const pending = new Set<string>();
  if (!household.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='comms_delete_pending'").get()) return pending;
  const journal = household.prepare(`SELECT p.id, d.id AS tombstone, t.id AS live
    FROM comms_delete_pending p
    LEFT JOIN comms_deleted d ON d.id=p.id
    LEFT JOIN comms_threads t ON t.id=p.id`);
  for (const {id,tombstone,live} of journal.iterate() as Iterable<{id:string;tombstone:string|null;live:string|null}>) {
    if (!id || tombstone !== id || live !== null ||
      destination.select({id:threads.id}).from(threads).where(eq(threads.id,id)).get()) {
      throw Error('Pending thread deletion conflicts with a live or missing thread record');
    }
    pending.add(id);
  }
  return pending;
}
