/** A trigger that names a conversation (`triggers.conversation`): its firing is mail from the schedule in
 * that Discord or Slack conversation, starting a job there like any message, on the word of whoever asked
 * for it. Set, bounded and fired by the rules here; who may is policy.ts's (maySetTrigger, maySchedule). */
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import { conversations, inbox, inboxRefs, triggers } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import type { NewTrigger, Trigger, TriggerAsked } from './core/tempo/triggers.js';
import { WORD_SCHEDULE_REFUSAL, isSharedPlace, maySchedule, membersWithAgent, type Asker, type Viewer } from './policy.js';
import { householdOwners, sharedSharing } from './shared-sharing.js';
import { PRIVATE_PLACE_REFUSAL, WORD_REPEAT_MIN_MS, PLACE_TRIGGERS_MAX, isBridgeVenue, jobWord, named, placeClosed, privateRefusal, stillKnown, wordReach } from './shared-place-mail.js';

type Work = { cv: typeof conversations.$inferSelect; job: { id: string; agent: string; conversation: string | null } };
export const WORD_REPEAT_REFUSAL = 'A schedule set by a job that is not working for the agent\'s owners repeats no more often than once an hour, and only at listed times.';

/** Whether listed times come closer together than the least a trigger set on the word of anybody but owners may repeat at. One time, and one date, never do. */
export function repeatsTooOften(trigger: { times?: string | null; lifespan?: string }): boolean {
  const times = trigger.times ?? '';
  if (/^\d{4}-/.test(times) || trigger.lifespan === 'once') return false;
  const minutes = [...new Set(times.split(',').map(part => part.trim()).filter(Boolean).map(part => { const [h, m] = part.split(':').map(Number); return h * 60 + m; }))].sort((a, b) => a - b);
  return minutes.some((at, index) => index > 0 && (at - minutes[index - 1]) * 60_000 < WORD_REPEAT_MIN_MS)
    || (minutes.length > 1 && (minutes[0] + 1440 - minutes[minutes.length - 1]) * 60_000 < WORD_REPEAT_MIN_MS);
}
/** Why a body working for anybody but owners may not make this change to a trigger it may otherwise touch (one naming its own conversation). */
export const WORD_FILE_REFUSAL = 'A schedule set or reworded by a job that is not working for the agent\'s owners carries its own words, never a file.';
export const WORD_ASKER_REFUSAL = 'Somebody else asked for this schedule: only they, or somebody the agent works for, may change, stop, start or run it.';
export const RUN_NOW_REFUSAL = 'You are awake: do the work now. Only a body working for the agent\'s owners, or the agent\'s own work, fires a schedule by hand.';
export const WORD_EVENT_REFUSAL = 'A schedule set by a job that is not working for the agent\'s owners fires at listed times, never on an event.';
export const WOKEN_BY_MAIL_REFUSAL = 'A firing or a note woke this job, and it is not working for the agent\'s owners: it sets, changes, starts and runs no schedule. It may stop one the same person asked for.';
export const REFIRE_REFUSAL = 'This schedule\'s own firing woke this job: it does not fire or start it again.';
/** Why this job may not do this to a trigger, by whose word it works on (jobWord) and never by where it sits.
 * For every job: it does not fire or start again the trigger whose firing is in its mail. A job working for
 * owners, and the agent's own work, is held to nothing else here, in a shared place as anywhere. A job
 * on anybody else's word touches only what fires into the shared place it is working in (policy.ts,
 * maySchedule), fires nothing by hand, keeps to triggers the same person asked for, names no file, and
 * sets or moves one only to listed times an hour apart. */
