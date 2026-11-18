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
import type { ChannelTarget } from './core/conversations/channel-target.js';
import { conversationPlace } from './pieces/bridges/place.js';
import { postable } from './pieces/bridges/reply-api.js';
import { workerPolicy } from './runtime/body-policy.js';
import type { WorkerRunPolicy } from './runtime/worker.js';

export const PRIVATE_PLACE_REFUSAL = 'That is one member\'s private conversation: only on that member\'s word, or as the agent\'s own work, is anything sent or scheduled there.';
/** Why a channel target names no place loom can post to (pieces/bridges/reply-api.ts, postable). */
export const UNPOSTABLE_REFUSAL = 'Nothing can be posted there: on Discord a thread is named as a channel of its own, and on Slack a thread is the time of the message that started it.';
/** Whether a channel target somebody named is a place loom can post to: postable, and on Discord with no
 * thread at all, since a conversation there is found by its channel alone. */
export const targetPostable = (to: { platform: 'discord' | 'slack'; channel: string; thread?: string }): boolean => postable(to.platform, to) && !(to.platform === 'discord' && to.thread !== undefined);
/** The most triggers that may stand at once naming one conversation. */
export const PLACE_TRIGGERS_MAX = 10;
/** The hour, said once: the least time between two listed times of a repeating trigger set on the word of
 * anybody but owners (the door's check, shared-place-triggers.ts), and the least time between two firings on
 * such a word into one conversation, whatever the trigger rows say (the firing's own check, placeFiring). */
export const WORD_REPEAT_MIN_MS = 3_600_000;
/** The most notes one job on the word of anybody but owners hands, briefs to a peer agent counted with them. A flood guard on one job, like the bound
 * on its posts (BRIDGE_POSTS_PER_JOB): each note may open a conversation and start a job. It is no limit on
 * an exchange, which no rule cuts short; a job working for owners, and the agent's own work, is not counted. */
export const NOTES_PER_JOB = 5;
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
/** The reach of one person's word for this agent, as it stands now: the agent itself is its own work; a
 * household owner and a member who has the agent are `owners`; anybody else is `others`. */
export function wordReach(db: DataDatabase, agent: string, who: Asker): Woke {
  if (who.kind === 'agent') return 'own';
  const sharing = sharedSharing(db);
  return who.kind === 'member' && (isHouseholdOwner({ kind: 'member', id: who.id }, sharing) || membersWithAgent(agent, sharing).includes(who.id)) ? 'owners' : 'others';
}
/** Why mail on this word is not delivered into a conversation that is one member's private one, or nothing:
 * only that member's word, and the agent's own work (no word at all), go in. The one statement, asked where a
 * firing is made and where a note is admitted; the doors ask it early so the caller hears why. */
export function privateRefusal(member: string | null, word: Asker | undefined): string | undefined {
  if (member === null || !word || word.kind === 'agent' || (word.kind === 'member' && word.id === member)) return undefined;
  return `its conversation is private to the member ${member}, and ${named(word)}, who asked for it, is not that member`;
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
  return roomWord(db, job, jobRoom(db, job));
}
/** Who is in a job's room, with the word it works on: what the dispatcher hands a worker with the job
 * (runtime/dispatcher.ts). The room is read from the mail the job is offered: what admission marked for it,
 * and mail a person wrote since that does not lower its word (lateMailJoins). */
export function jobRoom(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }): WorkerRunPolicy & { word: Woke } {
  const room = workerPolicy(db, job, item => lateMailJoins(db, job, item));
  return { ...room, word: roomWord(db, job, room).woke };
}
/** Whether mail from a person, arrived after this job was admitted, joins it, or waits for the next job. It
 * joins a job that is anybody else's already, which has nothing to lose; and otherwise only if it is not
 * itself anybody else's word. So a job admitted for its owners, or as the agent's own work, never becomes
 * anybody else's while it runs: what it may use (policy.ts, loomToolsOnly) was settled by its mail at
 * admission. The one answer, for the mail a body is handed (core/conversations, pending) and for the room. */
