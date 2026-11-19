/** Tempo's installation in the fresh shared program. Callers may supply runtime,
 * notification and provenance adapters; none is derived from operation input. */
import { randomUUID } from 'node:crypto';
import { NO_OWNER_TO_ASK, SCHEDULE_ASKED, applyPlaceSchedule, asking, continueComeBack, heldRefusal, ownersFirst, placeFiring, partRewordRefusal, placeCrowded, privateRewordRefusal, wordRefusal, placeTriggerAsker, type PlaceScheduleAsk } from './shared-place-triggers.js';
import { named } from './shared-place-mail.js';
import { OperationError } from './core/operations/index.js';
import { jobWord } from './shared-place-mail.js';
import { conversations as conversationRows } from './core/data/schema.js';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import type { Clock } from './core/clock.js';
import type { DataWrites } from './core/data/writes.js';
import type { Operations } from './core/operations/index.js';
import type { Conversations } from './core/conversations/index.js';
import { wakePlace, type TempoOptions } from './core/tempo/tempo.js';
import type { TempoOperationOptions } from './core/tempo/operations.js';
import type { Viewer } from './policy.js';
import type { Recipient } from './core/tempo/volume.js';
import type { SweepPart } from './core/tempo/sweep.js';
import { installTempoComposition } from './transport/tempo-composition.js';
import { tempoCommandAllowed, recordedTrigger } from './shared-tempo-access.js';
import { isHouseholdOwner, mayRunPrivateWork } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { Jobs, agentMailAdmission } from './runtime/jobs.js';
import { repositoryInstructions } from './core/tempo/repository.js';
import { editsWords } from './core/tempo/triggers.js';

