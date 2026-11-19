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
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
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
import { TIME_EXPIRED, WAIT_ENDED_BARE, WAKES_MAX, WAKE_DAYS, WAKE_FACTS, WAKE_MS, WATCH_ENDED, changeHappened, changeName, factsDiffer, parseFacts, readWatched, standsNow, wakeClause, wakeCondition,
  wakeInput, wakeRows, wakeTarget, wakeTitle, wakeWords, wakesFull, watchExpired, watchName, watchedOf, type ChangeFacts, type WakeInput, type Watched } from './core/tempo/wake.js';
import { mayRunPrivateWork, membersWithAgent, workPrincipal, type Asker, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { PRIVATE_PLACE_REFUSAL, isBridgeVenue, named, placeClosed, privateRefusal, stillKnown, tellOwners, wordReach } from './shared-place-mail.js';
import { asking } from './shared-place-triggers.js';
import { maySetWake, pullWatchable, recordedTrigger, watchAllowed } from './shared-tempo-access.js';
import type { Change } from './pieces/changes/model.js';
import type { PullRequestReader } from './apps/changes.js';

type Conversation = typeof conversations.$inferSelect;
type Work = { cv: Conversation; job: { id: string; agent: string; conversation: string | null } };
const titled = (id: string) => id ? id[0].toUpperCase() + id.slice(1) : id;
/** When a wait was asked: what its life is measured from. */
const askedAt = (t: Trigger): string => t.askedAt ?? t.createdAt;

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
  // `expired:` is the sweep ending a wait that is past its life (expireWakes): it always says so, and never waits.
  const byHand = event.startsWith('manual:'), expired = event.startsWith('expired:'), old = expired || Date.parse(now) - Date.parse(askedAt(t)) >= WAKE_MS;
  if (watched.kind === 'time') return { happened: expired ? TIME_EXPIRED : byHand ? `This wait was fired by hand before ${clause}.` : `It is ${now}: the time you asked to be woken at.` };
  if (!watchAllowed(db, wakeReader(t), t.sourceKind, t.watches)) return { happened: WATCH_ENDED };
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

/** The agent's note to itself is kept with the conversation the wake belongs to, never on the trigger. A trigger
 * is read by household owners, by everybody in its project and by everybody who has its agent (policy.ts,
 * `trigger`), which is wider than one member's private conversation; an inbox item is read with its conversation
 * (`inTalk`). So the note is an item there, closed as it is written: it waits for nobody, starts nothing, and is
 * read back by its trigger's id when the wake fires. */
const noteSource = (trigger: string): string => `wake-note:${trigger}`;
export function keepNote(d: WakeDelivery, t: { id: string; to: string }, conversation: string, note: string): void {
  const item = d.conversations.send({ toKind: 'agent', to: t.to, conversation, source: 'trigger', sourceId: noteSource(t.id), fromKind: 'agent', fromId: t.to, words: note, agent: t.to, refs: [t.id] });
  d.conversations.resolveItem(item.id, 'A note kept for a wake');
}
const keptNote = (db: DataDatabase, t: Trigger): string | null =>
  db.select({ words: inbox.words }).from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.to, t.to!), eq(inbox.source, 'trigger'), eq(inbox.sourceId, noteSource(t.id)))).get()?.words ?? null;

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
/** The labels the policy reads a conversation by (policy.ts, `conversation`): a member's private one is that
 * member's and the agent's own with them; a direct one with no member is the agent's owners'; any other is read
 * by household owners, its project and whoever has the agent. Nothing else decides who reads one. */
