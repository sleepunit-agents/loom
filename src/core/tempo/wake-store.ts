import { and, eq, inArray } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { wakes } from '../data/schema.js';
import { WATCH_ENDED } from './wake.js';

export type Wake = typeof wakes.$inferSelect;
type NewWake = typeof wakes.$inferInsert;
export const activeWakes = inArray(wakes.state, ['waiting', 'delivering']);

export function insertWake(db: DataDatabase, wake: NewWake) {
  db.insert(wakes).values(wake).run();
}

export function changeWake(db: DataDatabase, wake: Wake, fields: Partial<NewWake>) {
  return db.update(wakes).set(fields).where(and(eq(wakes.id, wake.id), eq(wakes.state, wake.state), eq(wakes.attempt, wake.attempt))).run().changes > 0;
}

export function endWake(db: DataDatabase, wake: Wake, at: string, why: string) {
  changeWake(db, wake, { state: 'ended', endedAt: at, why,
    ...(why === WATCH_ENDED ? { key: '', condition: null, baseline: null, reading: null, note: null, newest: null } : {}) });
}

export function occurrence(wake: Pick<Wake, 'id' | 'attempt'>): string {
  return wake.attempt ? `${wake.id}:${wake.attempt}` : wake.id;
}

export function wakeForMail(db: DataDatabase, sourceId: string | null) {
  if (!sourceId) return;
  const wake = db.select().from(wakes).where(eq(wakes.id, sourceId.split(':')[0])).get();
  return wake && occurrence(wake) === sourceId ? wake : undefined;
}

/** Every active watch on a pull request holds the same accepted head watermark. */
export function newestWakeRead(db: DataDatabase, key: string) {
  return db.select({ newest: wakes.newest }).from(wakes).where(and(activeWakes, eq(wakes.kind, 'change'), eq(wakes.key, key))).get()?.newest ?? null;
}

export function recordNewestWakeRead(db: DataDatabase, key: string, newest: NonNullable<Wake['newest']>) {
  db.update(wakes).set({ newest }).where(and(activeWakes, eq(wakes.kind, 'change'), eq(wakes.key, key))).run();
}

export function activeConversationWakes(db: DataDatabase, conversation: string) {
  return db.select().from(wakes).where(and(eq(wakes.conversation, conversation), activeWakes)).all();
}
