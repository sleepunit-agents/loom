/** A trigger that names a conversation (`triggers.conversation`): its firing is mail from the schedule in
 * that Discord or Slack conversation, starting a job there like any message, on the word of whoever asked
 * for it. Set, bounded and fired by the rules here; who may is policy.ts's (maySetTrigger, maySchedule). */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import { conversations, inbox, inboxRefs, triggerLog, triggers } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import { z } from 'zod';
import { editsWords, logTrigger, wordsChanged, triggerEdit, triggerInput, type NewTrigger, type Trigger, type TriggerAsked, type TriggerEdit, type TriggerEngine } from './core/tempo/triggers.js';
import { nextTime } from './core/tempo/calendar.js';
import { householdTimezone } from './core/data/household-settings.js';
import { WORD_SCHEDULE_REFUSAL, isSharedPlace, maySchedule, type Asker, type OnWord, type Viewer } from './policy.js';
import { PRIVATE_PLACE_REFUSAL, PLACE_TRIGGERS_NOTICE_EVERY, isBridgeVenue, jobHeld, jobWord, named, placeAddress, placeClosed, privateRefusal, stillKnown, tellOwners, wordReach } from './shared-place-mail.js';

type Work = { cv: typeof conversations.$inferSelect; job: { id: string; agent: string; conversation: string | null } };
/** Why a body working for anybody but owners may not make this change to a trigger it may otherwise touch (one naming its own conversation). */
export const WORD_FILE_REFUSAL = 'A schedule set or reworded by a job that is not working for the agent\'s owners carries its own words, never a file.';
export const WORD_ASKER_REFUSAL = 'Somebody else asked for this schedule: only they, or somebody the agent works for, may change, stop, start or run it.';
export const RUN_NOW_REFUSAL = 'You are awake: do the work now. Only a body working for the agent\'s owners, or the agent\'s own work, fires a schedule by hand.';
export const WORD_EVENT_REFUSAL = 'A schedule set by a job that is not working for the agent\'s owners fires at listed times, never on an event.';
export const WORD_PART_REFUSAL = 'Somebody with less reach than you asked for this schedule, and a firing never carries one person\'s text on another\'s word: give both a new note and new instructions (or a file), or leave its words alone.';
export const WOKEN_BY_MAIL_REFUSAL = 'A firing or a note woke this job, and it is not working for the agent\'s owners: it may set a one-time schedule to come back to its work here, and it sets, changes and starts no repeating one. It may stop one the same person asked for.';
/** Why a body working for anybody but owners holds back nothing of its agent's: a pause holds every trigger the agent
 * has, and muted mail starts no job and joins none, in whatever conversation it waits. */
export const WORD_PAUSE_REFUSAL = 'This job is not working for the agent\'s owners: it does not pause or resume the agent. Stop a schedule the same person asked for here, or have an owner do it.';
export const WORD_VOLUME_REFUSAL = 'This job is not working for the agent\'s owners: it does not change the volume of any mail.';
/** Why this job may not pause or resume its agent, or set the volume of mail: it works on anybody else's word. The
 * one question for the three doors (core/tempo/operations.ts, heldRefusal). */