type Labels = { member: string | null; direct: boolean; project: string | null };
/** Whether a wake asked in this conversation may be re-homed when the conversation can no longer take it, and if
 * so with what labels. Both must hold for the new conversation, which is the wake's own (`venue: 'wake'`):
 *  - nobody reads it who could not read the old one. It carries the old one's labels exactly, and the read rule is
 *    a function of those labels and the agent alone;
 *  - a job started in it works on the same principal as a job started in the old one would (policy.ts,
 *    `workPrincipal`, asked of both: never reasoned from the labels). A principal decides whose standing approval
 *    rules answer the job's cards. A conversation with a member keeps that member as its principal. A place with
 *    no member that is not a lane (a bridge channel, a group or direct message with nobody's label, a hand-off for
 *    nobody) is nobody's account, and a `wake` conversation with no member is the agent's own: so a wake asked in
 *    such a place is never re-homed, or its job would get answers no rule gives the work it came from
 *    (policy.ts, rulesPerson). A closed shared place means the wake ends.
 * Answers the labels, or why not. */
export function rehome(agent: string, old: Pick<Conversation, 'member' | 'direct' | 'project' | 'venue'>): { labels: Labels } | { why: string } {
  const labels: Labels = { member: old.member, direct: old.direct, project: old.project };
  return workPrincipal(agent, old) === workPrincipal(agent, { member: labels.member, venue: 'wake' }) ? { labels }
    : { why: 'the place it was asked in is closed, and work started anywhere else would not be on the same account' };
}
/** Step 4: there is no session to resume, so loom starts a new conversation for the agent with the right
 * information: what was asked and when, the note to self, what changed, and which conversation it continues.
 *
 * The new conversation is never readable by anybody who could not read the one it replaces. It is the wake's own
 * conversation (core/tempo/tempo.ts, wakePlace) carrying exactly the old one's labels: its member, whether that
 * member is a household owner or not, its directness and its project. The read rule is a function of those labels
 * and the agent alone, so the same people read the new one as read the old, and nobody else. A wake asked outside
 * any conversation is private to the member recorded on it when it was asked (the agent's one owner).
 *
 * And a job started in it works on the same principal as one started in the old conversation would (rehome).
 *
 * Where either cannot be had, the wake's words are not delivered at all (undelivered): the old conversation's row
 * is gone, so its labels are not known; its member may no longer be worked for; or it was a shared place with no
 * member, whose work is nobody's account while a wake conversation's would be the agent's own. */
function startAnew(d: WakeDelivery, t: Trigger, session: Extract<Session, { is: 'gone' }>, id: string, words: string): void | 'stop' {
  const { db } = d, agent = t.to!;
  let labels: Labels;
  if (t.conversation) {
    if (!session.cv) return undelivered(d, t, id, 'the conversation it was asked from is gone, so nowhere as private can be made');
    const home = rehome(agent, session.cv);
    if ('why' in home) return undelivered(d, t, id, home.why);
    labels = home.labels;
  } else {
    if (!t.member) return undelivered(d, t, id, 'it was asked outside any conversation and names nobody to be private to');
    labels = { member: t.member, direct: false, project: t.project };
  }
  if (labels.member && !mayRunPrivateWork({ agent, member: labels.member, project: labels.project ?? undefined }, sharedSharing(db)))
    return undelivered(d, t, id, `the member ${labels.member}, whose conversation it was, no longer has ${agent} or is not in its project`);
  const opened = d.conversations.open({ agent, venue: 'wake', place: wakePlace(t.id, labels.member ?? undefined), label: t.note.slice(0, 200), ...labels });
  // A place is found, not made, when it exists: one with other labels is not this wake's, and takes none of its words.
  if (opened.member !== labels.member || opened.direct !== labels.direct || opened.project !== labels.project) throw new Error('The conversation at this wake\'s place belongs to other work');
  mail(d, t, opened, id, `${words}\n\nThis is a new conversation: ${session.why}.${session.cv ? ` It continues conversation ${session.cv.id}.` : ''}`, session.cv ? [session.cv.id] : []);
}
/** A wake whose words can go nowhere as private as where it was asked. The trigger is stopped and its log says
 * why. All that is said is one bare line, with no note, no subject and no conversation id, in a conversation
 * private to whoever asked: the member on whose word it was asked, or for the agent's own work the agent's one
 * owner. Where there is no such member, or they may not be worked for, nothing is said at all. */