export function wordRefusal(db: DataDatabase, work: Work | undefined, action: 'set' | 'edit' | 'stop' | 'start' | 'runNow', trigger: TriggerAsked, change?: { times?: string; file?: string | null }): string | undefined {
  if (!work) return undefined;
  const word = jobWord(db, work.job), stored = action !== 'set';
  // No job fires again the trigger whose firing woke it: that would be a loop nobody is in.
  if ((action === 'runNow' || action === 'start') && trigger.id && db.select({ id: inbox.id }).from(inbox).innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id))
    .where(and(eq(inbox.job, work.job.id), eq(inbox.source, 'trigger'), eq(inboxRefs.ref, trigger.id))).get()) return REFIRE_REFUSAL;
  // Reach follows the person: on owners' word, or as the agent's own work, the body does what it could from its own thread.
  if (word.woke !== 'others') return undefined;
  // A guest, a member who does not have the agent, nobody loom can name: only what fires into the shared place it
  // is working in. In a brief's conversation or a wake that is nothing at all.
  if (!maySchedule(word.woke, work.cv, trigger)) return WORD_SCHEDULE_REFUSAL;
  // A body working for anybody but owners is awake and does its work now.
  if (action === 'runNow') return RUN_NOW_REFUSAL;
  // A firing or a note woke it: it schedules nothing more, so no chain of firings runs on such a word with nobody
  // speaking. It may stop what the same person asked for (below).
  if (action !== 'stop' && db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.job, work.job.id), inArray(inbox.source, ['trigger', 'handoff']))).get()) return WOKEN_BY_MAIL_REFUSAL;
  // A trigger keeps to its asker: such a body touches only what the same person asked for.
  if (stored && !(word.person && word.person.kind === trigger.askedByKind && word.person.id === trigger.askedBy)) return WORD_ASKER_REFUSAL;
  // Words only: a file is the household repository's, and what it says is not this body's to bring into the conversation.
  if (action === 'edit' ? change?.file != null : action === 'set' && trigger.file != null) return WORD_FILE_REFUSAL;
  // How often it repeats is asked when it is set and when its times change, and never to stop, start or reword one.
  if (action === 'set' && trigger.sourceKind !== undefined && trigger.sourceKind !== 'time') return WORD_EVENT_REFUSAL;
  if (action === 'set') return repeatsTooOften(trigger) ? WORD_REPEAT_REFUSAL : undefined;
  return action === 'edit' && change?.times !== undefined && repeatsTooOften({ ...trigger, times: change.times }) ? WORD_REPEAT_REFUSAL : undefined;
}
/** Why this caller may not reword a trigger that names one member's private conversation: the words would
 * become the caller's and fire there on the caller's word. Asked of every caller, a person too. The firing
 * asks again (placeFiring); this is the early refusal. */
export function privateRewordRefusal(db: DataDatabase, viewer: Viewer, work: Work | undefined, trigger: TriggerAsked, change?: { instructions?: string | null; file?: string | null }): string | undefined {
  if (!trigger.conversation || (change?.instructions === undefined && change?.file === undefined)) return undefined;
  const cv = db.select({ agent: conversations.agent, member: conversations.member }).from(conversations).where(eq(conversations.id, trigger.conversation)).get();
  return cv && cv.member !== null && privateRefusal(cv.member, asking(db, viewer, cv.agent, work)) ? PRIVATE_PLACE_REFUSAL : undefined;
}
/** Why one more trigger may not stand for this conversation: the one check, for setting one and for turning one back on. */
export function placeFull(db: DataDatabase, conversation: string): string | undefined {
  return db.select({ id: triggers.id }).from(triggers).where(and(eq(triggers.conversation, conversation), eq(triggers.enabled, true))).all().length >= PLACE_TRIGGERS_MAX
    ? `A conversation has at most ${PLACE_TRIGGERS_MAX} schedules standing at once: stop one first` : undefined;
}
/** Who is asking, for a trigger that names this conversation, as it is set or its words, file or times are
 * changed. By a shared place's body, the person its job is working on the word of (the one of least reach), or the
 * agent itself when the work is the agent's own; never somebody nobody can name. By a person, that
 * member; by the agent anywhere else, the member it works for or the agent. */
export function asking(db: DataDatabase, viewer: Viewer, agent: string, work: Work | undefined): Asker {
  if (work && isSharedPlace(work.cv)) {
    const word = jobWord(db, work.job);
    if (word.person) return word.person;
    if (word.woke === 'own') return { kind: 'agent', id: agent };
    throw new OperationError('denied', 'Nobody loom knows asked for this');
  }
  if (viewer.kind === 'member') return { kind: 'member', id: viewer.id };
  // The agent is the asker only when the work is its own: a body anywhere asks on the word it works on.
  if (viewer.kind === 'agent' && viewer.id === agent) {
    if (viewer.workingFor) return { kind: 'member', id: viewer.workingFor };
    const word = work ? jobWord(db, work.job) : { woke: 'own' as const, person: undefined };
    if (word.person) return word.person;
    if (word.woke === 'own') return { kind: 'agent', id: agent };
    throw new OperationError('denied', 'Nobody loom knows asked for this');
  }
  throw new OperationError('denied', 'Only a person or the agent itself asks for a schedule in a conversation');
}
/** Who asked, for a new trigger that names a conversation, after checking it may be set: the conversation is
 * a bridge conversation of the agent the trigger puts to work, and it has room for one more. */
