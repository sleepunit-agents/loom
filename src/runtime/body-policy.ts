/** Launch-time run settings, read only from shared records. This is runner input,
 * not a household identity or an authorization decision. Unconfigured tiers stay
 * null; the runner must not invent an owner's trust from message words. */
import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentDeniedTools, agentPeople, bridgeIncoming, inbox, inboxRefs } from '../core/data/schema.js';
import { incomingId, outsidePersonKey, parseInboxSourceId } from '../pieces/bridges/keys.js';
import { inHousehold } from '../policy.js';
import { sharedSharing } from '../shared-sharing.js';
import type { WorkerRunPolicy } from './worker.js';

export function workerPolicy(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }): WorkerRunPolicy {
  const deniedTools = db.select({ pattern: agentDeniedTools.pattern, guestsOnly: agentDeniedTools.guestsOnly })
    .from(agentDeniedTools).where(eq(agentDeniedTools.agent, job.agent))
    .orderBy(asc(agentDeniedTools.pattern), asc(agentDeniedTools.guestsOnly)).all();
  const people = new Map<string, WorkerRunPolicy['people'][number]>();
  const items = db.select({ id: inbox.id, conversation: inbox.conversation, source: inbox.source, sourceId: inbox.sourceId, fromKind: inbox.fromKind, fromId: inbox.fromId })
    .from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.to, job.agent),
      or(eq(inbox.job, job.id), job.conversation ? and(eq(inbox.conversation, job.conversation), isNull(inbox.job), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute')) : undefined))).all();
  type Tier = WorkerRunPolicy['people'][number]['tier'];
  const tierOf = (person: string) => (db.select({ tier: agentPeople.tier }).from(agentPeople)
    .where(and(eq(agentPeople.agent, job.agent), eq(agentPeople.person, person))).get()?.tier ?? null) as Tier;
  /** The outside key of whoever sent a bridge item, read from the stored bridge event it was delivered from,
   * never from words or a claimed identity. `member` is the household member the event was filed under
   * (null: nobody). More than one key, or none, names nobody. */
  const outsideKey = (item: typeof items[number], member: string | null): string | null => {
    if (!item.conversation || (item.source !== 'discord' && item.source !== 'slack')) return null;
    const source = parseInboxSourceId(item.sourceId);
    if (!source) return null;
    // Connection settings may have been retargeted after this delivery.
    // source/sourceId belong to the original authenticated inbox receipt.
    const receipts = db.select({ id: bridgeIncoming.id, connection: bridgeIncoming.connection, user: bridgeIncoming.user })
      .from(inboxRefs).innerJoin(bridgeIncoming, eq(inboxRefs.ref, bridgeIncoming.id))
      .where(and(eq(inboxRefs.item, item.id), eq(bridgeIncoming.conversation, item.conversation),
        eq(bridgeIncoming.state, 'delivered'), member === null ? isNull(bridgeIncoming.member) : eq(bridgeIncoming.member, member), eq(bridgeIncoming.channel, source.channel))).all()
      .filter(row => row.id === incomingId(row.connection, source.message));
    const keys = new Set(receipts.map(row => outsidePersonKey(item.source as 'discord' | 'slack', source.workspace, row.user)));
    return keys.size === 1 ? [...keys][0] : null;
  };
  const sharing = sharedSharing(db);
  for (const item of items) {
    if (item.fromKind !== 'person' && item.fromKind !== 'unknown') continue;
    let kind: 'person' | 'outside' | 'unknown' = 'unknown', person: string | null = null, tier: Tier = null;
    // The item says who sent it when it arrived. Whether that member is in the household is asked now
    // (policy.ts): mail from a member removed since is mail from outside, under the account it came from.
    const member = item.fromKind === 'person' ? item.fromId : null;
    if (member && inHousehold({ kind: 'member', id: member }, sharing)) {
      kind = 'person'; person = member;
      // A tier is saved under a person's outside key and under nothing else (shared-agent-body-policy.ts).
      // Linking that person to a member changes who their messages are from, not the tier the owner gave
      // them, so the tier is still looked up by the outside account the message came from.
      const outside = outsideKey(item, member);
      tier = outside === null ? null : tierOf(outside);
    } else {
      const outside = outsideKey(item, member);
      if (outside !== null) { kind = 'outside'; person = outside; tier = tierOf(outside); }
    }
    people.set(JSON.stringify([kind, person]), { kind, person, tier });
  }
  return { deniedTools, people: [...people.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value), mail: items.map(item => item.id).sort() };
}
