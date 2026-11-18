/** Mail that starts work in a named bridge conversation without a message from the bridge: a trigger's
 * firing there (core/tempo) and a note one body of an agent hands to its body in another conversation
 * (core/conversations/handoff.ts). What both need is said here once: where such a conversation is posted
 * to, whether it still can be, who a job is working on the word of, and whether that person is still
 * known. Who may do what with it is policy.ts's (maySchedule, mayHandTo). */
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import { agentPeople, agents, bridgeChannelFilters, bridgeChannels, bridgeConnections, bridgeIncoming, conversations, inbox } from './core/data/schema.js';
import { inHousehold, isHouseholdOwner, mayHandTo, membersWithAgent, type Asker, type OnWord, type Woke } from './policy.js';
import { householdOwners, sharedSharing } from './shared-sharing.js';
import { OperationError } from './core/operations/index.js';
import type { HandoffToSelf } from './core/conversations/handoff.js';
import { conversationPlace } from './pieces/bridges/place.js';
import { workerPolicy } from './runtime/body-policy.js';

/** The most triggers that may stand at once naming one conversation. */
export const PLACE_TRIGGERS_MAX = 10;
/** The least time between two firings of a repeating trigger set from a shared place. */
export const SHARED_PLACE_REPEAT_MIN_MS = 3_600_000;
/** A chain of hand-offs this long, and each further one this long, is told to the household's owners. It refuses nothing. */
export const CHAIN_NOTICE_EVERY = 25;

type Place = { id: string; agent: string; venue: string; place: string };
export type { OnWord };
export const isBridgeVenue = (venue: string): venue is 'discord' | 'slack' => venue === 'discord' || venue === 'slack';

/** Where a post in this conversation goes: read from its place (pieces/bridges/place.ts), on the agent's
 * connection to that workspace. Nothing for a conversation that is not a bridge's or has no connection. */
export function placeAddress(db: DataDatabase, cv: Place): { connection: string; workspace: string; channel: string; thread: string | null; direct: boolean } | undefined {
  if (!isBridgeVenue(cv.venue)) return undefined;
  let place: unknown; try { place = JSON.parse(cv.place); } catch { return undefined; }
  if (!Array.isArray(place) || typeof place[0] !== 'string' || typeof place[1] !== 'string' || (place[2] !== null && typeof place[2] !== 'string')) return undefined;
  const connection = db.select({ id: bridgeConnections.id }).from(bridgeConnections)
    .where(and(eq(bridgeConnections.platform, cv.venue), eq(bridgeConnections.agent, cv.agent), eq(bridgeConnections.workspace, place[0]), isNull(bridgeConnections.removedAt))).get();
  return connection ? { connection: connection.id, workspace: place[0], channel: place[1], thread: place[2], direct: place.length > 3 } : undefined;
}
/** Why nothing can be posted to this conversation now, by the rules a message arriving there is admitted
 * by (pieces/bridges/incoming.ts): its connection is gone or not in use, or its channel is filtered out. A
 * channel rule that was removed closes nothing: a mention there would still wake the agent. */
export function placeClosed(db: DataDatabase, cv: Place): string | undefined {
  const found = placeAddress(db, cv), at = found && { ...found, channel: ruleChannel(db, cv, found.channel) };
  if (!at) return 'its connection is gone';
  if (!db.select({ enabled: bridgeConnections.enabled }).from(bridgeConnections).where(eq(bridgeConnections.id, at.connection)).get()?.enabled) return 'its connection is not in use';
  const filters = db.select().from(bridgeChannelFilters).where(eq(bridgeChannelFilters.connection, at.connection)).all();
  if (filters.some(f => f.rule === 'ignore' && f.channel === at.channel) || (!at.direct && filters.some(f => f.rule === 'only') && !filters.some(f => f.rule === 'only' && f.channel === at.channel))) return 'its channel is filtered out';
  return undefined;
}
/** The channel a conversation's rules are looked up by: a channel rule, a filter and a report target name
 * a channel, and a Discord thread is under one. Admission reads the parent from the arriving message
 * (pieces/bridges/incoming.ts, `parent ?? channel`); a conversation's own messages say the same, so the
 * latest one is asked, and a conversation nobody has spoken in is its place's channel. The one lookup
 * for every rule about a place: placeClosed, reportsTo and a note's target. */
export function ruleChannel(db: DataDatabase, cv: { id: string }, placeChannel: string): string {
  const said = cv.id ? db.select({ channel: bridgeIncoming.channel, parent: bridgeIncoming.parent }).from(bridgeIncoming).where(eq(bridgeIncoming.conversation, cv.id)).orderBy(desc(bridgeIncoming.receivedAt)).get() : undefined;
  return said ? said.parent ?? said.channel : placeChannel;
}
/** Whether this person is still known to the household for this agent: a member in the household now, an
 * outside account the agent's owner has given a tier, or the agent itself while it is not removed. By
 * the person and not by the venue: the same answer wherever the conversation is. */
