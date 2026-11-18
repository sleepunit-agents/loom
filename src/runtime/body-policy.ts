/** Launch-time run settings, read only from shared records. This is runner input,
 * not a household identity or an authorization decision. Unconfigured tiers stay
 * null; the runner must not invent an owner's trust from message words. */
import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentDeniedTools, agentPeople, bridgeIncoming, inbox, inboxRefs } from '../core/data/schema.js';
import { incomingId, outsidePersonKey, parseInboxSourceId } from '../pieces/bridges/keys.js';
import { inHousehold } from '../policy.js';
import { sharedSharing } from '../shared-sharing.js';
import { waitsForNextJob } from '../core/conversations/index.js';
import type { WorkerRunPolicy } from './worker.js';

/** Who is in a job's room, read from its mail. The mail is what the job is offered and nothing more
 * (core/conversations, pending): what admission marked for it, and what a person wrote since, unless that
 * would make the job's word anybody else's (`joins`; shared-place-mail.ts gives it, lateMailJoins). `only`
 * reads the room of those waiting items alone, with none of the job's own: the room one late message would bring. */
export function workerPolicy(db: DataDatabase, job: { id: string; agent: string; conversation: string | null },
  joins: (item: { id: string }) => boolean = () => true, only?: readonly string[]): WorkerRunPolicy {
  const deniedTools = db.select({ pattern: agentDeniedTools.pattern, guestsOnly: agentDeniedTools.guestsOnly })
    .from(agentDeniedTools).where(eq(agentDeniedTools.agent, job.agent))
    .orderBy(asc(agentDeniedTools.pattern), asc(agentDeniedTools.guestsOnly)).all();
  const people = new Map<string, WorkerRunPolicy['people'][number]>();
  const found = db.select({ id: inbox.id, job: inbox.job, conversation: inbox.conversation, source: inbox.source, sourceId: inbox.sourceId, fromKind: inbox.fromKind, fromId: inbox.fromId, onWordKind: inbox.onWordKind, onWord: inbox.onWord })
    .from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.to, job.agent),
      or(eq(inbox.job, job.id), job.conversation ? and(eq(inbox.conversation, job.conversation), isNull(inbox.job), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute')) : undefined))).all();
  // A job nothing is marked for was not started by admission, and is offered everything that waits.
  const admitted = found.some(item => item.job === job.id);
  const items = only ? found.filter(item => item.job !== job.id && only.includes(item.id))
    : found.filter(item => item.job === job.id || !admitted || (!waitsForNextJob(item) && joins(item)));
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
    // Mail sent on somebody's word (a trigger's firing in a shared place, a note from another body) brings that
    // person into the room as they stand now: a member while in the household, an outside account at the
    // tier it has now, and otherwise somebody nobody vouches for.
    if (item.onWordKind && item.onWord) {
      const on = item.onWordKind === 'member'
        ? (inHousehold({ kind: 'member', id: item.onWord }, sharing) ? { kind: 'person' as const, person: item.onWord, tier: null } : { kind: 'unknown' as const, person: null, tier: null })
        : { kind: 'outside' as const, person: item.onWord, tier: tierOf(item.onWord) };
      people.set(JSON.stringify([on.kind, on.person]), on);
    }
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