export function heldRefusal(db: DataDatabase, work: Work | undefined, action: 'pause' | 'resume' | 'volume'): string | undefined {
  return work && jobHeld(db, work.job) ? action === 'volume' ? WORD_VOLUME_REFUSAL : WORD_PAUSE_REFUSAL : undefined;
}
export const REFIRE_REFUSAL = 'This schedule\'s own firing woke this job: it does not fire or start it again.';
/** Why this job may not do this to a trigger, by whose word it works on (jobWord) and never by where it sits.
 * For every job: it does not fire or start again the trigger whose firing is in its mail. A job working for
 * owners, and the agent's own work, is held to nothing else here, in a shared place as anywhere. A job
 * on anybody else's word touches only what fires into the shared place it is working in (policy.ts,
 * maySchedule), fires nothing by hand, keeps to triggers the same person asked for, names no file, and
 * sets one only for listed times. How often one repeats is refused by no number: a repeating one is an
 * owner's to allow (ownersFirst). */
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
  // A firing or a note woke it: nobody is speaking. It may come back to work it is doing, with a one-time trigger, as
  // often as the work needs; a chain of those is made loud to the agent's people (comeBack) and refused at no length.
  // A repeating one is for a person to ask for: it sets, changes and starts none. It may stop what the same person
  // asked for (below).
  if (action !== 'stop' && repeats(action === 'edit' ? { lifespan: trigger.lifespan, times: change?.times ?? trigger.times } : trigger)
    && db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.job, work.job.id), inArray(inbox.source, ['trigger', 'handoff']))).get()) return WOKEN_BY_MAIL_REFUSAL;
  // A trigger keeps to its asker: such a body touches only what the same person asked for.
  if (stored && !(word.person && word.person.kind === trigger.askedByKind && word.person.id === trigger.askedBy)) return WORD_ASKER_REFUSAL;
  // Words only: a file is the household repository's, and what it says is not this body's to bring into the conversation.
  if (action === 'edit' ? change?.file != null : action === 'set' && trigger.file != null) return WORD_FILE_REFUSAL;
  // Listed times only: nobody but owners sets a trigger that watches an event.
  return action === 'set' && trigger.sourceKind !== undefined && trigger.sourceKind !== 'time' ? WORD_EVENT_REFUSAL : undefined;
}
/** Each time a chain of come-backs has grown by this many firings, the agent's people are told. It refuses nothing. */
export const COME_BACK_NOTICE_EVERY = 5;
const COMES_BACK = 'comes back';
/** Where a trigger's firing stands in a chain of come-backs: the trigger the chain began with, and which firing in
 * a row this one is. A trigger nothing is recorded for begins a chain: a person's message, or an owner, asked for it. */
function comeBack(db: DataDatabase, trigger: string): { root: string; count: number } {
  const noted = db.select({ note: triggerLog.note }).from(triggerLog).where(and(eq(triggerLog.trigger, trigger), eq(triggerLog.event, COMES_BACK))).orderBy(desc(triggerLog.seq)).get();
  if (noted) try { const [root, count] = JSON.parse(noted.note) as [string, number]; if (typeof root === 'string' && Number.isInteger(count) && count > 0) return { root, count }; } catch { /* a row this program did not write begins a chain */ }
  return { root: trigger, count: 1 };
}
/** Record that a trigger continues a chain of come-backs: a job on anybody else's word that a firing woke has set it,
 * or moved it, so its firing follows that one with nobody speaking. Kept in the trigger's own log (event
 * `comes back`, note `[first trigger, which firing in a row]`), in the write that sets or changes the trigger.
 * Nothing for any other job. */
export function continueComeBack(db: DataDatabase, now: string, work: Work | undefined, trigger: string): void {
  if (!work || jobWord(db, work.job).woke !== 'others') return;
  const woke = db.select({ ref: inboxRefs.ref }).from(inbox).innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id)).where(and(eq(inbox.job, work.job.id), eq(inbox.source, 'trigger'))).all()
    .filter(row => row.ref !== trigger && db.select({ id: triggers.id }).from(triggers).where(eq(triggers.id, row.ref)).get()).map(row => comeBack(db, row.ref)).sort((a, b) => b.count - a.count)[0];
  if (!woke || comeBack(db, trigger).count > woke.count) return;
  logTrigger(db, now, trigger, COMES_BACK, JSON.stringify([woke.root, woke.count + 1]));
}
/** Whether a trigger fires more than once: it is not once-only and its time is not one date. The one statement of
 * "repeating", for what a body may set on anybody else's word without an owner (ownersFirst). */