export function stillKnown(db: DataDatabase, agent: string, who: Asker): boolean {
  if (who.kind === 'member') return inHousehold({ kind: 'member', id: who.id }, sharedSharing(db));
  if (who.kind === 'agent') return who.id === agent && !db.select({ removedAt: agents.removedAt }).from(agents).where(eq(agents.id, agent)).get()?.removedAt;
  return !!db.select({ tier: agentPeople.tier }).from(agentPeople).where(and(eq(agentPeople.agent, agent), eq(agentPeople.person, who.id))).get();
}
/** On whose word a job is working, read from its mail as the worker reads who is in the room
 * (runtime/body-policy.ts): every person its mail is from, or was sent on the word of, and the member a
 * private conversation is with. Least reach wins: it is `owners` only if every one of them is a
 * household owner or a member who has the agent; one other person makes it `others`. `person` is the one
 * of least reach, for what is done on this job's word later: a guest before a member, a member before an owner.
 *
 * What counts as the agent's own work, said once: a job with nobody behind any of its mail, which is a
 * lane's own start and a firing whose asker is the agent itself (mail from the schedule, on nobody's
 * word, in a conversation that is no member's). Mail from an agent is never that: a note carries the
 * word of the body that sent it, and one with no word (a body nobody could be named behind, another
 * agent's bot writing in a channel) is anybody else's. */
export function jobWord(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }): { woke: Woke; person?: OnWord } {
  const policy = workerPolicy(db, job), sharing = sharedSharing(db), have = new Set(membersWithAgent(job.agent, sharing));
  const people = [...policy.people];
  const member = job.conversation ? db.select({ member: conversations.member }).from(conversations).where(eq(conversations.id, job.conversation)).get()?.member : null;
  if (member) people.push(inHousehold({ kind: 'member', id: member }, sharing) ? { kind: 'person', person: member, tier: null } : { kind: 'unknown', person: null, tier: null });
  const mail = policy.mail ?? [];
  const unspoken = mail.length > 0 && db.select({ id: inbox.id }).from(inbox).where(and(inArray(inbox.id, mail), eq(inbox.fromKind, 'agent'), isNull(inbox.onWord))).all().length > 0;
  if (unspoken) return { woke: 'others' };
  if (!people.length) return { woke: 'own' };
  const rank = (p: typeof people[number]) => p.kind === 'unknown' || p.person === null ? 0 : p.kind === 'outside' ? (p.tier === 3 ? 2 : 1)
    : isHouseholdOwner({ kind: 'member', id: p.person }, sharing) ? 5 : have.has(p.person) ? 4 : 3;
  const least = [...people].sort((a, b) => rank(a) - rank(b))[0], lowest = rank(least);
  // Somebody nobody can name is behind it: nothing is done on such a word.
  if (lowest === 0 || least.person === null) return { woke: 'others' };
  return { woke: lowest >= 4 ? 'owners' : 'others', person: { kind: least.kind === 'person' ? 'member' : 'outside', id: least.person } };
}
/** The chain a note from this job continues: that of the note its job took, if it took one; and otherwise,
 * when the note goes back to a conversation the last note here came through, that note's: the answer a
 * person gave in between is part of the same exchange. */
export function jobChain(db: DataDatabase, job: { id: string; conversation: string | null }, target?: string): { chain: string[]; startedAt: string } | undefined {
  if (!job.conversation) return undefined;
  const notes = db.select({ job: inbox.job, chain: inbox.chain, startedAt: inbox.chainStartedAt }).from(inbox)
    .where(and(eq(inbox.conversation, job.conversation), eq(inbox.source, 'handoff'), isNotNull(inbox.chain))).orderBy(desc(inbox.seq)).all()
    .map(item => ({ job: item.job, chain: JSON.parse(item.chain!) as string[], startedAt: item.startedAt! }));
  return notes.find(note => note.job === job.id) ?? (target !== undefined && notes[0]?.chain.includes(target) ? notes[0] : undefined);
}
/** The channel a body working in this conversation for a guest may hand a note to (the channel rule's `reportsTo`), if any. */
export function reportsTo(db: DataDatabase, cv: Place): string | null {
  const at = placeAddress(db, cv);
  if (!at || at.direct || !isBridgeVenue(cv.venue)) return null;
  return db.select({ reportsTo: bridgeChannels.reportsTo }).from(bridgeChannels)
    .where(and(eq(bridgeChannels.platform, cv.venue), eq(bridgeChannels.workspace, at.workspace), eq(bridgeChannels.channel, ruleChannel(db, cv, at.channel)))).get()?.reportsTo ?? null;
}
/** A person as a body is told of them: by what kind they are and the id loom knows them by. */
export const named = (who: { kind: string; id: string }): string => who.kind === 'member' ? `the member ${who.id}` : who.kind === 'agent' ? 'yourself' : `the outside account ${who.id}`;

/** Whether the agent has a channel rule for this channel: it is who answers there. */
export const ruled = (db: DataDatabase, agent: string, at: { platform: 'discord' | 'slack'; workspace: string; channel: string }): boolean =>
  !!db.select({ answers: bridgeChannels.answers }).from(bridgeChannels).where(and(eq(bridgeChannels.platform, at.platform), eq(bridgeChannels.workspace, at.workspace), eq(bridgeChannels.channel, at.channel), eq(bridgeChannels.answers, agent))).get();
