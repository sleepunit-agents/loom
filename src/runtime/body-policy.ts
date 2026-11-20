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

/** A job's mail, read once: what admission marked for it, what has come to its conversation since, and the
 * room any part of it brings. Everything that asks who is in a job's room goes through here, so the mail is
 * read once per question however much of it waits. */
export interface JobMail {
  /** Whether admission marked any mail for the job. A job nothing is marked for was not started by
   * admission (only tests make one), and is offered everything that waits. */
  admitted: boolean;
  /** The mail admission marked for the job. */
  marked: readonly string[];
  /** Mail waiting in the job's conversation that no job is marked for: what came after admission. `waits`
   * is whether it never joins a running job, by what it is (core/conversations, waitsForNextJob). */
  late: readonly { id: string; waits: boolean }[];
  /** The room these pieces of mail bring, and no other: who each is from, and on whose word it was sent. */
  room(ids: readonly string[]): WorkerRunPolicy;
}
/** Who is in a job's room when every person's message that came since admission joins it: the widest room
 * the job could be offered. loom's own answer leaves out a message somebody else wrote than the job's asker
 * (shared-place-mail.ts, jobRoom); this is the room without that rule, for what asks who has written. */
export function workerPolicy(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }): WorkerRunPolicy {
  const mail = jobMail(db, job);
  return mail.room([...mail.marked, ...mail.late.filter(item => !mail.admitted || !item.waits).map(item => item.id)]);
}
export function jobMail(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }): JobMail {
  const found = db.select(mailColumns)
    .from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.to, job.agent),
      or(eq(inbox.job, job.id), job.conversation ? and(eq(inbox.conversation, job.conversation), isNull(inbox.job), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute')) : undefined))).all();
  const marked = found.filter(item => item.job === job.id);
  return {
    admitted: marked.length > 0, marked: marked.map(item => item.id),
    late: found.filter(item => item.job !== job.id).map(item => ({ id: item.id, waits: waitsForNextJob(item) })),
    room: rooms(db, job.agent, found),
  };
}
/** The room any of a conversation's waiting mail brings, whichever job it was last marked for: what admission
 * asks before a job is formed, to say whose word each piece is on (shared-place-mail.ts, askers). */
export function waitingMail(db: DataDatabase, cv: { agent: string; conversation: string }): Pick<JobMail, 'room'> {
  return { room: rooms(db, cv.agent, db.select(mailColumns).from(inbox)
    .where(and(eq(inbox.toKind, 'agent'), eq(inbox.to, cv.agent), eq(inbox.conversation, cv.conversation), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))).all()) };
}
const mailColumns = { id: inbox.id, job: inbox.job, conversation: inbox.conversation, source: inbox.source, sourceId: inbox.sourceId, fromKind: inbox.fromKind, fromId: inbox.fromId, onWordKind: inbox.onWordKind, onWord: inbox.onWord };
type Found = Pick<typeof inbox.$inferSelect, keyof typeof mailColumns>;
/** The room these pieces of mail bring: who each is from and on whose word it was sent, each looked up once. */
function rooms(db: DataDatabase, agent: string, found: readonly Found[]): JobMail['room'] {
  const job = { agent };
  const deniedTools = db.select({ pattern: agentDeniedTools.pattern, guestsOnly: agentDeniedTools.guestsOnly })
    .from(agentDeniedTools).where(eq(agentDeniedTools.agent, job.agent))
    .orderBy(asc(agentDeniedTools.pattern), asc(agentDeniedTools.guestsOnly)).all();
  type Entry = [string, WorkerRunPolicy['people'][number]];
  type Tier = WorkerRunPolicy['people'][number]['tier'];
  const tierOf = (person: string) => (db.select({ tier: agentPeople.tier }).from(agentPeople)
    .where(and(eq(agentPeople.agent, job.agent), eq(agentPeople.person, person))).get()?.tier ?? null) as Tier;
  /** The outside key of whoever sent a bridge item, read from the stored bridge event it was delivered from,
   * never from words or a claimed identity. `member` is the household member the event was filed under
   * (null: nobody). More than one key, or none, names nobody. */
  const outsideKey = (item: Found, member: string | null): string | null => {
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
  /** The people one piece of mail brings, looked up once however often its room is asked for. */
  const brought = new Map<string, Entry[]>();
  const bringers = (item: Found): Entry[] => {
    const known = brought.get(item.id); if (known) return known;
    const entries: Entry[] = []; brought.set(item.id, entries);
    // Mail sent on somebody's word (a trigger's firing in a shared place, a note from another body) brings that
    // person into the room as they stand now: a member while in the household, an outside account at the
    // tier it has now, and otherwise somebody nobody vouches for.
    if (item.onWordKind && item.onWord) {
      const on = item.onWordKind === 'member'
        ? (inHousehold({ kind: 'member', id: item.onWord }, sharing) ? { kind: 'person' as const, person: item.onWord, tier: null } : { kind: 'unknown' as const, person: null, tier: null })
        : { kind: 'outside' as const, person: item.onWord, tier: tierOf(item.onWord) };
      entries.push([JSON.stringify([on.kind, on.person]), on]);
    }
    if (item.fromKind !== 'person' && item.fromKind !== 'unknown') return entries;
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
    entries.push([JSON.stringify([kind, person]), { kind, person, tier }]);
    return entries;
  };
  return ids => {
    const wanted = new Set(ids), people = new Map<string, WorkerRunPolicy['people'][number]>(), mail: string[] = [];
    // In the order the mail was read, so a person two pieces bring is the later one's reading, as before.
    for (const item of found) if (wanted.has(item.id)) { mail.push(item.id); for (const [key, value] of bringers(item)) people.set(key, value); }
    return { deniedTools, people: [...people.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value), mail: mail.sort() };
  };
}
