/** Wake me when. An agent asks loom to watch something for it and goes on, or stops; loom does the waiting.
 *
 * The owner's words (2026-11-19): "instead of going ok I'm going to write this script that checks and sees when it
 * passes and drop in every 10 minutes, you can literally go... wake me when pr 33 changes and boom, off to the
 * races". And how a wake is delivered: "first it goes, is there an existing session this should belong to?
 * whether that's a conversation in a channel or a terminal session or whatever. if there is, it goes... is that
 * thing awake right now? if so, it relays the message in. if it's not, it tells loom to bring it up. if there's no
 * logical session to resume to... like if this one requested something and I quit it... it just spawns a new one
 * with the right info".
 *
 * A wait is an ordinary once-only trigger (core/tempo/wake.ts says how it is marked), so Tempo lists it, whoever
 * sees a trigger sees it, and `tempo.stop` cancels it. This file is the two things a wake adds:
 *  - the door, `tempo.wake`: who may ask, for what, and how many;
 *  - the delivery, `deliverWake`: the owner's rule above, as one function every wake goes through. */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, like, lte, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import type { Clock } from './core/clock.js';
import { approvals, changes, changeChecks, changePeople, conversations, inbox, inboxRefs, jobs, secretRequests, terminalSessions, threads, triggerLog, triggers } from './core/data/schema.js';
import { unendedJobStates } from './core/data/job-states.js';
import { OperationError, operation, type Operations } from './core/operations/index.js';
import type { Conversations } from './core/conversations/index.js';
import { terminalSilenceMs } from './core/conversations/terminal-sessions.js';
import { logTrigger, type NewTrigger, type Trigger, type TriggerEngine } from './core/tempo/triggers.js';
import { wakePlace } from './core/tempo/tempo.js';
import { SOURCE_SNAPSHOT, changeSnapshot } from './core/tempo/sources.js';
import { WAKES_MAX, WAKE_DAYS, WAKE_FACTS, WAKE_MS, WATCH_ENDED, changeHappened, changeName, factsDiffer, parseFacts, readWatched, standsNow, wakeClause, wakeCondition,
  wakeInput, wakeTarget, wakeTitle, wakeWords, watchExpired, watchName, watchedOf, type ChangeFacts, type WakeInput, type Watched } from './core/tempo/wake.js';
import { isHouseholdOwner, mayRunPrivateWork, type Asker, type Viewer } from './policy.js';
import { canReadSharedConversation, sharedSharing } from './shared-sharing.js';
import { PRIVATE_PLACE_REFUSAL, isBridgeVenue, named, placeClosed, privateRefusal, stillKnown, tellOwners, wordReach } from './shared-place-mail.js';
import { asking } from './shared-place-triggers.js';
import { recordedTrigger, wakeAllowed, watchAllowed } from './shared-tempo-access.js';
import type { Change } from './pieces/changes/model.js';
import type { PullRequestReader } from './apps/changes.js';

type Conversation = typeof conversations.$inferSelect;
type Work = { cv: Conversation; job: { id: string; agent: string; conversation: string | null } };
const titled = (id: string) => id ? id[0].toUpperCase() + id.slice(1) : id;
const wakeTargets = or(eq(triggers.target, 'wake'), like(triggers.target, 'wake:%'));

/** What a wake reads of a change: the shared cache's row, its checks and who reviewed it. */
export function changeFacts(db: DataDatabase, id: string): (ChangeFacts & { url: string }) | undefined {
  const row = db.select().from(changes).where(eq(changes.id, id)).get();
  if (!row) return undefined;
  const checks = db.select().from(changeChecks).where(eq(changeChecks.change, id)).orderBy(asc(changeChecks.name)).all();
  const reviewers = db.select({ login: changePeople.login }).from(changePeople).where(and(eq(changePeople.change, id), eq(changePeople.role, 'reviewer'))).orderBy(asc(changePeople.login)).all();
  return { state: row.state, draft: row.draft, head: row.headCommit, title: row.title.slice(0, 300), checks: row.checks,
    failing: checks.filter(check => check.state === 'failing').map(check => check.name.slice(0, 100)), running: checks.filter(check => check.state === 'running').map(check => check.name.slice(0, 100)),
    review: row.review, reviewers: reviewers.map(person => person.login), mergeable: row.mergeable, url: row.url };
}
const kept = ({ url: _url, ...facts }: ChangeFacts & { url: string }): ChangeFacts => facts;
const lastFacts = (db: DataDatabase, trigger: string): ChangeFacts | undefined =>
  parseFacts(db.select({ note: triggerLog.note }).from(triggerLog).where(and(eq(triggerLog.trigger, trigger), eq(triggerLog.event, WAKE_FACTS))).orderBy(desc(triggerLog.seq)).get()?.note);