export function placeTriggerAsker(db: DataDatabase, viewer: Viewer, trigger: NewTrigger, work: Work | undefined): Asker {
  const cv = db.select().from(conversations).where(eq(conversations.id, trigger.conversation!)).get();
  if (!cv || !isBridgeVenue(cv.venue) || trigger.targetKind !== 'inbox' || trigger.toKind !== 'agent' || trigger.to !== cv.agent)
    throw new OperationError('invalid', 'A trigger names a Discord or Slack conversation of the agent it puts to work');
  const full = placeFull(db, cv.id); if (full) throw new OperationError('conflict', full);
  const asker = asking(db, viewer, cv.agent, work);
  // One member's private conversation is named only on that member's word, or by the agent's own work.
  if (privateRefusal(cv.member, asker)) throw new OperationError('denied', PRIVATE_PLACE_REFUSAL);
  return asker;
}
/** Asked as such a trigger fires (core/tempo/tempo.ts): the one place every firing into a conversation
 * passes, whatever door set or changed the trigger. It is stopped, with a notice, when its conversation is
 * gone or closed, when its asker is no longer known, and when the conversation is one member's private one
 * and the asker is anybody else. A firing on the word of anybody but owners that comes less than
 * WORD_REPEAT_MIN_MS after the last such firing into the same conversation is put off to that mark. */
export function placeFiring(db: DataDatabase, trigger: Trigger, now: string): { stop: string; tell: string[] } | { putOff: string } | { told: string; onWord?: { kind: 'member' | 'outside'; id: string } } {
  const agent = trigger.to!, asker = { kind: trigger.askedByKind!, id: trigger.askedBy! };
  const cv = db.select().from(conversations).where(eq(conversations.id, trigger.conversation!)).get();
  const others = wordReach(db, agent, asker) === 'others';
  const why = !cv || cv.agent !== agent || !isBridgeVenue(cv.venue) ? 'its conversation is gone' : placeClosed(db, cv)?.replace(/^its/, "its conversation's")
    ?? (stillKnown(db, agent, asker) ? undefined : `${named(asker)}, who asked for it, is no longer known to ${agent}`)
    ?? privateRefusal(cv.member, asker)
    // Only listed times can be put off; the doors let nobody but owners set a trigger that watches an event.
    ?? (others && trigger.sourceKind !== 'time' ? `it watches an event, and ${named(asker)}, who asked for it, is not one of ${agent}'s owners` : undefined);
  if (why) { const sharing = sharedSharing(db); let tell = membersWithAgent(agent, sharing); if (!tell.length) tell = householdOwners(db); return { stop: why, tell }; }
  if (others) {
    const last = db.select({ at: inbox.at, kind: inbox.onWordKind, id: inbox.onWord }).from(inbox).where(and(eq(inbox.conversation, cv!.id), eq(inbox.source, 'trigger'), isNotNull(inbox.onWord))).orderBy(desc(inbox.at)).all()
      .find(item => wordReach(db, agent, { kind: item.kind!, id: item.id! }) === 'others');
    const mark = last && new Date(Date.parse(last.at) + WORD_REPEAT_MIN_MS).toISOString();
    if (mark && now < mark) return { putOff: mark };
  }
  return { told: `[From the schedule, not from a person speaking now: ${JSON.stringify(trigger.note.replace(/[\[\]]/g, ''))}. ${asker.kind === 'agent' ? 'You set it yourself' : `Asked for by ${named(asker)}`} at ${trigger.askedAt}. What you answer is posted in this conversation as a new message.]`,
    ...(asker.kind === 'agent' ? {} : { onWord: { kind: asker.kind, id: asker.id } }) };
}