export const repeats = (trigger: { times?: string | null; lifespan?: string }): boolean => !(trigger.lifespan === 'once' || /^\d{4}-/.test(trigger.times ?? ''));
/** What a body is told when what it asked went to the owners instead of being set or changed. */
export const SCHEDULE_ASKED = 'Not done yet. A repeating schedule asked for by somebody who is not one of the agent\'s owners needs an owner\'s answer, so loom sent the request to them as a card, with who asked, the times and the words in full. Nothing is set or changed until an owner allows it. Say so to the person; the answer comes to this conversation.';
export const NO_OWNER_TO_ASK = 'A repeating schedule asked for by somebody who is not one of the agent\'s owners needs an owner\'s answer, and this program cannot ask one. Set a one-time schedule, or have an owner set it.';
const asker = z.object({ kind: z.enum(['member', 'outside']), id: z.string().min(1) }).strict();
const asked = { agent: z.string().min(1), conversation: z.string().min(1), place: z.string().min(1).max(500), asker };
/** A repeating schedule in a shared place, asked for there on the word of somebody who is not one of the agent's
 * owners: the card an owner answers (shared-household-proposals.ts, `placeSchedule`). It holds the trigger as it
 * would have been recorded, or the change to one that stands, and who asked. loom files it and nobody proposes it,
 * so the asker on it is loom's reading of the job's mail and never a caller's claim. */
export const placeScheduleAsk = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), ...asked, trigger: triggerInput.extend({ id: z.string().min(1), sourceKind: z.literal('time'), targetKind: z.literal('inbox'), toKind: z.literal('agent'), file: z.null().optional() }).strict() }).strict(),
  z.object({ action: z.literal('edit'), ...asked, id: z.string().min(1), change: triggerEdit.extend({ file: z.null().optional() }).strict() }).strict(),
]);
export type PlaceScheduleAsk = z.infer<typeof placeScheduleAsk>;
/** The card's words, for everyone who may read it: who asked, where, the times, and the note and words in full. The
 * note and the words are a body's, written for somebody who is not an owner, and are quoted as such. */
export function placeScheduleWords(ask: PlaceScheduleAsk): string {
  const quoted = (value: string | null | undefined) => value == null ? 'none' : JSON.stringify(value);
  const who = `asked for there by ${named(ask.asker)}, who is not one of ${ask.agent}'s owners`, where = `conversation ${ask.conversation} (${ask.place})`;
  if (ask.action === 'set') { const t = ask.trigger;
    return `Set a repeating schedule for ${ask.agent} in ${where}, ${who}. Times: ${t.times}${t.days ? `, on ${t.days}` : ', every day'}, ${t.lifespan === 'today' ? 'today only' : 'until it is stopped'}. `
      + `Its note, in the words of the body that asked and not loom's: ${quoted(t.note)}. What each firing tells the body, in the same body's words: ${quoted(t.instructions)}.${t.wantsModel ? ` Model wanted: ${t.wantsModel}.` : ''}`; }
  const c = ask.change, parts = [c.times !== undefined ? `times ${c.times}` : '', c.days !== undefined ? `days ${c.days ?? 'every day'}` : '', c.note !== undefined ? `its note ${quoted(c.note)}` : '',
    c.instructions !== undefined ? `what each firing tells the body ${quoted(c.instructions)}` : '', c.wantsModel !== undefined ? `model wanted ${c.wantsModel ?? 'none'}` : ''].filter(Boolean);
  return `Change schedule ${ask.id} of ${ask.agent} in ${where}, ${who}. It repeats once changed. Changed, with the note and words in the words of the body that asked and not loom's: ${parts.join('; ')}.`;
}
/** What the owner is asked, and told the answer does. None of it is a body's words: the answer is mail to the agent
 * on the owner's word, and carries these lines. */