/** The agent a wake was asked by, as the rules read it now: narrowed to the member whose work it was, where the
 * trigger is recorded as that member's (shared-tempo-access.ts, recordedTrigger). */
const wakeReader = (t: Trigger): Viewer => ({ kind: 'agent', id: t.to!, ...(t.ownerKind === 'member' && t.owner ? { workingFor: t.owner } : {}) });

/** What happened, said from the records under the asking agent's own read rules as they stand now, or nothing when
 * what the wake waits for has not happened yet. One that may no longer read what it watched is told only that the
 * watch ended. */
function whatHappened(db: DataDatabase, t: Trigger, watched: Watched, event: string, now: string): { happened: string; link?: string | null } | undefined {
  const condition = wakeCondition(t), clause = wakeClause(watched, condition);
  if (watched.kind === 'time') return { happened: `It is ${now}: the time you asked to be woken at.` };
  if (!watchAllowed(db, wakeReader(t), t.sourceKind, t.watches)) return { happened: WATCH_ENDED };
  const byHand = event.startsWith('manual:'), old = Date.parse(now) - Date.parse(t.createdAt) >= WAKE_MS;
  if (watched.kind === 'change') {
    const read = changeFacts(db, watched.id);
    if (!read) return { happened: WATCH_ENDED };
    const before = lastFacts(db, t.id), name = changeName(watched.id);
    const happened = changeHappened(condition ?? 'changed', name, before, read);
    if (happened) return { happened: `${happened} Now: ${standsNow(read)}.`, link: read.url };
    if (old) return { happened: `${watchExpired(clause)} Now: ${standsNow(read)}.`, link: read.url };
    if (byHand) return { happened: `This wait was fired by hand before ${clause}. Now: ${standsNow(read)}.`, link: read.url };
    // Not yet. What was read is kept, so the next reading is compared with this one and "before" is this.
    if (factsDiffer(before, kept(read))) logTrigger(db, now, t.id, WAKE_FACTS, JSON.stringify(kept(read)));
    return undefined;
  }
  if (watched.kind === 'job') {
    const job = db.select().from(jobs).where(eq(jobs.id, watched.id)).get();
    if (job?.endedAt && !(unendedJobStates as readonly string[]).includes(job.state))
      return { happened: `Job ${job.id}${job.title ? ` (${JSON.stringify(job.title.slice(0, 120))})` : ''} ended: ${job.state}.${job.endedNote ? ` loom's note: ${job.endedNote.slice(0, 300)}` : ''}`, link: job.conversation ? `conversation ${job.conversation}` : null };
  } else if (watched.kind === 'approval') {
    const card = db.select().from(approvals).where(eq(approvals.id, watched.id)).get();
    if (card?.decidedAt && ['allowed', 'denied', 'used'].includes(card.state))
      return { happened: `${card.decidedBy ? titled(card.decidedBy) : 'Somebody'} answered: ${card.state === 'denied' ? 'Deny' : 'Allow'}. The card asked: ${JSON.stringify(card.ask.slice(0, 300))}`, link: `approval ${card.id}` };
  } else if (watched.kind === 'question') {
    const item = db.select().from(inbox).where(eq(inbox.id, watched.id)).get();
    // The answer's own words are mail in the conversation the question was asked in; a wake says only that it came.
    if (item?.answeredAt && item.state === 'answered')
      return { happened: `${item.answeredBy ? titled(item.answeredBy) : 'Somebody'} answered: ${item.answer === 'yes' ? 'Yes' : item.answer === 'no' ? 'No' : item.answer === 'dismiss' ? 'dismissed it' : item.answer === 'done' ? 'Done' : 'in words (they are mail in the conversation it was asked in)'}.`, link: `question ${item.id}` };
  } else {
    const request = db.select().from(secretRequests).where(eq(secretRequests.id, watched.id)).get();
    if (request?.answeredAt && ['allowed', 'denied', 'revoked'].includes(request.state))
      return { happened: `${request.answeredBy ? titled(request.answeredBy) : 'Somebody'} answered the request for the secret ${JSON.stringify(request.secret.slice(0, 100))}: ${request.state === 'allowed' ? 'Allow' : request.state === 'denied' ? 'Deny' : 'Allow, since taken back'}.`, link: `secret request ${request.id}` };
  }
  if (old) return { happened: watchExpired(clause) };
  return byHand ? { happened: `This wait was fired by hand before ${clause}.` } : undefined;
}

type Session =
  /** A body is awake in the conversation the wake was asked from. */
  | { is: 'awake'; cv: Conversation }
  /** The conversation is there and nothing is awake in it. */
  | { is: 'asleep'; cv: Conversation }
  /** There is no session to resume, and why, in words for the agent. */
  | { is: 'gone'; cv?: Conversation; why: string };
const terminalAwake = (db: DataDatabase, conversation: string, now: string) => db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.conversation, conversation), eq(jobs.startedByKind, 'terminal'),
  eq(jobs.state, 'running'), gt(jobs.heardAt, new Date(Date.parse(now) - terminalSilenceMs).toISOString()))).get();
