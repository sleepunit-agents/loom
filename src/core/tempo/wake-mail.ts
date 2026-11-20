import { asc, eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { agentModels, agentPauses, agentRunSettings, agents, deletedThreads, threads, type conversations } from '../data/schema.js';

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