export function placeScheduleCard(ask: PlaceScheduleAsk): { ask: string; ifYes: string; ifNo: string } {
  const where = `conversation ${ask.conversation}`, who = named(ask.asker);
  return ask.action === 'set'
    ? { ask: `Set a repeating schedule for ${ask.agent} in ${where}, asked for by ${who}?`, ifYes: `The schedule is set as the card shows, on the word of ${who}: each firing starts a job in that conversation with loom's tools only.`, ifNo: 'Nothing is set.' }
    : { ask: `Change schedule ${ask.id} in ${where} so that it repeats, asked for by ${who}?`, ifYes: `The schedule is changed as the card shows, and stays on the word of ${who}.`, ifNo: 'The schedule stays as it is.' };
}
/** When what a body asks needs an owner's answer first, the card to file: a job on anybody else's word sets no
 * repeating trigger and changes none that repeats once changed (the owner's ruling, 2026-11-18: a body coming back
 * to its own work may, any time; a schedule somebody who is not an owner wants set up is asked of an owner).
 * Asked after wordRefusal, so what reaches here names the job's own shared place, carries words and no file, fires
 * at listed times, and, for a change, is the same person's. Nothing for any other job, and for a one-time trigger. */
export function ownersFirst(db: DataDatabase, now: number, work: Work | undefined, ask: { action: 'set'; trigger: NewTrigger; asked: Asker | undefined } | { action: 'edit'; trigger: Trigger; change: TriggerEdit }): PlaceScheduleAsk | undefined {
  if (!work || jobWord(db, work.job).woke !== 'others') return undefined;
  const after = ask.action === 'set' ? ask.trigger : { lifespan: ask.trigger.lifespan, times: ask.change.times ?? ask.trigger.times, days: ask.change.days !== undefined ? ask.change.days : ask.trigger.days };
  if (!repeats(after)) return undefined;
  // Times that could never fire are the asker's to hear now, not an owner's to find on Allow.
  try { nextTime(after.times ?? '', after.days ?? null, now, householdTimezone(db)); } catch (error) { throw new OperationError('invalid', error instanceof Error ? error.message : 'Invalid times'); }
  const at = placeAddress(db, work.cv), place = at ? `${work.cv.venue} ${at.direct ? 'direct conversation' : `channel ${at.channel}`}${at.thread ? `, thread ${at.thread}` : ''}` : work.cv.venue;
  const who = ask.action === 'set' ? ask.asked : ask.trigger.askedByKind && ask.trigger.askedBy ? { kind: ask.trigger.askedByKind, id: ask.trigger.askedBy } : undefined;
  if (!who || who.kind === 'agent') throw new OperationError('denied', 'Nobody loom knows asked for this');
  const base = { agent: work.cv.agent, conversation: work.cv.id, place, asker: who as OnWord };
  // Only what was sent goes on the card: JSON drops what is not there.
  return placeScheduleAsk.parse(JSON.parse(JSON.stringify(ask.action === 'set' ? { action: 'set', ...base, trigger: ask.trigger } : { action: 'edit', ...base, id: ask.trigger.id, change: ask.change })));
}
/** Why an allowed card can no longer be carried out, in words for the owner who allowed it, or nothing: asked on
 * what is there when they answer. The conversation is still a shared place of the agent that can be posted to,
 * the asker is still known to the agent, and a trigger to change still stands for that conversation and asker. */
export function placeScheduleRefusal(db: DataDatabase, ask: PlaceScheduleAsk): string | undefined {
  const cv = db.select().from(conversations).where(eq(conversations.id, ask.conversation)).get();
  if (!cv || cv.agent !== ask.agent || !isSharedPlace(cv)) return 'Its conversation is gone';
  const closed = placeClosed(db, cv); if (closed) return `Nothing can be posted there: ${closed}`;
  if (!stillKnown(db, ask.agent, ask.asker)) return `${named(ask.asker)}, who asked for it, is no longer known to ${ask.agent}`;
  if (ask.action === 'set') return ask.trigger.conversation === cv.id && ask.trigger.to === cv.agent ? undefined : 'A trigger names a Discord or Slack conversation of the agent it puts to work';
  const stored = db.select().from(triggers).where(eq(triggers.id, ask.id)).get();
  return stored && stored.conversation === cv.id && stored.askedByKind === ask.asker.kind && stored.askedBy === ask.asker.id ? undefined : 'The schedule is gone, or somebody else has reworded it since';
}
/** Carry out an allowed card: the trigger is made with the person who asked as its asker, exactly as the door would
 * have made it, or the change is made as that person's body would have made it. */