/** Step 1 of the owner's rule: the session a wake belongs to is the conversation it was asked from. It is `gone`
 * when it was asked from none, when the conversation is no longer there or no longer this agent's, when its
 * Comms thread is archived or deleted, when its Discord or Slack place can no longer be posted to, and when it
 * is a terminal session that has ended: loom cannot start somebody's terminal. */
export function wakeSession(db: DataDatabase, t: Trigger, now: string): Session {
  if (!t.conversation) return { is: 'gone', why: 'it was asked for outside any conversation' };
  const cv = db.select().from(conversations).where(eq(conversations.id, t.conversation)).get();
  if (!cv || cv.agent !== t.to) return { is: 'gone', why: 'the conversation it was asked from is gone' };
  if (cv.venue === 'terminal') return terminalAwake(db, cv.id, now) ? { is: 'awake', cv } : { is: 'gone', cv, why: 'the terminal session it was asked from has ended, and loom cannot start a terminal' };
  if (cv.venue === 'loom') {
    const thread = db.select({ archivedAt: threads.archivedAt }).from(threads).where(eq(threads.conversation, cv.id)).get();
    if (!thread || thread.archivedAt) return { is: 'gone', cv, why: `the thread it was asked from was ${thread ? 'archived' : 'deleted'}` };
  }
  if (isBridgeVenue(cv.venue)) { const closed = placeClosed(db, cv); if (closed) return { is: 'gone', cv, why: `nothing can be posted where it was asked from (${closed})` }; }
  return db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.conversation, cv.id), inArray(jobs.state, unendedJobStates))).get() ? { is: 'awake', cv } : { is: 'asleep', cv };
}

export interface WakeDelivery {
  db: DataDatabase; now(): string;
  conversations: Pick<Conversations, 'open' | 'send' | 'resolveItem'>;
}
const askerOf = (t: Trigger): Asker | undefined => t.askedByKind && t.askedBy ? { kind: t.askedByKind, id: t.askedBy } : undefined;
/** Mail from the schedule to the agent in one of its conversations, on the word of whoever asked. This is the one
 * path by which anything loom itself says reaches an agent's body, and it is not new: a trigger's firing in a
 * conversation and a person's message arrive the same way (core/conversations, `send`; runtime/jobs.ts, admission). */