function undelivered(d: WakeDelivery, t: Trigger, id: string, why: string): 'stop' {
  const { db } = d, agent = t.to!, sharing = sharedSharing(db), asker = askerOf(t), owners = membersWithAgent(agent, sharing);
  logTrigger(db, d.now(), t.id, 'undelivered', why.slice(0, 300));
  const member = asker?.kind === 'member' ? asker.id : asker?.kind === 'outside' ? undefined : owners.length === 1 ? owners[0] : undefined;
  if (member === undefined || !mayRunPrivateWork({ agent, member }, sharing)) return 'stop';
  const opened = d.conversations.open({ agent, venue: 'wake', place: wakePlace(t.id, member), label: 'A wait ended', member, direct: false, project: null });
  if (opened.member !== member) return 'stop';
  d.conversations.send({ toKind: 'agent', to: agent, conversation: opened.id, source: 'trigger', sourceId: id, fromKind: 'schedule', words: WAIT_ENDED_BARE, agent, refs: [t.id] });
  return 'stop';
}
/** A wake that is stopped because of who asked (somebody no longer known, or not one of the agent's owners with
 * their place gone): the agent's people are told that it was, and why. The notice carries nothing of the wake:
 * no note and no subject, since those people need not be able to read the conversation it was asked in. */
function stopped(d: WakeDelivery, t: Trigger, id: string, why: string): 'stop' {
  logTrigger(d.db, d.now(), t.id, 'undelivered', why.slice(0, 300));
  for (const member of tellOwners(d.db, t.to!)) d.conversations.send({ toKind: 'person', to: member, member, source: 'notice', sourceId: `wake-stopped:${id}`, fromKind: 'schedule',
    words: `A wait ${t.to} set was stopped and not delivered: ${why}.`, refs: [t.id] });
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
  const say = (also?: string) => wakeWords({ clause: wakeClause(watched, wakeCondition(t)), askedAt: askedAt(t), askedBy: !asker || asker.kind === 'agent' ? 'You' : `You, on the word of ${named(asker)},`,
    happened: said.happened, link: said.link, note: keptNote(db, t), also });
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
  // 4. No session to resume: a new conversation, no wider than the old one, with the right information.
  return startAnew(d, t, session, occurrence, say());
}

const waitingWakes = (db: DataDatabase, conversation?: string) => db.select({ item: inbox, cv: conversations, trigger: triggers }).from(inbox)
  .innerJoin(conversations, and(eq(conversations.id, inbox.conversation), eq(conversations.venue, 'terminal')))
  .innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id)).innerJoin(triggers, and(eq(triggers.id, inboxRefs.ref), wakeRows()))
  .where(and(eq(inbox.state, 'waiting'), eq(inbox.toKind, 'agent'), eq(inbox.source, 'trigger'), eq(inbox.fromKind, 'schedule'), ne(inbox.volume, 'mute'),
    conversation === undefined ? undefined : eq(inbox.conversation, conversation))).orderBy(asc(inbox.at), asc(inbox.seq)).all();
/** How many wakes one report of a terminal session is handed. */
export const TERMINAL_WAKES_MOST = 10;
/** The return path to a live terminal session: the wakes waiting in its conversation, handed to the hook in the
 * answer to its own report (shared-terminal-session.ts) and closed as taken by that session. Only a hook that says
 * it shows them is handed any, and only on a report the session accepted as its current instance's. */
