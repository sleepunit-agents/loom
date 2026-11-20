import type { DataDatabase } from './database.js';

const counters = new WeakMap<object, { get(): unknown }>();
/** SQLite's count of rows this connection has inserted, updated or deleted, also by statements later rolled
 * back. Two equal readings mean nothing was written between them; nothing else is learned from it. */
export function rowsWritten(db: DataDatabase): number {
  let counter = counters.get(db.$client);
  if (!counter) { counter = db.$client.prepare('SELECT total_changes()').pluck(); counters.set(db.$client, counter); }
  return counter.get() as number;
}