function mail(d: WakeDelivery, t: Trigger, cv: { id: string }, id: string, words: string, also: string[] = []): void {
  const asker = askerOf(t);
  d.conversations.send({ toKind: 'agent', to: t.to!, conversation: cv.id, source: 'trigger', sourceId: id, fromKind: 'schedule', fromId: t.owner ?? undefined,
    words, agent: t.to!, refs: [t.id, ...also], ...(asker && asker.kind !== 'agent' ? { onWordKind: asker.kind, onWord: asker.id } : {}) });
}
/** Step 2: a body is awake in that conversation, so the message is relayed in as its input.
 *
 * How input reaches a body that is awake, today:
 *  - A runtime body takes its conversation's mail once, as it starts its turn (core/conversations/body-input.ts).
 *    Mail that arrives after that is not pushed into the turn: admission keeps it and starts the conversation's
 *    next job with it the moment this one ends (runtime/jobs.ts, Admission.behind), and that job continues the
 *    kept session. So the relay for a runtime body is this mail, read by the same session at its next turn.
 *  - A terminal session's turns do not flow through the runtime at all. Its hook reports each turn
 *    (`terminal.session`), and that report's answer hands back the wakes waiting for the session
 *    (takeTerminalWakes): the hook shows them to the agent at that turn boundary. One nobody picks up within
 *    `terminalSilenceMs` goes to step 4 (rehomeTerminalWakes). */
function relayToAwakeBody(d: WakeDelivery, t: Trigger, cv: Conversation, id: string, words: string): void { mail(d, t, cv, id, words); }
/** Step 3: the conversation is there and nothing is awake in it, so loom brings it up: the wake is mail there,
 * and waiting mail is what starts a job in a conversation (settle.ts, then runtime/jobs.ts admission), exactly as
 * a person's new message or a trigger's firing does. */
function bringUp(d: WakeDelivery, t: Trigger, cv: Conversation, id: string, words: string): void { mail(d, t, cv, id, words); }
/** Step 4: there is no session to resume, so loom starts a new conversation for the agent with the right
 * information: what was asked and when, the note to self, what changed, and which conversation it continues.
 * It is the wake's own conversation, as any agent trigger's firing has (core/tempo/tempo.ts, wakePlace). It is
 * private to the member the old one was private to, unless they are a household owner, whose work is the
 * agent's own; a member who may no longer be worked for gets none, and the agent's people are told. */
function startAnew(d: WakeDelivery, t: Trigger, session: Extract<Session, { is: 'gone' }>, id: string, words: string): void | 'stop' {
  const { db } = d, agent = t.to!, sharing = sharedSharing(db), asker = askerOf(t);
  const whose = t.conversation ? session.cv?.member ?? (session.cv ? null : asker?.kind === 'member' ? asker.id : null) : t.member;
  const member = whose && !isHouseholdOwner({ kind: 'member', id: whose }, sharing) ? whose : undefined;
  if (member !== undefined && !mayRunPrivateWork({ agent, member, project: t.project ?? undefined }, sharing))
    return stopped(d, t, id, `the member ${member}, whose work it was, no longer has ${agent} or is not in its project`);
  const opened = d.conversations.open({ agent, venue: 'wake', place: wakePlace(t.id, member), label: t.note.slice(0, 200), project: t.project, ...(member === undefined ? {} : { member }) });
  if ((opened.member ?? undefined) !== member) throw new Error('The conversation at this wake\'s place belongs to other work');
  mail(d, t, opened, id, `${words}\n\nThis is a new conversation: ${session.why}.${session.cv ? ` It continues conversation ${session.cv.id}.` : ''}`, session.cv ? [session.cv.id] : []);
}
/** A wake that can no longer be delivered at all is stopped, and the agent's people are told once, as for any
 * trigger that names a conversation (core/tempo/tempo.ts). */
function stopped(d: WakeDelivery, t: Trigger, id: string, why: string): 'stop' {
  for (const member of tellOwners(d.db, t.to!)) d.conversations.send({ toKind: 'person', to: member, member, source: 'notice', sourceId: `wake-stopped:${id}`, fromKind: 'schedule',
    words: `A wake ${t.to} asked for was stopped and not delivered: ${why}. It was: ${JSON.stringify(t.note)}. Its note, in the words of whoever set it and not loom's: ${JSON.stringify(t.instructions ?? '')}`, refs: [t.id] });
  return 'stop';
}