export function takeTerminalWakes(d: Pick<WakeDelivery, 'db'> & { conversations: Pick<Conversations, 'handOver'> }, conversation: string, job: string): { id: string; at: string; words: string }[] {
  return d.db.transaction(() => d.conversations.handOver(waitingWakes(d.db, conversation).slice(0, TERMINAL_WAKES_MOST).map(row => row.item.id), job)
    .map(item => ({ id: item.id, at: item.at, words: item.words ?? '' })));
}
/** A wake relayed to a terminal session waits for that session's hook at most `terminalSilenceMs`, the silence
 * after which loom calls a terminal session over; one whose session has ended does not wait at all. Then step 4
 * applies: a new conversation with the same words, no wider than the terminal session's own. Asked on the
 * runtime's own tick; writes nothing when nothing is overdue. Answers how many it moved. */
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
/** A wait lives WAKE_DAYS at most, measured from when it was asked, whatever it watches and whatever state it is
 * in, and none ends silently. A time wake that has come due is fired, not ended: the engine is asked to look
 * first, so whichever of the two timers runs first the wake is delivered as itself. Every other old wait is
 * told that the watch ended, through the same delivery as any wake (deliverWake: the session it was asked from, or
 * a new one no wider), and then stopped with `expired` in its log; a held one too, since its agent being paused
 * is no reason to end it unsaid. After this none of them is enabled, so nothing is asked of one twice. Writes
 * nothing when none is old. Answers how many it ended or fired. */
export function expireWakes(d: WakeDelivery, engine: Pick<TriggerEngine, 'tick' | 'stop'>): number {
  const { db } = d, now = d.now();
  const stands = (id: string) => db.select().from(triggers).where(and(eq(triggers.id, id), eq(triggers.enabled, true))).get();
  const old = db.select().from(triggers).where(and(eq(triggers.enabled, true), wakeRows())).all().filter(t => Date.parse(now) - Date.parse(askedAt(t)) >= WAKE_MS);
  if (old.some(t => t.sourceKind === 'time' && t.state === 'standing' && !!t.nextDueAt && t.nextDueAt <= now)) engine.tick();
  for (const { id } of old) {
    const t = stands(id);
    if (!t) continue;
    try { db.transaction(() => { deliverWake(d, t, `${t.id}:expired:${now}`); }); } catch { /* nowhere to say it: the log below still does */ }
    engine.stop(t.id); logTrigger(db, now, t.id, 'expired', `Older than ${WAKE_DAYS} days`);
  }
  return old.length;
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
  /** What `tempo.stop` asks of the same caller for this trigger: whether it may stop it at all, and why not in words
   * about the caller (the word its job works on), if there is such a reason. */
  mayStop(viewer: Viewer, trigger: Trigger): boolean;
  stopRefusal(viewer: Viewer, trigger: Trigger): string | undefined;
  /** The household's GitHub read and the Changes cache, for a pull request the cache does not hold yet in a
   * repository loom reads. Without it only pull requests already held can be watched. */
  changes?: { read: PullRequestReader; put(change: Change): unknown };
}
const refuse = (code: 'denied' | 'invalid' | 'conflict' | 'not-found' | 'unavailable', message: string): never => { throw new OperationError(code, message); };
/** The one answer to a pull request the caller may not watch, whatever the reason: a repository loom does not read,
 * one it reads for a project the caller is not in, a pull request that does not exist, one that is somebody
 * else's, or one loom holds and the caller does not read. Nothing is read outside to give it. */
export const PULL_REFUSAL = 'That is not a pull request you can watch.';
/** The same, for a job or an ask: one it does not read and one that is not there are told apart by nothing. */
export const WATCH_REFUSAL = 'That is not something you can watch.';
export const NOT_YOUR_WAIT = 'That is not one of your waits.';
export const SESSION_NEEDED = 'Say which terminal session you are: pass `session` (your harness session id) or `conversation` (the conversation id terminal.session answered your hook).';
export const SESSION_REFUSAL = 'That is not a live terminal session of yours on this machine.';
export const NO_CONVERSATION_REFUSAL = 'This credential is in no conversation, so it names none. Asked this way, a wake starts a new conversation.';

/** `tempo.wake`: wake me when. It makes a once-only trigger for the asking agent, aimed at the conversation it asks
 * from, and answers the trigger's id and a plain sentence of what will happen. */