export function lateMailJoins(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }, item: { id: string }): boolean {
  if (roomWord(db, job, workerPolicy(db, job, () => false)).woke === 'others') return true;
  return roomWord(db, job, workerPolicy(db, job, undefined, [item.id])).woke !== 'others';
}
function roomWord(db: DataDatabase, job: { id: string; agent: string; conversation: string | null }, policy: WorkerRunPolicy): { woke: Woke; person?: OnWord } {
  const sharing = sharedSharing(db), have = new Set(membersWithAgent(job.agent, sharing));
  const people = [...policy.people];
  const member = job.conversation ? db.select({ member: conversations.member }).from(conversations).where(eq(conversations.id, job.conversation)).get()?.member : null;
  if (member) people.push(inHousehold({ kind: 'member', id: member }, sharing) ? { kind: 'person', person: member, tier: null } : { kind: 'unknown', person: null, tier: null });
  const mail = policy.mail ?? [];
  const unspoken = mail.length > 0 && db.select({ id: inbox.id }).from(inbox).where(and(inArray(inbox.id, mail), eq(inbox.fromKind, 'agent'), isNull(inbox.onWord))).all().length > 0;
  if (unspoken) return { woke: 'others' };
  if (!people.length) return { woke: 'own' };
  const rank = (p: typeof people[number]) => p.kind === 'unknown' || p.person === null ? 0 : p.kind === 'outside' ? (p.tier === null ? 0 : p.tier === 3 ? 2 : 1)
    : isHouseholdOwner({ kind: 'member', id: p.person }, sharing) ? 5 : have.has(p.person) ? 4 : 3;
  const least = [...people].sort((a, b) => rank(a) - rank(b))[0], lowest = rank(least);
  // Somebody nobody can name, or an outside account with no tier (a stranger), is behind it: nothing is done on such a word.
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
/** The channel a body working in this conversation for a guest may hand a note to, if any: the `reportsTo` of
 * the channel's rule, when that rule says this agent answers there. Another agent's rule names where that
 * agent's bodies report, not this one's. */
export function reportsTo(db: DataDatabase, cv: Place): string | null {
  const at = placeAddress(db, cv);
  if (!at || at.direct || !isBridgeVenue(cv.venue)) return null;
  return db.select({ reportsTo: bridgeChannels.reportsTo }).from(bridgeChannels)
    .where(and(eq(bridgeChannels.platform, cv.venue), eq(bridgeChannels.workspace, at.workspace), eq(bridgeChannels.channel, ruleChannel(db, cv, at.channel)), eq(bridgeChannels.answers, cv.agent))).get()?.reportsTo ?? null;
}
/** A person as a body is told of them: by what kind they are and the id loom knows them by. */
export const named = (who: { kind: string; id: string }): string => who.kind === 'member' ? `the member ${who.id}` : who.kind === 'agent' ? 'yourself' : `the outside account ${who.id}`;

/** Whether the agent has a channel rule for this channel: it is who answers there. */
export const ruled = (db: DataDatabase, agent: string, at: { platform: 'discord' | 'slack'; workspace: string; channel: string }): boolean =>
  !!db.select({ answers: bridgeChannels.answers }).from(bridgeChannels).where(and(eq(bridgeChannels.platform, at.platform), eq(bridgeChannels.workspace, at.workspace), eq(bridgeChannels.channel, at.channel), eq(bridgeChannels.answers, agent))).get();
/** A channel as a channel rule's `reportsTo` names it, and as a target is compared with it. */
export const channelKey = (platform: string, workspace: string, channel: string): string => JSON.stringify([platform, workspace, channel]);
/** A channel target somebody named, resolved for this agent: the one reading of it, for a note and for an
 * agent's own post. The agent has a rule for the channel (or it is `also`, the one channel the caller's own
 * channel reports to); the address is one loom can post to; and nothing closes the place. Answers the place
 * and the conversation there, if there is one; throws an OperationError to refuse. Reads only. */
export function channelPlace(db: DataDatabase, agent: string, to: ChannelTarget, what: 'note' | 'post', also: string | null = null): { place: string; cv?: typeof conversations.$inferSelect } {
  if (!ruled(db, agent, to) && channelKey(to.platform, to.workspace, to.channel) !== also) throw new OperationError('invalid', `A ${what} goes to a channel this agent has a rule for`);
  if (!targetPostable(to)) throw new OperationError('invalid', UNPOSTABLE_REFUSAL);
  const place = conversationPlace(to.workspace, { channel: to.channel, thread: to.thread ?? null, isDm: false }, null);
  const cv = db.select().from(conversations).where(and(eq(conversations.agent, agent), eq(conversations.venue, to.platform), eq(conversations.place, place))).get();
  const closed = placeClosed(db, cv ?? { id: '', agent, venue: to.platform, place }); if (closed) throw new OperationError('invalid', `Nothing can be posted there: ${closed}`);
  return { place, cv };
}
/** A note from one body of an agent to its body in another conversation: the composition's half of
 * `conversation.handoff` with `to`. The mail it writes starts the target conversation's job like any
 * message; that body, with its own context, says what there is to say in its own words. */
export function selfHandoff(db: DataDatabase, mail: { send(input: { toKind: 'person'; to: string; member: string; source: 'notice'; sourceId: string; fromKind: 'unknown'; words: string; refs: string[] }): unknown }, now: () => string): HandoffToSelf {
  return {
    word: work => jobWord(db, work.job).person,
    target(work, to) {
      const agent = work.cv.agent;
      let conversation: string | undefined, open: { venue: 'discord' | 'slack'; place: string; label: string } | undefined, key: string, where: string, there: Place;
      if ('conversation' in to) {
        const cv = db.select().from(conversations).where(eq(conversations.id, to.conversation)).get(), at = cv && cv.agent === agent ? placeAddress(db, cv) : undefined;
        if (!cv || !at || cv.id === work.cv.id) throw new OperationError('invalid', 'A note goes to another Discord or Slack conversation of this agent');
        const closed = placeClosed(db, cv); if (closed) throw new OperationError('invalid', `Nothing can be posted there: ${closed}`);
        // One member's private conversation is handed to only on that member's word, or by the agent's own work.
        const on = jobWord(db, work.job);
        if (cv.member !== null && (on.woke !== 'own' && !on.person || privateRefusal(cv.member, on.person))) throw new OperationError('denied', PRIVATE_PLACE_REFUSAL);
        there = cv;
        conversation = cv.id; key = channelKey(cv.venue, at.workspace, ruleChannel(db, cv, at.channel)); where = `${cv.venue} ${at.direct ? 'direct conversation' : `channel ${at.channel}`}`;
      } else {
        // A channel the agent has a rule for; the conversation there is found, or opened.
        // (Or the one channel its own channel's rule says it reports to: the owner named it there.)
        const { place, cv } = channelPlace(db, agent, to, 'note', reportsTo(db, work.cv));
        if (cv?.id === work.cv.id) throw new OperationError('invalid', 'A note goes to another conversation');
        there = cv ?? { id: '', agent, venue: to.platform, place };
        conversation = cv?.id; if (!cv) open = { venue: to.platform, place, label: to.thread ?? to.channel };
        key = channelKey(to.platform, to.workspace, to.channel); where = `${to.platform} channel ${to.channel}`;
      }
      const word = jobWord(db, work.job);
      if (!mayHandTo(word.woke, key, reportsTo(db, work.cv)) || (word.woke === 'others' && !word.person))
        throw new OperationError('denied', 'This body may hand a note only to the channel its own channel reports to, and its channel names none or another');
      const hop = this.hop(work); if (hop) throw new OperationError('denied', hop);
      const before = jobChain(db, work.job, conversation), chain = before?.chain ?? [], from = placeAddress(db, work.cv);
      // Whether the body this reaches could hand a note back, as far as can be known now: it will work on this
      // note's word at most, so the same questions are asked of the way back; and on anybody else's word a job a
      // note started hands nowhere. Told so it does not try in vain.
      const answerable = word.woke === 'owners' && !!from && !!word.person && (work.cv.member === null || (word.person.kind === 'member' && word.person.id === work.cv.member)) && !placeClosed(db, work.cv)
        && mayHandTo(word.woke, channelKey(work.cv.venue, from.workspace, ruleChannel(db, work.cv, from.channel)), reportsTo(db, there));
      const origin = from ? `${work.cv.venue} ${from.direct ? 'direct conversation' : `channel ${from.channel}`}` : `its own work (${work.cv.venue})`;
      return { conversation, open, chain, startedAt: before?.startedAt ?? now(), ...(word.person ? { onWord: word.person } : {}),
        told: `[A note from another body of yours, not a person speaking. It was working in ${origin} (conversation ${work.cv.id})${word.person ? `, for ${named(word.person)}` : ', on your own work'}. `
          + `Saying what needs saying here, in ${where}, in your own words, is your job. ${answerable ? `To answer that body, hand a note back to conversation ${work.cv.id}.` : 'A note back to that body would be refused from here.'} `
          + `Hand-offs before this one in this exchange: ${chain.length}${chain.length ? ` (through conversations ${chain.join(', ')})` : ''}. If this exchange is no longer making progress, stop and say so to a person instead of handing on.]` };
    },
    // A guest's word goes one hop: a job on anybody else's word that a note or a brief started hands nowhere, to its
    // own body elsewhere or to a peer agent. One a person's message or a firing started may.
    hop(work) {
      return jobWord(db, work.job).woke === 'others' && db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.job, work.job.id), eq(inbox.source, 'handoff'))).get()
        ? 'A note or a brief started this job, and it is not working for the agent\'s owners: it hands nothing on. Say what there is to say here.' : undefined;
    },
    full(work) {
      if (jobWord(db, work.job).woke !== 'others') return undefined;
      const mine = JSON.stringify([work.job.id]).slice(0, -1) + ',';
      const sent = db.select({ sourceId: inbox.sourceId }).from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.source, 'handoff'), eq(inbox.fromKind, 'agent'), eq(inbox.fromId, work.job.agent))).all().filter(item => item.sourceId?.startsWith(mine));
      return sent.length >= NOTES_PER_JOB ? `A job that is not working for the agent's owners hands at most ${NOTES_PER_JOB} notes and briefs` : undefined;
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