/** The owner's rule, for every wake: find the session it belongs to; if a body is awake there, relay the message
 * in; if nothing is awake there, bring it up; if there is no session to resume, start a new one with the right
 * information. Called in the firing's own transaction (core/tempo/triggers.ts, fire): it writes records and
 * starts no body itself. `wait`: what the wake waits for has not happened yet. */
export function deliverWake(d: WakeDelivery, t: Trigger, occurrence: string): void | 'stop' | 'wait' {
  const { db } = d, now = d.now(), agent = t.to!, watched = watchedOf(t);
  if (t.toKind !== 'agent' || !watched) throw new Error('A wake is for an agent, about something it named');
  const said = whatHappened(db, t, watched, occurrence.slice(t.id.length + 1), now);
  if (!said) return 'wait';
  const asker = askerOf(t), others = !!asker && wordReach(db, agent, asker) === 'others';
  const say = (also?: string) => wakeWords({ clause: wakeClause(watched, wakeCondition(t)), askedAt: t.askedAt ?? t.createdAt, askedBy: !asker || asker.kind === 'agent' ? 'You' : `You, on the word of ${named(asker)},`,
    happened: said.happened, link: said.link, note: t.instructions, also });
  // Whoever asked must still be known to the agent, as for every firing on somebody's word (shared-place-triggers.ts, placeFiring).
  if (asker && !stillKnown(db, agent, asker)) return stopped(d, t, occurrence, `${named(asker)}, who asked for it, is no longer known to ${agent}`);
  // 1. Find the session the wake belongs to: the conversation it was asked from.
  const session = wakeSession(db, t, now);
  if (session.is !== 'gone') {
    const refused = privateRefusal(session.cv.member, asker); if (refused) return stopped(d, t, occurrence, refused);
    // On a bridge nobody there wrote this, so the body's answer is a post of its own (runtime/body-program.ts), and it is told so.
    const words = say(isBridgeVenue(session.cv.venue) ? 'What you answer is posted in this conversation as a new message.' : undefined);
    // 2. A body is awake in it: relay the message in.
    if (session.is === 'awake') return relayToAwakeBody(d, t, session.cv, occurrence, words);
    // 3. Nothing is awake in it: loom brings it up.
    return bringUp(d, t, session.cv, occurrence, words);
  }
  // A job on anybody else's word comes back only into the shared place it worked in (policy.ts, maySchedule): with
  // that place gone its wake starts nothing anywhere else, and the agent's people are told.
  if (others) return stopped(d, t, occurrence, `${session.why}, and ${named(asker!)}, who asked for it, is not one of ${agent}'s owners`);
  // 4. No session to resume: a new conversation, with the right information.
  return startAnew(d, t, session, occurrence, say());
}

const waitingWakes = (db: DataDatabase, conversation?: string) => db.select({ item: inbox, cv: conversations, trigger: triggers }).from(inbox)
  .innerJoin(conversations, and(eq(conversations.id, inbox.conversation), eq(conversations.venue, 'terminal')))
  .innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id)).innerJoin(triggers, and(eq(triggers.id, inboxRefs.ref), eq(triggers.targetKind, 'inbox'), wakeTargets))
  .where(and(eq(inbox.state, 'waiting'), eq(inbox.toKind, 'agent'), eq(inbox.source, 'trigger'), eq(inbox.fromKind, 'schedule'), ne(inbox.volume, 'mute'),
    conversation === undefined ? undefined : eq(inbox.conversation, conversation))).orderBy(asc(inbox.at), asc(inbox.seq)).all();
/** How many wakes one report of a terminal session is handed. */
export const TERMINAL_WAKES_MOST = 10;
/** The return path to a live terminal session: the wakes waiting in its conversation, handed to the hook in the
 * answer to its own report (shared-terminal-session.ts) and closed as taken by that session. Only a hook that says
 * it shows them is handed any: one that does not would lose them. */
