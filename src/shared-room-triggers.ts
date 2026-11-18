/** A trigger that names a conversation (`triggers.conversation`): its firing is mail from the schedule in
 * that Discord or Slack conversation, starting a job there like any message, on the word of whoever asked
 * for it. Set, bounded and fired by the rules here; who may is policy.ts's (maySetTrigger, maySchedule). */
import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import { conversations, triggers } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import type { NewTrigger, Trigger } from './core/tempo/triggers.js';
import { isRoom, membersWithAgent, type Asker, type Viewer } from './policy.js';
import { householdOwners, sharedSharing } from './shared-sharing.js';
import { ROOM_REPEAT_MIN_MS, ROOM_TRIGGERS_MAX, isBridgeVenue, jobWord, named, roomClosed, stillKnown } from './shared-room-mail.js';

type Work = { cv: typeof conversations.$inferSelect; job: { id: string; agent: string; conversation: string | null } };
export const ROOM_REPEAT_REFUSAL = 'A schedule set from a room repeats no more often than once an hour, and only at listed times.';

/** Whether listed times come closer together than the least a room's trigger may repeat at. One time, and one date, never do. */
export function repeatsTooOften(trigger: { times?: string | null; lifespan?: string; sourceKind?: string }): boolean {
  if (trigger.sourceKind !== undefined && trigger.sourceKind !== 'time') return true;
  const times = trigger.times ?? '';
  if (/^\d{4}-/.test(times) || trigger.lifespan === 'once') return false;
  const minutes = [...new Set(times.split(',').map(part => part.trim()).filter(Boolean).map(part => { const [h, m] = part.split(':').map(Number); return h * 60 + m; }))].sort((a, b) => a - b);
  return minutes.some((at, index) => index > 0 && (at - minutes[index - 1]) * 60_000 < ROOM_REPEAT_MIN_MS)
    || (minutes.length > 1 && (minutes[0] + 1440 - minutes[minutes.length - 1]) * 60_000 < ROOM_REPEAT_MIN_MS);
}
/** Why a room's body may not make this change to a trigger it may otherwise touch (one naming its own conversation). */
export const ROOM_FILE_REFUSAL = 'A schedule set or reworded from a room carries its own words, never a file.';
export const ROOM_ASKER_REFUSAL = 'Somebody else asked for this schedule: only they, or somebody the agent works for, may change, stop, start or run it.';
export function roomRepeatRefusal(db: DataDatabase, work: Work | undefined, trigger: { conversation?: string | null; times?: string | null; lifespan?: string; sourceKind?: string; file?: string | null; askedByKind?: string | null; askedBy?: string | null }, change?: { times?: string; file?: string | null }): string | undefined {
  if (!work || !isRoom(work.cv) || !trigger.conversation) return undefined;
  // A trigger keeps to its asker: a body working for anybody but owners touches only what the same person asked for.
  const stored = trigger.askedByKind !== undefined, word = jobWord(db, work.job);
  if (stored && word.woke === 'others' && !(word.person && word.person.kind === trigger.askedByKind && word.person.id === trigger.askedBy)) return ROOM_ASKER_REFUSAL;
  // Words only: a file is the household repository's, and what it says is not this body's to bring into the room.
  if (change ? change.file != null : !stored && trigger.file != null) return ROOM_FILE_REFUSAL;
  return repeatsTooOften(change?.times === undefined ? trigger : { ...trigger, times: change.times }) ? ROOM_REPEAT_REFUSAL : undefined;
}
/** Why one more trigger may not stand for this conversation: the one check, for setting one and for turning one back on. */
export function roomFull(db: DataDatabase, conversation: string): string | undefined {
  return db.select({ id: triggers.id }).from(triggers).where(and(eq(triggers.conversation, conversation), eq(triggers.enabled, true))).all().length >= ROOM_TRIGGERS_MAX
    ? `A conversation has at most ${ROOM_TRIGGERS_MAX} schedules standing at once: stop one first` : undefined;
}
/** Who is asking, for a trigger that names this conversation, as it is set or its words, file or times are
 * changed. By a room's body, the person its job is working on the word of (the one of least reach), or the
 * agent itself when the work is the agent's own; never somebody nobody can name. By a person, that
 * member; by the agent anywhere else, the member it works for or the agent. */
export function asking(db: DataDatabase, viewer: Viewer, agent: string, work: Work | undefined): Asker {
  if (work && isRoom(work.cv)) {
    const word = jobWord(db, work.job);
    if (word.person) return word.person;
    if (word.woke === 'own') return { kind: 'agent', id: agent };
    throw new OperationError('denied', 'Nobody loom knows asked for this');
  }
  if (viewer.kind === 'member') return { kind: 'member', id: viewer.id };
  if (viewer.kind === 'agent' && viewer.id === agent) return viewer.workingFor ? { kind: 'member', id: viewer.workingFor } : { kind: 'agent', id: agent };
  throw new OperationError('denied', 'Only a person or the agent itself asks for a schedule in a conversation');
}
/** Who asked, for a new trigger that names a conversation, after checking it may be set: the conversation is
 * a bridge conversation of the agent the trigger puts to work, and it has room for one more. */
export function roomTriggerAsker(db: DataDatabase, viewer: Viewer, trigger: NewTrigger, work: Work | undefined): Asker {
  const cv = db.select().from(conversations).where(eq(conversations.id, trigger.conversation!)).get();
  if (!cv || !isBridgeVenue(cv.venue) || trigger.targetKind !== 'inbox' || trigger.toKind !== 'agent' || trigger.to !== cv.agent)
    throw new OperationError('invalid', 'A trigger names a Discord or Slack conversation of the agent it puts to work');
  const full = roomFull(db, cv.id); if (full) throw new OperationError('conflict', full);
  return asking(db, viewer, cv.agent, work);
}
/** Asked as such a trigger fires (core/tempo/tempo.ts). */
export function roomFiring(db: DataDatabase, trigger: Trigger): { stop: string; tell: string[] } | { told: string; onWord?: { kind: 'member' | 'outside'; id: string } } {
  const agent = trigger.to!, asker = { kind: trigger.askedByKind!, id: trigger.askedBy! };
  const cv = db.select().from(conversations).where(eq(conversations.id, trigger.conversation!)).get();
  const why = !cv || cv.agent !== agent || !isBridgeVenue(cv.venue) ? 'its conversation is gone' : roomClosed(db, cv)?.replace(/^its/, "its conversation's")
    ?? (stillKnown(db, agent, asker) ? undefined : `${named(asker)}, who asked for it, is no longer known to ${agent}`);
  if (why) { const sharing = sharedSharing(db); let tell = membersWithAgent(agent, sharing); if (!tell.length) tell = householdOwners(db); return { stop: why, tell }; }
  return { told: `[From the schedule, not from a person speaking now: ${JSON.stringify(trigger.note.replace(/[\[\]]/g, ''))}. ${asker.kind === 'agent' ? 'You set it yourself' : `Asked for by ${named(asker)}`} at ${trigger.askedAt}. What you answer is posted in this conversation as a new message.]`,
    ...(asker.kind === 'agent' ? {} : { onWord: { kind: asker.kind, id: asker.id } }) };
}
