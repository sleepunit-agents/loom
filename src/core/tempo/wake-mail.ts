import { WATCH_ENDED } from './wake.js';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { agentModels, agentPauses, agentRunSettings, agents, deletedThreads, inbox, threads, wakes, type conversations } from '../data/schema.js';

export const WAKE_CLOSED = 'The watch ended because its conversation closed.';

export function isWakeMail(item: { source: string; fromKind: string; sourceId: string | null }): boolean {
  return item.source === 'notice' && item.fromKind === 'schedule' && !!item.sourceId?.startsWith('wake-');
}

export function wakeThread(db: DataDatabase, conversation: string) {
  return db.select().from(threads).where(eq(threads.conversation, conversation)).get();
}

export function wakeConversationClosed(db: DataDatabase, cv: typeof conversations.$inferSelect): boolean {
  return cv.venue !== 'loom' || !!wakeThread(db, cv.id)?.archivedAt
    || !!db.select({ id: deletedThreads.id }).from(deletedThreads).where(eq(deletedThreads.conversation, cv.id)).get();
}

export function workSetup(db: DataDatabase, agent: string) {
  return {
    removed: !!db.select({ removedAt: agents.removedAt }).from(agents).where(eq(agents.id, agent)).get()?.removedAt,
    settings: db.select().from(agentRunSettings).where(eq(agentRunSettings.agent, agent)).get(),
    model: db.select().from(agentModels).where(eq(agentModels.agent, agent)).orderBy(asc(agentModels.position), asc(agentModels.model)).get(),
  };
}

export function wakeBlocked(db: DataDatabase, agent: string, setup = workSetup(db, agent)): string | undefined {
  if (setup.removed) return 'the agent has been removed';
  if (!setup.settings) return 'the agent has no run settings';
  if (!setup.model?.model) return 'the agent has no model to run on';
  if (db.select({ agent: agentPauses.agent }).from(agentPauses).where(eq(agentPauses.agent, agent)).get()) return 'the agent is paused';
}

export function settleWakeMail(db: DataDatabase, item: Pick<typeof inbox.$inferSelect, 'id' | 'sourceId'>, at: string, why: string) {
  db.update(inbox).set({ state: 'resolved', words: null, resolution: why, changedAt: at }).where(eq(inbox.id, item.id)).run();
  if (item.sourceId) db.update(wakes).set({ state: 'ended', endedAt: at, why, ...(why === WATCH_ENDED ? { key: '', condition: null, baseline: null, reading: null, note: null } : {}) })
    .where(and(eq(wakes.id, item.sourceId), eq(wakes.state, 'fired'))).run();
}

export function closeThreadWakes(db: DataDatabase, thread: typeof threads.$inferSelect, at: string) {
  for (const item of db.select().from(inbox).where(and(eq(inbox.thread, thread.id), eq(inbox.source, 'notice'),
    inArray(inbox.state, ['waiting', 'taken']), isNull(inbox.job))).all()) {
    if (isWakeMail(item)) settleWakeMail(db, item, at, WAKE_CLOSED);
  }
  db.update(wakes).set({ state: 'ended', endedAt: at, why: WAKE_CLOSED })
    .where(and(eq(wakes.conversation, thread.conversation), eq(wakes.state, 'waiting'))).run();
}