export function takeTerminalWakes(d: Pick<WakeDelivery, 'db'> & { conversations: Pick<Conversations, 'handOver'> }, conversation: string, job: string): { id: string; at: string; words: string }[] {
  return d.db.transaction(() => d.conversations.handOver(waitingWakes(d.db, conversation).slice(0, TERMINAL_WAKES_MOST).map(row => row.item.id), job)
    .map(item => ({ id: item.id, at: item.at, words: item.words ?? '' })));
}
/** A wake relayed to a terminal session waits for that session's hook at most `terminalSilenceMs`, the silence
 * after which loom calls a terminal session over; one whose session has ended does not wait at all. Then step 4
 * applies: a new conversation with the same words. Asked on the runtime's own tick; writes nothing when nothing
 * is overdue. Answers how many it moved. */
export function rehomeTerminalWakes(d: WakeDelivery): number {
  const { db } = d, now = d.now();
  return db.transaction(() => {
    let moved = 0;
    for (const row of waitingWakes(db)) {
      const live = terminalAwake(db, row.cv.id, now);
      if (live && Date.parse(now) - Date.parse(row.item.at) < terminalSilenceMs) continue;
      d.conversations.resolveItem(row.item.id, live ? 'Its terminal session did not pick it up' : 'Its terminal session ended before picking it up');
      startAnew(d, row.trigger, { is: 'gone', cv: row.cv, why: live ? 'the terminal session it was asked from did not pick it up' : 'the terminal session it was asked from ended before picking it up' },
        `${row.item.sourceId ?? row.item.id}:anew`, row.item.words ?? '');
      moved++;
    }
    return moved;
  });
}
/** A wait lives WAKE_DAYS at most. One still standing after that is fired by hand here, and its delivery says the
 * watch ended (whatHappened). A time is not a watch: it fires at its time. Writes nothing when none is old. */
export function expireWakes(db: DataDatabase, engine: Pick<TriggerEngine, 'runNow'>, now: string): number {
  const cutoff = new Date(Date.parse(now) - WAKE_MS).toISOString();
  const old = db.select({ id: triggers.id }).from(triggers).where(and(eq(triggers.enabled, true), eq(triggers.state, 'standing'), eq(triggers.targetKind, 'inbox'), wakeTargets,
    ne(triggers.sourceKind, 'time'), lte(triggers.createdAt, cutoff))).all();
  let ended = 0;
  for (const row of old) { try { engine.runNow(row.id); ended++; } catch { /* held or gone meanwhile: asked again on the next tick */ } }
  return ended;
}

export interface WakeDoor {
  /** The caller as a trigger is judged for it (shared-tempo.ts, judgedAs). */
  judgedAs(viewer: Viewer): Viewer;
  /** The caller's job and conversation, when it is the body of a live job. */
  bodyWork(viewer: Viewer): Work | undefined;
  /** The job a body's credential is bound to, whatever state it is in. */
  bodyJob(viewer: Viewer): { job: { id: string } } | undefined;
  /** The machine, member and agent of a terminal credential. */
  terminal?(viewer: Viewer): { agent: string; member: string; machine: string } | undefined;
  /** The refusals `tempo.set` makes of the same caller, asked in the same order (core/tempo/operations.ts). */
  heldRefusal(viewer: Viewer): string | undefined;
  wordRefusal(viewer: Viewer, trigger: NewTrigger): string | undefined;
  /** Told once the trigger is set, as for any trigger. */
  stood(viewer: Viewer, trigger: Trigger): void;
  /** The household's GitHub read and the Changes cache, for a pull request loom does not track yet. Without it
   * only tracked ones can be watched. */
  changes?: { read: PullRequestReader; put(change: Change): unknown };
}
const refuse = (code: 'denied' | 'invalid' | 'conflict' | 'not-found' | 'unavailable', message: string): never => { throw new OperationError(code, message); };

/** `tempo.wake`: wake me when. It makes a once-only trigger for the asking agent, aimed at the conversation it asks
 * from, and answers the trigger's id and a plain sentence of what will happen. */