/** A channel as a channel rule's `reportsTo` names it, and as a target is compared with it. */
export const channelKey = (platform: string, workspace: string, channel: string): string => JSON.stringify([platform, workspace, channel]);
/** A note from one body of an agent to its body in another conversation: the composition's half of
 * `conversation.handoff` with `to`. The mail it writes starts the target conversation's job like any
 * message; that body, with its own context, says what there is to say in its own words. */
export function selfHandoff(db: DataDatabase, mail: { send(input: { toKind: 'person'; to: string; member: string; source: 'notice'; sourceId: string; fromKind: 'unknown'; words: string; refs: string[] }): unknown }, now: () => string): HandoffToSelf {
  return {
    word: work => jobWord(db, work.job).person,
    target(work, to) {
      const agent = work.cv.agent;
      let conversation: string | undefined, open: { venue: 'discord' | 'slack'; place: string; label: string } | undefined, key: string, where: string;
      if ('conversation' in to) {
        const cv = db.select().from(conversations).where(eq(conversations.id, to.conversation)).get(), at = cv && cv.agent === agent ? placeAddress(db, cv) : undefined;
        if (!cv || !at || cv.id === work.cv.id) throw new OperationError('invalid', 'A note goes to another Discord or Slack conversation of this agent');
        const closed = placeClosed(db, cv); if (closed) throw new OperationError('invalid', `Nothing can be posted there: ${closed}`);
        conversation = cv.id; key = channelKey(cv.venue, at.workspace, ruleChannel(db, cv, at.channel)); where = `${cv.venue} ${at.direct ? 'direct conversation' : `channel ${at.channel}`}`;
      } else {
        // A channel the agent has a rule for; the conversation there is found, or opened.
        // (Or the one channel its own channel's rule says it reports to: the owner named it there.)
        if (!ruled(db, agent, to) && channelKey(to.platform, to.workspace, to.channel) !== reportsTo(db, work.cv))
          throw new OperationError('invalid', 'A note goes to a channel this agent has a rule for');
        const place = conversationPlace(to.workspace, { channel: to.channel, thread: to.thread ?? null, isDm: false }, null);
        const cv = db.select().from(conversations).where(and(eq(conversations.agent, agent), eq(conversations.venue, to.platform), eq(conversations.place, place))).get();
        const closed = placeClosed(db, cv ?? { id: '', agent, venue: to.platform, place }); if (closed) throw new OperationError('invalid', `Nothing can be posted there: ${closed}`);
        if (cv?.id === work.cv.id) throw new OperationError('invalid', 'A note goes to another conversation');
        conversation = cv?.id; if (!cv) open = { venue: to.platform, place, label: to.thread ?? to.channel };
        key = channelKey(to.platform, to.workspace, to.channel); where = `${to.platform} channel ${to.channel}`;
      }
      const word = jobWord(db, work.job);
      if (!mayHandTo(word.woke, key, reportsTo(db, work.cv)) || (word.woke === 'others' && !word.person))
        throw new OperationError('denied', 'This body may hand a note only to the channel its own channel reports to, and its channel names none or another');
      const before = jobChain(db, work.job, conversation), chain = before?.chain ?? [], from = placeAddress(db, work.cv);
      const origin = from ? `${work.cv.venue} ${from.direct ? 'direct conversation' : `channel ${from.channel}`}` : `its own work (${work.cv.venue})`;
      return { conversation, open, chain, startedAt: before?.startedAt ?? now(), ...(word.person ? { onWord: word.person } : {}),
        told: `[A note from another body of yours, not a person speaking. It was working in ${origin} (conversation ${work.cv.id})${word.person ? `, for ${named(word.person)}` : ', on your own work'}. `
          + `Saying what needs saying here, in ${where}, in your own words, is your job. To answer that body, hand a note back to conversation ${work.cv.id}. `
          + `Hand-offs before this one in this exchange: ${chain.length}${chain.length ? ` (through conversations ${chain.join(', ')})` : ''}. If this exchange is no longer making progress, stop and say so to a person instead of handing on.]` };
    },
    sent(note) {
      // Loud, not a stop: the household's owners are told once each time a chain grows by CHAIN_NOTICE_EVERY.
      if (note.chain.length % CHAIN_NOTICE_EVERY !== 0) return;
      const between = [...new Set([...note.chain, note.to])];
      for (const member of householdOwners(db)) mail.send({ toKind: 'person', to: member, member, source: 'notice', sourceId: `handoff-chain:${JSON.stringify([note.chain[0], note.startedAt, note.chain.length])}`, fromKind: 'unknown',
        words: `Bodies of ${note.agent} have handed ${note.chain.length} notes to each other in one exchange since ${note.startedAt}, between conversations ${between.join(', ')}. Nothing was stopped: say stop in either place if it should end.`, refs: [note.agent] });
    },
  };
}