export function registerWake(operations: Operations, db: DataDatabase, clock: Clock, engine: Pick<TriggerEngine, 'set' | 'stop'>, d: WakeDelivery, door: WakeDoor): void {
  const now = () => new Date(clock.now()).toISOString();
  /** `tempo.wakeCancel`: cancel a wait. It stops only a pending wake that is the calling agent's own and that the
   * caller may stop as `tempo.stop` would let it. Anything else (another agent's wait, a schedule that is no wait,
   * one already over, an id that names nothing) gets one answer, which does not say whether the id exists. */
  operations.register(operation({ name: 'tempo.wakeCancel', write: true, recheckPolicy: true, refuses: true, input: z.object({ id: z.string().min(1).max(200) }).strict(),
    output: z.object({ saved: z.literal(true) }).strict(),
    may: viewer => viewer.kind === 'agent',
    run(ctx, input) {
      const wait = db.select().from(triggers).where(and(eq(triggers.id, input.id), eq(triggers.enabled, true), eq(triggers.toKind, 'agent'), eq(triggers.to, ctx.viewer.kind === 'agent' ? ctx.viewer.id : ''), wakeRows())).get();
      if (!wait || !door.mayStop(ctx.viewer, wait)) return refuse('denied', NOT_YOUR_WAIT);
      const refused = door.stopRefusal(ctx.viewer, wait); if (refused) return refuse('denied', refused);
      engine.stop(wait.id); ctx.changed('triggers', wait.id);
      return { saved: true as const };
    },
  }));
  /** Where the caller is, proven by its credential and never named freely:
   *  - a runtime body is in the conversation its job works in, and names no other;
   *  - a terminal credential is in a terminal session of its own machine, member and agent that is live now. It
   *    says which (two sessions of one credential are told apart by nothing else), and loom checks it. It is
   *    never guessed, so one session's wake cannot land in another;
   *  - any other credential of the agent is in no conversation. Its wake starts a new one (step 4), private to
   *    the one member who has the agent; with several owners or none there is nobody to be private to, and the
   *    wake is refused.
   * No credential aims a wake at a conversation of any other venue. */
  const placeOf = (viewer: Viewer & { kind: 'agent' }, input: WakeInput): { cv: Conversation; member?: undefined } | { cv?: undefined; member: string } => {
    const work = door.bodyWork(viewer), named = input.session !== undefined || input.conversation !== undefined;
    if (!work && door.bodyJob(viewer)) return refuse('denied', 'Current conversation body required');
    if (work) return input.session !== undefined || (input.conversation !== undefined && input.conversation !== work.cv.id) ? refuse('denied', 'A body is woken in the conversation it is working in, and names no other.') : { cv: work.cv };
    const scope = door.terminal?.(viewer);
    if (scope) {
      if (!named) return refuse('invalid', SESSION_NEEDED);
      const live = db.select({ session: terminalSessions.sessionId, conversation: jobs.conversation }).from(terminalSessions).innerJoin(jobs, eq(jobs.id, terminalSessions.job))
        .where(and(eq(terminalSessions.machine, scope.machine), eq(terminalSessions.member, scope.member), eq(terminalSessions.agent, scope.agent), eq(jobs.startedByKind, 'terminal'),
          eq(jobs.state, 'running'), gt(jobs.heardAt, new Date(clock.now() - terminalSilenceMs).toISOString()))).all()
        .filter(row => (input.session === undefined || row.session === input.session) && (input.conversation === undefined || row.conversation === input.conversation));
      const cv = live.length === 1 && live[0].conversation ? db.select().from(conversations).where(eq(conversations.id, live[0].conversation)).get() : undefined;
      return cv && cv.venue === 'terminal' && cv.agent === scope.agent && cv.member === scope.member ? { cv } : refuse('denied', SESSION_REFUSAL);
    }
    if (named) return refuse('denied', NO_CONVERSATION_REFUSAL);
    const owners = membersWithAgent(viewer.id, sharedSharing(db));
    if (owners.length !== 1) return refuse('invalid', owners.length ? `${viewer.id} has more than one owner, so loom cannot tell whose private conversation a wake asked outside any conversation belongs in. Ask from a conversation or a terminal session.`
      : `Nobody has ${viewer.id} on their list, so a wake asked outside any conversation has nobody's private conversation to go to. Ask from a conversation or a terminal session.`);
    return { member: owners[0] };
  };
  const build = (viewer: Viewer & { kind: 'agent' }, input: WakeInput) => {
    let watched: Watched;
    try { watched = readWatched(input.what, clock.now()); } catch (error) { return refuse('invalid', error instanceof Error ? error.message : 'Say what to watch'); }
    if (input.when && watched.kind !== 'change') return refuse('invalid', 'A condition (`when`) is for a pull request');
    const condition = watched.kind === 'change' ? input.when ?? 'changed' : undefined, place = placeOf(viewer, input), cv = place.cv;
    // The note is not on the trigger (keepNote): `instructions` stays empty, and `note` is the title Tempo shows.
    const trigger: NewTrigger = { ownerKind: 'agent', owner: viewer.id, sourceKind: watched.sourceKind, watches: watchName(watched), times: watched.kind === 'time' ? watched.at : null,
      lifespan: 'once', targetKind: 'inbox', target: wakeTarget(condition), toKind: 'agent', to: viewer.id, project: cv?.project ?? null,
      instructions: null, note: wakeTitle(viewer.id, watched, condition), conversation: cv?.id ?? null };
    return { watched, condition, place, cv, trigger };
  };
  /** Everything that is decided without the network, in the order `tempo.set` asks it, and before anything is read
   * outside: who is calling, the word its job works on, where it is, whether it may set the trigger, how many waits
   * it holds, on whose word it asks and whether that word may name the conversation, and whether it may watch what
   * it names. What is left for `run` alone needs the pull request itself: that it was found, that the caller reads
   * the stored row, and that it is still open. Throws the refusal. `prepare` asks it before its one outside
   * read, so a refused caller causes none; `run` asks it again, in the write. */
  const allowed = (viewer: Viewer, input: WakeInput) => {
    if (viewer.kind !== 'agent') return refuse('denied', 'Only an agent asks to be woken');
    const held = door.heldRefusal(viewer); if (held) return refuse('denied', held);
    const built = build(viewer, input), agent = viewer.id, judged = door.judgedAs(viewer);
    const refused = door.wordRefusal(viewer, built.trigger); if (refused) return refuse('denied', refused);
    if (!maySetWake(db, judged, built.trigger)) return refuse('denied', 'Permission denied');
    // Said here in the door's own words; the engine holds the same bound wherever a wake comes to stand (triggers.ts, wakeRoom).
    const pending = db.select({ n: sql<number>`count(*)` }).from(triggers).where(and(eq(triggers.enabled, true), eq(triggers.toKind, 'agent'), eq(triggers.to, agent), wakeRows())).get()!.n;
    if (pending >= WAKES_MAX) return refuse('conflict', wakesFull(agent));
    // Who is asking, for a wake that names a conversation: one member's private conversation is named only on that
    // member's word, or by the agent's own work.
    const work = door.bodyWork(viewer), asked = built.cv ? asking(db, viewer, agent, work) : undefined;
    if (built.cv && privateRefusal(built.cv.member, asked)) return refuse('denied', PRIVATE_PLACE_REFUSAL);
    const way = built.watched.kind === 'change' ? pullWatchable(db, judged, built.watched.id, built.watched.repository) : undefined;
    if (built.watched.kind === 'change' ? !way : !watchAllowed(db, judged, built.trigger.sourceKind, built.trigger.watches)) return refuse('denied', built.watched.kind === 'change' ? PULL_REFUSAL : WATCH_REFUSAL);
    return { ...built, agent, judged, way, work, asked };
  };
  operations.register(operation({ name: 'tempo.wake', write: true, recheckPolicy: true, refuses: true, input: wakeInput,
    output: z.object({ id: z.string(), says: z.string() }).strict(),
    // Who may call at all. Every refusal that depends on what is asked is made by `allowed`, in words that say why,
    // and the same words whatever the cause where the cause must not be learned.
    may: viewer => viewer.kind === 'agent',
    /** The one outside read: a pull request the cache does not hold, in a repository the caller may read, is read
     * with the household's GitHub sign-in before the write. `allowed` comes first and throws for everybody else,
     * so nothing is read for a caller who is then refused. Nothing is kept from the read unless `run` sets the wake. */
    async prepare(input, { viewer }) {
      const asked = allowed(viewer, input);
      if (asked.watched.kind !== 'change' || asked.way !== 'repository') return undefined;
      if (!door.changes) return { unreadable: true };
      const { id, repository } = asked.watched;
      try { return { change: (await door.changes.read(repository, clock.now())).find(change => change.id === id) ?? null }; }
      catch { return { unreadable: true }; }
    },
    run(ctx, input, prepared) {
      const { watched, condition, place, cv, trigger, agent, judged, way, work, asked } = allowed(ctx.viewer, input), viewer = ctx.viewer as Viewer & { kind: 'agent' };
      let facts: ReturnType<typeof changeFacts>;
      if (watched.kind === 'change') {
        const name = changeName(watched.id);
        // The caller reads this repository's pull requests, so it may be told how the read went. A pull request loom
        // did not hold yet is stored here as Changes stores any; its repository is a project's, which the one poller
        // already reads, so nothing else has to keep it fresh and no row exists that Changes would not have made.
        if (way === 'repository') {
          const found = prepared as { unreadable?: boolean; change?: Change | null } | undefined;
          if (!door.changes || !found || found.unreadable) return refuse('unavailable', `The household's GitHub sign-in could not read ${watched.repository} just now, so loom cannot watch ${name} yet.`);
          if (!found.change) return refuse('not-found', `There is no pull request ${name} that is open or was closed in the last week.`);
          door.changes.put(found.change); ctx.changed('changes', watched.id);
          // Asked again of the row itself, by the same rule. A refusal takes the row back out with the rest of the write.
          if (!watchAllowed(db, judged, trigger.sourceKind, trigger.watches)) return refuse('denied', PULL_REFUSAL);
        }
        facts = changeFacts(db, watched.id)!;
        if (facts.state !== 'open') return refuse('invalid', `${name} is already ${facts.state === 'merged' ? 'merged' : 'closed'}: there is nothing left to wait for.`);
      }
      // Recorded as any trigger is: for a member who is not a household owner, as that member's (recordedTrigger).
      const as = recordedTrigger(db, judged, trigger);
      const row = engine.set({ ...as.trigger, id: `tr-wake-${randomUUID()}` }, cv ? undefined : place.member, asked);
      if (watched.kind === 'change') {
        // The watch begins from what the change is now: its snapshot for the source (sources.ts), and what this wake compares with.
        const at = now(), snapshot = changeSnapshot(db, watched.id);
        if (snapshot) logTrigger(db, at, row.id, SOURCE_SNAPSHOT, snapshot);
        logTrigger(db, at, row.id, WAKE_FACTS, JSON.stringify(kept(facts!)));
      }
      if (input.note?.trim()) {
        // Kept where the wake will be read: the asking conversation, or the private one a wake asked outside any will start.
        const home = cv ?? d.conversations.open({ agent, venue: 'wake', place: wakePlace(row.id, place.member), label: row.note.slice(0, 200), member: place.member!, direct: false, project: null });
        if (!cv && home.member !== place.member) return refuse('conflict', 'The conversation at this wake\'s place belongs to other work');
        keepNote(d, { id: row.id, to: agent }, home.id, input.note);
      }
      door.stood(viewer, row); ctx.changed('triggers', row.id);
      const where = !cv ? `in a new conversation, private to ${place.member}` : work ? 'in this conversation' : 'in this terminal session, or in a new conversation if it has ended';
      return { id: row.id, says: `I'll wake you ${where} ${watched.kind === 'time' ? `at ${watched.at}` : `when ${wakeClause(watched, condition)}`}.`
        + (facts ? ` Right now: ${standsNow(facts)}.` : '') + (watched.kind === 'time' ? '' : ` If that has not happened in ${WAKE_DAYS} days the wait ends and says so.`) + ` To cancel: tempo.stop ${row.id}.` };
    },
  }));
}
