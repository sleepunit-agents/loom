/** Launch-time run settings, read only from shared records. This is runner input,
 * not a household identity or an authorization decision. Unconfigured tiers stay
 * null; the runner must not invent an owner's trust from message words. */
import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentDeniedTools, agentPeople, bridgeIncoming, inbox, inboxRefs } from '../core/data/schema.js';
import type { WorkerRunPolicy } from './worker.js';

function bridgeSource(value: string | null): [string, string, string] | undefined {
  try {
    const fields: unknown = JSON.parse(value ?? 'null');
    if (Array.isArray(fields) && fields.length === 3 && fields.every(field => typeof field === 'string' && field.length > 0))
      return fields as [string, string, string];
  } catch { /* An invalid stored source cannot establish an outside key. */ }
}

export function workerPolicy(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }): WorkerRunPolicy {
  const deniedTools = db.select({ pattern: agentDeniedTools.pattern, guestsOnly: agentDeniedTools.guestsOnly })
    .from(agentDeniedTools).where(eq(agentDeniedTools.agent, job.agent))
    .orderBy(asc(agentDeniedTools.pattern), asc(agentDeniedTools.guestsOnly)).all();
  const people = new Map<string, WorkerRunPolicy['people'][number]>();
  const items = db.select({ id: inbox.id, conversation: inbox.conversation, source: inbox.source, sourceId: inbox.sourceId, fromKind: inbox.fromKind, fromId: inbox.fromId })
    .from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.to, job.agent),
      or(eq(inbox.job, job.id), job.conversation ? and(eq(inbox.conversation, job.conversation), isNull(inbox.job), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute')) : undefined))).all();
  for (const item of items) {
    if (item.fromKind !== 'person' && item.fromKind !== 'unknown') continue;
    let kind: 'person' | 'outside' | 'unknown' = 'unknown', person: string | null = null;
    if (item.fromKind === 'person' && item.fromId) { kind = 'person'; person = item.fromId; }
    else if (item.fromKind === 'unknown' && item.conversation && (item.source === 'discord' || item.source === 'slack')) {
      // A canonical outside key comes from the stored bridge event, never
      // from words or a claimed household identity. Ambiguity stays unknown.
      const source = bridgeSource(item.sourceId);
      // Connection settings may have been retargeted after this delivery.
      // source/sourceId belong to the original authenticated inbox receipt.
      const receipts = source ? db.select({ id: bridgeIncoming.id, connection: bridgeIncoming.connection, user: bridgeIncoming.user })
        .from(inboxRefs).innerJoin(bridgeIncoming, eq(inboxRefs.ref, bridgeIncoming.id))
        .where(and(eq(inboxRefs.item, item.id), eq(bridgeIncoming.conversation, item.conversation),
          eq(bridgeIncoming.state, 'delivered'), isNull(bridgeIncoming.member), eq(bridgeIncoming.channel, source[1]))).all()
          .filter(row => row.id === `bi:${JSON.stringify([row.connection, source[2]])}`) : [];
      const keys = new Set(receipts.map(row => JSON.stringify([item.source, source![0], row.user])));
      if (keys.size === 1) { kind = 'outside'; person = [...keys][0]; }
    }
    const tier = person === null ? null : db.select({ tier: agentPeople.tier }).from(agentPeople)
      .where(and(eq(agentPeople.agent, job.agent), eq(agentPeople.person, person))).get()?.tier ?? null;
    people.set(JSON.stringify([kind, person]), { kind, person, tier });
  }
  return { deniedTools, people: [...people.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value) };
}