export function applyPlaceSchedule(db: DataDatabase, engine: Pick<TriggerEngine, 'set' | 'edit'>, ask: PlaceScheduleAsk): Trigger {
  const refused = placeScheduleRefusal(db, ask); if (refused) throw new OperationError('invalid', refused);
  if (ask.action === 'set') return engine.set(ask.trigger, undefined, ask.asker);
  engine.edit(ask.id, ask.change, { kind: 'agent', id: ask.agent }, ask.asker);
  return db.select().from(triggers).where(eq(triggers.id, ask.id)).get()!;
}
/** Why this caller may not reword a trigger that names one member's private conversation: the words would
 * become the caller's and fire there on the caller's word. Asked of every caller, a person too. The firing
 * asks again (placeFiring); this is the early refusal. */
export function privateRewordRefusal(db: DataDatabase, viewer: Viewer, work: Work | undefined, trigger: TriggerAsked, change?: { instructions?: string | null; file?: string | null; note?: string }): string | undefined {
  if (!trigger.conversation || !change || !editsWords(change, trigger)) return undefined;
  const cv = db.select({ agent: conversations.agent, member: conversations.member }).from(conversations).where(eq(conversations.id, trigger.conversation)).get();
  return cv && cv.member !== null && privateRefusal(cv.member, asking(db, viewer, cv.agent, work)) ? PRIVATE_PLACE_REFUSAL : undefined;
}
/** Why this caller may not change only part of a trigger's words: a firing never carries one person's text
 * on another's word. Changed words re-stamp the asker to the editor (shared-tempo.ts, reasked), so an edit
 * that left the note or the instructions as the old asker wrote them would fire that text on the editor's
 * word. The rule bites only when the old asker's reach is lower than the editor's, said once here: the
 * asker changing their own trigger, and owners' reach changing what the agent or an owner asked for, are
 * free. Otherwise the edit replaces all of it (the note, and the instructions or a file) or is refused. Replaced
 * means different from what is stored: words sent back as they stand are the old asker's still, so an edit that
 * sends everything and changes one part is refused like one that sends one part, and one that changes nothing is
 * no reword at all. */
export function partRewordRefusal(db: DataDatabase, viewer: Viewer, work: Work | undefined, trigger: TriggerAsked, change?: { instructions?: string | null; file?: string | null; note?: string }): string | undefined {
  const changed = change && wordsChanged(change, trigger);
  if (!trigger.conversation || !trigger.askedByKind || !trigger.askedBy || !changed || !(changed.note || changed.said)) return undefined;
  const agent = db.select({ agent: conversations.agent }).from(conversations).where(eq(conversations.id, trigger.conversation)).get()?.agent;
  if (!agent) return undefined;
  const was = { kind: trigger.askedByKind, id: trigger.askedBy } as Asker, editor = asking(db, viewer, agent, work);
  if (editor.kind === was.kind && editor.id === was.id) return undefined;
  if (!(wordReach(db, agent, was) === 'others' && wordReach(db, agent, editor) !== 'others')) return undefined;
  return changed.note && changed.said ? undefined : WORD_PART_REFUSAL;
}
/** The notice a conversation raises when one more trigger has come to stand for it, by being set or turned back
 * on, and that makes PLACE_TRIGGERS_NOTICE_EVERY of them or a further multiple: whom to tell and in what words.
 * Loud, not a stop: no number is refused. One mark is told once a day, so stopping and starting one at the mark
 * tells nobody twice. */