export function registerWake(operations: Operations, db: DataDatabase, clock: Clock, engine: Pick<TriggerEngine, 'set'>, door: WakeDoor): void {
  const now = () => new Date(clock.now()).toISOString();
  /** The conversation the caller is in: a body's own; for any other session of the agent, the one it names, which
   * must be this agent's and one the caller reads; and for a terminal credential that names none, its one live
   * session. Nothing when there is none: such a wake starts a new conversation. */
  const conversationOf = (viewer: Viewer & { kind: 'agent' }, given: string | undefined): Conversation | undefined => {
    const work = door.bodyWork(viewer);
    if (!work && door.bodyJob(viewer)) return refuse('denied', 'Current conversation body required');
    if (work) return given !== undefined && given !== work.cv.id ? refuse('denied', 'A body asks to be woken in the conversation it is working in') : work.cv;
    if (given !== undefined) {
      const cv = db.select().from(conversations).where(eq(conversations.id, given)).get();
      return cv && cv.agent === viewer.id && canReadSharedConversation(db, viewer, given) ? cv : refuse('denied', 'That is not a conversation you are in');
    }
    const scope = door.terminal?.(viewer);
    if (!scope) return undefined;
    const live = db.select({ conversation: jobs.conversation }).from(terminalSessions).innerJoin(jobs, eq(jobs.id, terminalSessions.job))
      .where(and(eq(terminalSessions.machine, scope.machine), eq(terminalSessions.member, scope.member), eq(terminalSessions.agent, scope.agent),
        eq(jobs.state, 'running'), gt(jobs.heardAt, new Date(clock.now() - terminalSilenceMs).toISOString()))).all();
    if (live.length > 1) return refuse('invalid', 'Several terminal sessions of yours are live on this machine: say which with `conversation` (the session\'s hook is told it)');
    return live[0]?.conversation ? db.select().from(conversations).where(eq(conversations.id, live[0].conversation)).get() : undefined;
  };
  const build = (viewer: Viewer & { kind: 'agent' }, input: WakeInput) => {
    let watched: Watched;
    try { watched = readWatched(input.what, clock.now()); } catch (error) { return refuse('invalid', error instanceof Error ? error.message : 'Say what to watch'); }
    if (input.when && watched.kind !== 'change') return refuse('invalid', 'A condition (`when`) is for a pull request');
    const condition = watched.kind === 'change' ? input.when ?? 'changed' : undefined, cv = conversationOf(viewer, input.conversation);
    const trigger: NewTrigger = { ownerKind: 'agent', owner: viewer.id, sourceKind: watched.sourceKind, watches: watchName(watched), times: watched.kind === 'time' ? watched.at : null,
      lifespan: 'once', targetKind: 'inbox', target: wakeTarget(condition), toKind: 'agent', to: viewer.id, project: cv?.project ?? null,
      instructions: input.note?.trim() ? input.note : null, note: wakeTitle(viewer.id, watched, condition), conversation: cv?.id ?? null };
    return { watched, condition, cv, trigger };
  };
  operations.register(operation({ name: 'tempo.wake', write: true, recheckPolicy: true, refuses: true, input: wakeInput,
    output: z.object({ id: z.string(), says: z.string() }).strict(),
    may(viewer, input) {
      if (viewer.kind !== 'agent') return false;
      let built: ReturnType<typeof build>;
      // What cannot be read as a wake at all is refused by `run`, in words that say why.
      try { built = build(viewer, input); } catch { return true; }
      return wakeAllowed(db, door.judgedAs(viewer), built.trigger, true);
    },
    /** The one outside read: a pull request the cache does not hold is read with the household's GitHub sign-in
     * before the write. Nothing is kept from it unless `run` then sets the wake. */
    async prepare(input, { viewer }) {
      let watched: Watched;
      // A caller `run` refuses whatever is found reads nothing outside.
      if (viewer.kind !== 'agent' || door.heldRefusal(viewer)) return undefined;
      try { watched = readWatched(input.what, clock.now()); } catch { return undefined; }
      if (watched.kind !== 'change' || db.select({ id: changes.id }).from(changes).where(eq(changes.id, watched.id)).get()) return undefined;
      if (!door.changes) return { unreadable: true };
      try { return { change: (await door.changes.read(watched.repository, clock.now())).find(change => change.id === watched.id) ?? null }; }
      catch { return { unreadable: true }; }
    },
    run(ctx, input, prepared) {
      const viewer = ctx.viewer;
      if (viewer.kind !== 'agent') return refuse('denied', 'Only an agent asks to be woken');
      const held = door.heldRefusal(viewer); if (held) return refuse('denied', held);
      const { watched, condition, cv, trigger } = build(viewer, input), agent = viewer.id, judged = door.judgedAs(viewer);
      const refused = door.wordRefusal(viewer, trigger); if (refused) return refuse('denied', refused);
      const pending = db.select({ id: triggers.id }).from(triggers).where(and(eq(triggers.enabled, true), eq(triggers.toKind, 'agent'), eq(triggers.to, agent), eq(triggers.targetKind, 'inbox'), wakeTargets)).all().length;
      if (pending >= WAKES_MAX) return refuse('conflict', `You already have ${WAKES_MAX} waits pending. Cancel one first (tempo.stop).`);
      let facts: ReturnType<typeof changeFacts>;
      if (watched.kind === 'change') {
        const name = changeName(watched.id);
        // A pull request loom does not track yet becomes tracked here, in this write: its row is stored as Changes
        // stores any, and from then on the one poller keeps it fresh because a standing trigger watches it
        // (apps/changes.ts, watchedChanges). A refusal below takes the row back out with the rest of the write.
        if (!db.select({ id: changes.id }).from(changes).where(eq(changes.id, watched.id)).get()) {
          const found = prepared as { unreadable?: boolean; change?: Change | null } | undefined;
          if (!door.changes || !found || found.unreadable) return refuse('unavailable', `The household's GitHub sign-in cannot read ${watched.repository}, so loom cannot watch ${name}.`);
          if (!found.change) return refuse('not-found', `The household's GitHub sign-in finds no pull request ${name} that is open or was closed in the last week.`);
          door.changes.put(found.change); ctx.changed('changes', watched.id);
        }
        if (!wakeAllowed(db, judged, trigger)) return refuse('denied', `${name} is not a pull request you may read.`);
        facts = changeFacts(db, watched.id)!;
        if (facts.state !== 'open') return refuse('invalid', `${name} is already ${facts.state === 'merged' ? 'merged' : 'closed'}: there is nothing left to wait for.`);
      } else if (!wakeAllowed(db, judged, trigger)) return refuse('denied', 'That is not something you may read, so loom cannot watch it for you.');
      const work = door.bodyWork(viewer);
      // Recorded as any trigger is: for a member who is not a household owner, as that member's (recordedTrigger).
      const as = recordedTrigger(db, judged, trigger);
      const asked = cv ? asking(db, viewer, agent, work) : undefined;
      // One member's private conversation is named only on that member's word, or by the agent's own work.
      if (cv && privateRefusal(cv.member, asked)) return refuse('denied', PRIVATE_PLACE_REFUSAL);
      const row = engine.set({ ...as.trigger, id: `tr-wake-${randomUUID()}` }, cv ? undefined : as.member, asked);
      if (watched.kind === 'change') {
        // The watch begins from what the change is now: its snapshot for the source (sources.ts), and what this wake compares with.
        const at = now(), snapshot = changeSnapshot(db, watched.id);
        if (snapshot) logTrigger(db, at, row.id, SOURCE_SNAPSHOT, snapshot);
        logTrigger(db, at, row.id, WAKE_FACTS, JSON.stringify(kept(facts!)));
      }
      door.stood(viewer, row); ctx.changed('triggers', row.id);
      const where = !cv ? 'in a new conversation' : work || cv.venue !== 'terminal' ? 'in this conversation' : 'in this terminal session, or in a new conversation if it has ended';
      return { id: row.id, says: `I'll wake you ${where} ${watched.kind === 'time' ? `at ${watched.at}` : `when ${wakeClause(watched, condition)}`}.`
        + (facts ? ` Right now: ${standsNow(facts)}.` : '') + (watched.kind === 'time' ? '' : ` If that has not happened in ${WAKE_DAYS} days the wait ends and says so.`) + ` To cancel: tempo.stop ${row.id}.` };
    },
  }));
}
