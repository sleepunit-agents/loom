/** Launch-time run settings, read only from shared records. This is runner input,
 * not a household identity or an authorization decision. Unconfigured tiers stay
 * null; the runner must not invent an owner's trust from message words. */
import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentDeniedTools, agentPeople, bridgeConnections, bridgeIncoming, inbox, inboxRefs } from '../core/data/schema.js';
import type { WorkerRunPolicy } from './worker.js';

export function workerPolicy(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }): WorkerRunPolicy {
  const deniedTools = db.select({ pattern: agentDeniedTools.pattern, guestsOnly: agentDeniedTools.guestsOnly })
    .from(agentDeniedTools).where(eq(agentDeniedTools.agent, job.agent))
    .orderBy(asc(agentDeniedTools.pattern), asc(agentDeniedTools.guestsOnly)).all();
  const people = new Map<string, WorkerRunPolicy['people'][number]>();
  if (job.conversation) {
    const items = db.select({ id: inbox.id, source: inbox.source, fromKind: inbox.fromKind, fromId: inbox.fromId })
      .from(inbox).where(and(eq(inbox.conversation, job.conversation), eq(inbox.toKind, 'agent'), eq(inbox.to, job.agent),
        inArray(inbox.source, ['discord', 'slack']),
        or(eq(inbox.job, job.id), and(isNull(inbox.job), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))))).all();
    for (const item of items) {
      if (item.fromKind === 'agent') continue;
      let kind: 'person' | 'outside' | 'unknown' = 'unknown', person: string | null = null;
      if (item.fromKind === 'person' && item.fromId) { kind = 'person'; person = item.fromId; }
      else if (item.fromKind === 'unknown') {
        // A canonical outside key comes from the stored bridge event, never
        // from words or a claimed household identity. Ambiguity stays unknown.
        const receipts = db.select({ platform: bridgeConnections.platform, workspace: bridgeConnections.workspace, user: bridgeIncoming.user })
          .from(inboxRefs).innerJoin(bridgeIncoming, eq(inboxRefs.ref, bridgeIncoming.id))
          .innerJoin(bridgeConnections, eq(bridgeIncoming.connection, bridgeConnections.id))
          .where(and(eq(inboxRefs.item, item.id), eq(bridgeIncoming.conversation, job.conversation),
            eq(bridgeIncoming.state, 'delivered'), isNull(bridgeIncoming.member),
            eq(bridgeConnections.agent, job.agent), eq(bridgeConnections.platform, item.source as 'discord' | 'slack'))).all();
        const keys = new Set(receipts.map(row => JSON.stringify([row.platform, row.workspace, row.user])));
        if (keys.size === 1) { kind = 'outside'; person = [...keys][0]; }
      }
      const tier = person === null ? null : db.select({ tier: agentPeople.tier }).from(agentPeople)
        .where(and(eq(agentPeople.agent, job.agent), eq(agentPeople.person, person))).get()?.tier ?? null;
      people.set(JSON.stringify([kind, person]), { kind, person, tier });
    }
  }
  return { deniedTools, people: [...people.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value) };
}
