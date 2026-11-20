import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { inbox, jobs, wakes, threads } from '../data/schema.js';
import { wakeSource } from '../tempo/wake-sources.js';
import { isWakeMail, WAKE_CLOSED } from '../tempo/wake-mail.js';
import { activeConversationWakes, changeWake, endWake, occurrence, wakeForMail } from '../tempo/wake-store.js';

type Item = typeof inbox.$inferSelect;

export function withdrawWakeMail(db: DataDatabase, item: Pick<Item, 'id'>, at: string, why: string) {
  db.update(inbox).set({ state: 'resolved', words: null, resolution: why, changedAt: at }).where(eq(inbox.id, item.id)).run();
}

/** A closure or member action can remove a queued job's only input. A job
 * holding ordinary mail keeps its place in the queue. */
export function stopEmptyWakeJob(db: DataDatabase, job: string | null, at: string, why: string) {
  if (!job || db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.job, job), eq(inbox.state, 'waiting'))).get()) return;
  const stopped = db.update(jobs).set({ state: 'stopped', endedAt: at, endedNote: why })
    .where(and(eq(jobs.id, job), eq(jobs.state, 'queued'))).run();
  if (stopped.changes) wakeSource(db, { kind: 'job', id: job });
}

export function setAsideWakeMail(db: DataDatabase, item: Item, at: string, member: string) {
  const wake = isWakeMail(item) && wakeForMail(db, item.sourceId);
  if (!wake || wake.state !== 'delivering') return;
  const why = `The wake was set aside by ${member}.`;
  endWake(db, wake, at, why);
  withdrawWakeMail(db, item, at, why);
  stopEmptyWakeJob(db, item.job, at, why);
}

export function closeThreadWakes(db: DataDatabase, thread: typeof threads.$inferSelect, at: string, closed: 'archived' | 'deleted') {
  const why = `The wake could not be delivered because its conversation was ${closed}.`;
  const active = activeConversationWakes(db, thread.conversation);
  for (const wake of active) endWake(db, wake, at, wake.state === 'delivering' ? why : WAKE_CLOSED);
  for (const wake of active) {
    if (wake.state !== 'delivering') continue;
    const item = db.select().from(inbox).where(and(eq(inbox.conversation, thread.conversation), eq(inbox.source, 'notice'),
      eq(inbox.sourceId, occurrence(wake)))).get();
    if (!item || !isWakeMail(item)) continue;
    withdrawWakeMail(db, item, at, why);
    stopEmptyWakeJob(db, item.job, at, why);
  }
  // A running body may have taken its input before the close. Settle its
  // outstanding receipt so it cannot take the wake again after closure.
  for (const item of db.select().from(inbox).where(and(eq(inbox.thread, thread.id), eq(inbox.state, 'taken'))).all()) {
    if (isWakeMail(item)) withdrawWakeMail(db, item, at, WAKE_CLOSED);
  }
}

export function eraseThreadWakeWords(db: DataDatabase, thread: string) {
  for (const item of db.select().from(inbox).where(and(eq(inbox.thread, thread), eq(inbox.source, 'notice'))).all()) {
    if (isWakeMail(item)) db.update(inbox).set({ words: null }).where(eq(inbox.id, item.id)).run();
  }
  // The note and any prepared delivery text also belong to the deleted thread.
  for (const wake of db.select().from(wakes).innerJoin(threads, eq(wakes.conversation, threads.conversation))
    .where(eq(threads.id, thread)).all()) changeWake(db, wake.wakes, { note: null, reading: null, baseline: null });
}