export interface SharedTempoOptions {
  /** Trusted checkout path, never supplied by a command caller. */
  repository?: string;
  /** Accept one settled person batch. IDs only; delivery reads current policy. */
  notify?(member: string, items: readonly string[]): boolean;
  admit?: TempoOptions['admit'];
  operation?: TempoOptions['operation'];
  instructions?: TempoOptions['instructions'];
  changeRevision?: TempoOptions['changeRevision'];
  mailboxReceiptScope?:TempoOperationOptions['mailboxReceiptScope'];
  chatMember?(viewer: Viewer): string | undefined;
  /** The caller's job and the conversation it is in, when the caller is the body of a job: what it may
   * schedule follows the word that job works on (policy.ts, maySchedule). Nothing for a person or an agent's own session. */
  bodyWork?(viewer: Viewer): { cv: typeof conversationRows.$inferSelect; job: { id: string; agent: string; conversation: string | null } } | undefined;
  /** The job the caller's credential is bound to, whatever state it or its conversation is in: what the held question
   * is asked of (shared-place-mail.ts, heldRefusal), so it cannot fail open where `bodyWork` answers nothing. */
  bodyJob?(viewer: Viewer): { job: { id: string; agent: string; conversation: string | null } } | undefined;
  /** File the card that asks the household's owners for a repeating schedule somebody who is not an owner asked a
   * body for, and answer its id. Without it such a request is refused, never carried out unasked. */
  askOwners?(agent: string, ask: PlaceScheduleAsk, why: string, where: { conversation: string; member: string | null; project: string | null }): string;
  beforeStart?:Parameters<typeof installTempoComposition>[0]['beforeStart'];
  contributors?: readonly SweepPart[];
}
export function mayReadProgramWork(db: DataDatabase, viewer: Viewer, job?: { id: string; agent: string; conversation: string | null }): boolean {
  const sharing = sharedSharing(db);
  if (isHouseholdOwner(viewer, sharing)) return true;
  if (viewer.kind !== 'agent' || viewer.workingFor) return false;
  if (!job) return true;
  const word = jobWord(db, job);
  return word.woke === 'own' || (word.woke === 'owners' && word.person?.kind === 'member' && isHouseholdOwner({kind: 'member', id: word.person.id}, sharing));
}
export function installSharedTempo(db: DataDatabase, clock: Clock, writes: DataWrites, operations: Operations,
  conversations: Conversations, changed: () => void, options: SharedTempoOptions = {}) {
  /** The caller as it is judged for a trigger: a body that works on the word of a member who has the agent and
   * is no household owner is that member's body, as it would be in her own thread (Viewer.workingFor), wherever
   * the job sits. So what she has it schedule is her private work, and the agent's own triggers are not hers
   * to reword. A body already working for a member, and every other caller, is taken as it comes. */
  const judgedAs = (viewer: Viewer): Viewer => {
    const work = options.bodyJob?.(viewer) ?? options.bodyWork?.(viewer);
    if (!work || viewer.kind !== 'agent' || viewer.workingFor !== undefined) return viewer;
    const word = jobWord(db, work.job);
    return word.woke === 'owners' && word.person?.kind === 'member' && !isHouseholdOwner({ kind: 'member', id: word.person.id }, sharedSharing(db)) ? { ...viewer, workingFor: word.person.id } : viewer;
  };
  const jobStore = new Jobs(db, () => new Date(clock.now()).toISOString());
  const admitAgent = agentMailAdmission(jobStore, changed);
  // Loud, not a stop: a conversation with many schedules standing is told to the agent's people, and none is refused.
  const stood = (trigger: { id: string; conversation?: string | null }) => { const crowded = trigger.conversation ? placeCrowded(db, trigger.conversation, new Date(clock.now()).toISOString()) : undefined;
    for (const member of crowded?.tell ?? []) conversations.send({ toKind: 'person', to: member, member, source: 'notice', sourceId: crowded!.key, fromKind: 'schedule', words: crowded!.words, refs: [trigger.id] }); };
  const recorded: NonNullable<TempoOperationOptions['recorded']> = (viewer, trigger) => { const as = recordedTrigger(db, judgedAs(viewer), trigger);
    return trigger.conversation ? { trigger: as.trigger, asked: placeTriggerAsker(db, viewer, as.trigger, options.bodyWork?.(viewer)) } : as; };
  const installed = installTempoComposition({ db, clock, writes, operations,
    contributors: options.contributors,beforeStart:options.beforeStart,
    delivery: { conversations, changed,
      // Whom the work is for is on the trigger (`member`, set with it). How far that reaches is judged now:
      // a household owner's work is the whole agent's, anyone else's is narrowed to them, and for a member
      // who has left, lost the agent or left the trigger's project the firing fails.
      program(trigger, words) {
        const agent = trigger.to!;
        const conversation = conversations.open({ agent, venue: 'wake', place: wakePlace(trigger.id), label: trigger.note, project: trigger.project });
        if (conversation.member) throw new Error('The conversation at this trigger’s place belongs to other work');
        return jobStore.admitProgram(trigger, conversation.id, words);
      },
      placeFiring: trigger => placeFiring(db, trigger),
      worksFor(trigger) {
        if (trigger.member === null || trigger.toKind !== 'agent') return undefined;
        const sharing = sharedSharing(db), member = isHouseholdOwner({ kind: 'member', id: trigger.member }, sharing) ? undefined : trigger.member;
        if (member !== undefined && !mayRunPrivateWork({ agent: trigger.to!, member, project: trigger.project ?? undefined }, sharing))
          throw new Error('The member this was set for no longer has the agent, or is not in its project');
        return member;
      }, instructions: options.instructions ?? (options.repository ? repositoryInstructions(options.repository) : undefined), changeRevision: options.changeRevision,
      // Mail for a person is a notice to send; mail for an agent is work to admit.
      admit: options.admit ?? ((who, items) => who.kind === 'person'
        ? options.notify?.(who.id, items.map(item => item.id)) ?? false : admitAgent(who, items)),
      operation: options.operation ?? (() => { throw new Error('Unknown Tempo operation'); }),
      // The shipped program runs only the sweep. A composition that adds operations vouches for their names.
      knows: options.operation ? undefined : () => false,
    },
    // Chat is the control surface: a current body may carry out its member's ordinary mailbox preference
    // without becoming that member. When is the volume rule in policy.ts, asked by tempoCommandAllowed;
    // chatMember is this door's proof that the caller is the current body of that member's chat.
    commands: { mailboxReceiptScope:options.mailboxReceiptScope,
      // A trigger that names a conversation is the agent's own mail there and nobody's private work; who asked is recorded with it.
      recorded, authorize: (viewer, access) => {
        if ('trigger' in access && access.trigger.program && access.action !== 'stop') {
          const work = options.bodyJob?.(viewer) ?? options.bodyWork?.(viewer);
          if (!mayReadProgramWork(db, viewer, work?.job)) return false;
          if (viewer.kind === 'agent' && viewer.id !== access.trigger.to) return false;
        }
        return tempoCommandAllowed(db, access.action === 'volume' || access.action === 'pause' || access.action === 'resume' ? viewer : judgedAs(viewer), access, options.chatMember);
      },
      wordRefusal: (viewer, action, trigger, change) => { const work = options.bodyWork?.(viewer); return (action === 'edit' ? privateRewordRefusal(db, viewer, work, trigger, change) : undefined) ?? wordRefusal(db, work, action, trigger, change)
        ?? (action === 'edit' ? partRewordRefusal(db, viewer, work, trigger, change) : undefined); },
      // On anybody else's word a body has no schedule door at all, and neither pauses its agent nor changes any mail's volume.
      heldRefusal: (viewer, action) => heldRefusal(db, options.bodyJob?.(viewer) ?? options.bodyWork?.(viewer), action === 'pause' || action === 'resume' || action === 'volume' ? action : 'schedule'),
      // A come-back set or moved by a job a firing woke, on anybody else's word, is recorded as following that firing.
      stood: (viewer, action, trigger) => { if (action !== 'edit') stood(trigger);
        if (action !== 'start' && trigger.conversation) continueComeBack(db, new Date(clock.now()).toISOString(), options.bodyWork?.(viewer), trigger.id); },
      // A repeating schedule on anybody else's word is an owner's to allow: the card is filed here, with the trigger as
      // it would have been recorded and who asked, and the body is told it waits.
      ownersFirst: (viewer, ask) => { const work = options.bodyWork?.(viewer);
        const as = ask.action === 'set' && work && ask.trigger.conversation ? recorded(viewer, ask.trigger) : undefined;
        const card = ownersFirst(db, clock.now(), work, ask.action === 'set' ? { action: 'set', trigger: { ...(as?.trigger ?? ask.trigger), id: ask.trigger.id ?? `tr-${randomUUID()}` }, asked: as?.asked } : ask);
        if (!card || !work) return undefined;
        if (!options.askOwners) throw new OperationError('denied', NO_OWNER_TO_ASK);
        const id = options.askOwners(card.agent, card, `${named(card.asker)} asked ${card.agent} for this in ${card.place}. They are not one of ${card.agent}'s owners, so loom asks you first.`, { conversation: work.cv.id, member: work.cv.member, project: work.cv.project });
        return { id: card.action === 'set' ? card.trigger.id : card.id, card: id, waits: SCHEDULE_ASKED }; },
      // Changed words (instructions, file or note: editsWords) are the changer's: the trigger then runs on their word. A change of times alone leaves
      // both as they were, so a firing's words and its asker always come from the same person.
      reasked: (viewer, trigger, change) => { if (!trigger.conversation || !editsWords(change, trigger)) return undefined;
        const agent = db.select({ agent: conversationRows.agent }).from(conversationRows).where(eq(conversationRows.id, trigger.conversation)).get()?.agent;
        return agent ? asking(db, viewer, agent, options.bodyWork?.(viewer)) : undefined; } },
  });
  return { ...installed,
    /** Carry out a `placeSchedule` card an owner allowed (shared-household-proposals.ts), in that write. */
    placeSchedule(ask: PlaceScheduleAsk) { stood(applyPlaceSchedule(db, installed.triggers, ask)); } };
}