export function placeCrowded(db: DataDatabase, conversation: string, now: string): { tell: string[]; key: string; words: string } | undefined {
  const count = db.select({ id: triggers.id }).from(triggers).where(and(eq(triggers.conversation, conversation), eq(triggers.enabled, true))).all().length;
  if (!count || count % PLACE_TRIGGERS_NOTICE_EVERY !== 0) return undefined;
  const agent = db.select({ agent: conversations.agent }).from(conversations).where(eq(conversations.id, conversation)).get()?.agent;
  return agent ? { tell: tellOwners(db, agent), key: `place-schedules:${JSON.stringify([conversation, count, now.slice(0, 10)])}`,
    words: `${count} schedules now stand for one conversation of ${agent} (${conversation}). Nothing was refused: stop any that should not stand.` } : undefined;
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
 * a bridge conversation of the agent the trigger puts to work. */
export function placeTriggerAsker(db: DataDatabase, viewer: Viewer, trigger: NewTrigger, work: Work | undefined): Asker {
  const cv = db.select().from(conversations).where(eq(conversations.id, trigger.conversation!)).get();
  if (!cv || !isBridgeVenue(cv.venue) || trigger.targetKind !== 'inbox' || trigger.toKind !== 'agent' || trigger.to !== cv.agent)
    throw new OperationError('invalid', 'A trigger names a Discord or Slack conversation of the agent it puts to work');
  const asker = asking(db, viewer, cv.agent, work);
  // One member's private conversation is named only on that member's word, or by the agent's own work.
  if (privateRefusal(cv.member, asker)) throw new OperationError('denied', PRIVATE_PLACE_REFUSAL);
  return asker;
}
/** Asked as such a trigger fires (core/tempo/tempo.ts): the one place every firing into a conversation
 * passes, whatever door set or changed the trigger. It is stopped, with a notice, when its conversation is
 * gone or closed, when its asker is no longer known, and when the conversation is one member's private one
 * and the asker is anybody else. No firing is put off or held back for how soon it follows another; a long chain of
 * come-backs is answered with `loud`, a notice for the agent's people. */
export function placeFiring(db: DataDatabase, trigger: Trigger): { stop: string; tell: string[] } | { told: string; onWord?: { kind: 'member' | 'outside'; id: string }; loud?: { tell: string[]; key: string; words: string } } {
  const agent = trigger.to!, asker = { kind: trigger.askedByKind!, id: trigger.askedBy! };
  const cv = db.select().from(conversations).where(eq(conversations.id, trigger.conversation!)).get();
  const others = wordReach(db, agent, asker) === 'others';
  const why = !cv || cv.agent !== agent || !isBridgeVenue(cv.venue) ? 'its conversation is gone' : placeClosed(db, cv)?.replace(/^its/, "its conversation's")
    ?? (stillKnown(db, agent, asker) ? undefined : `${named(asker)}, who asked for it, is no longer known to ${agent}`)
    ?? privateRefusal(cv.member, asker)
    // The doors let nobody but owners set a trigger that watches an event; one that stands on another word is stopped here.
    ?? (others && trigger.sourceKind !== 'time' ? `it watches an event, and ${named(asker)}, who asked for it, is not one of ${agent}'s owners` : undefined);
  if (why) return { stop: why, tell: tellOwners(db, agent) };
  // Loud, not a stop: a chain of come-backs on anybody else's word, each set by the job the one before woke, is told
  // to the agent's people each time it has grown by COME_BACK_NOTICE_EVERY.
  const back = others ? comeBack(db, trigger.id) : undefined;
  const loud = back && back.count % COME_BACK_NOTICE_EVERY === 0 ? { tell: tellOwners(db, agent), key: `come-back-chain:${JSON.stringify([back.root, back.count])}`,
    words: `Bodies of ${agent} have come back to their work in conversation ${cv!.id} ${back.count} times in a row, each on a schedule set by the job the one before woke, on the word of ${named(asker)}. Nothing was stopped: say stop in that conversation if it should end.` } : undefined;
  return { ...(loud ? { loud } : {}), told: `[From the schedule, not from a person speaking now: ${JSON.stringify(trigger.note.replace(/[\[\]]/g, ''))}. ${asker.kind === 'agent' ? 'You set it yourself' : `Asked for by ${named(asker)}`} at ${trigger.askedAt}. What you answer is posted in this conversation as a new message.]`,
    ...(asker.kind === 'agent' ? {} : { onWord: { kind: asker.kind, id: asker.id } }) };
}
