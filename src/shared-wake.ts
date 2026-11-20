import { stopEmptyWakeJob, withdrawWakeMail } from './core/conversations/wake-delivery.js';
import { activeWakes, changeWake, endWake, insertWake, newestWakeRead, occurrence, recordNewestWakeRead, wakeForMail, type Wake } from './core/tempo/wake-store.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from './core/clock.js';
import { DAY_MS } from './core/day.js';
import type { Conversations } from './core/conversations/index.js';
import type { DataDatabase } from './core/data/database.js';
import { approvals, changes, conversations, inbox, jobs, projectRepositories, wakes } from './core/data/schema.js';
import { jobUnended } from './core/data/job-states.js';
import { operation, OperationError, type Operations } from './core/operations/index.js';
import { changeHappened, changeName, finished, readWatched, storedWatch, wakeClause, wakeInput, WAKE_MS, WAKE_WORDS_MAX, WAKES_PER_CONVERSATION, WATCH_ENDED, type ChangeFacts, type Watched } from './core/tempo/wake.js';
import { observeWakeSources, wakeReadOrder, type WakeSource } from './core/tempo/wake-sources.js';
import type { WakePullReader } from './pieces/changes/github.js';
import type { Change } from './pieces/changes/model.js';
import { holds, inHousehold, tableRules, type Asker, type Viewer } from './policy.js';
import { wakeWordAllowed } from './shared-place-mail.js';
import { isWakeMail, WAKE_CLOSED, wakeBlocked, wakeConversationClosed, wakeThread } from './core/tempo/wake-mail.js';
import { asking } from './shared-place-triggers.js';
import { conversationQuestionPolicy } from './shared-conversation-questions.js';
import { sharedSharing } from './shared-sharing.js';

type Conversation = typeof conversations.$inferSelect;
type Work = { cv: Conversation; job: Pick<typeof jobs.$inferSelect, 'id' | 'agent' | 'conversation'> };
type Reading = { facts: ChangeFacts; updated: number; readAt: number; order?: ReturnType<typeof wakeReadOrder>; fingerprint: string; finishedHeads: string[]; checks?: Change['checks']['contexts']; ready?: string };
const BODY_REQUIRED = 'Only a runtime body in its own conversation can use wakes.';
const WATCH_REFUSAL = 'That is not something you can watch.';
const CANCEL_REFUSAL = 'That is not one of your waits.';
const UNDELIVERED = 'The watch ended after 14 days because the wake could not be delivered.';
const EXPIRED = 'The watch ended after 14 days.';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = (message: string): never => { throw new OperationError('denied', message); };

function watchable(db: DataDatabase, cv: Conversation, word: Asker, job: string, watched: Watched): 'cached' | 'repository' | undefined {
  const key = watched.kind === 'time' ? watched.at : watched.id;
  switch (watched.kind) {
    case 'time': return 'cached';
    case 'job': {
      const row = db.select().from(jobs).where(eq(jobs.id, key)).get();
      return row && (row.conversation === cv.id || row.startedByKind === 'job' && row.startedBy === job) ? 'cached' : undefined;
    }
    case 'approval': return db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.id, key), eq(approvals.conversation, cv.id))).get() ? 'cached' : undefined;
    case 'question': {
      const item = db.select({ kind: inbox.waitsOnKind }).from(inbox).where(and(eq(inbox.id, key), eq(inbox.conversation, cv.id),
        eq(inbox.source, 'thread'), eq(inbox.fromKind, 'agent'), eq(inbox.fromId, cv.agent), sql`${inbox.answers} is not null`)).get();
      if (!item || item.kind === 'secret-request') return;
      const viewer: Viewer = word.kind === 'member' ? { kind: 'member', id: word.id } : { kind: 'agent', id: cv.agent };
      return conversationQuestionPolicy(db).sourceAllowsItem(viewer, key) ? 'cached' : undefined;
    }
    case 'change': {
      const sharing = sharedSharing(db);
      const project = cv.project && sharing.projects[cv.project];
      if (word.kind === 'outside' || !project || !project.agents.includes(cv.agent)) return;
      // Apply the same reader policy with the member's current reach on their word.
      const viewer: Viewer = { kind: 'agent', id: cv.agent, ...(word.kind === 'member' ? { workingFor: word.id } : {}) };
      if (!inHousehold(viewer, sharing)) return;
      const rows = db.select().from(projectRepositories).where(inArray(projectRepositories.repository, [watched.repository, `github:${watched.repository}`])).all();
      if (!rows.some(row => row.project === cv.project)) return;
      const row = db.select().from(changes).where(eq(changes.id, key)).get();
      if (row) {
        // The Change ID uses the requested repository. The forge URL still names the returned one.
        const returned = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(row.url)?.[1];
        return row.project === cv.project && (returned === undefined || returned === watched.repository)
          && holds(tableRules.changes, viewer, row, sharing) ? 'cached' : undefined;
      }
      return new Set(rows.map(row => row.project)).size === 1 ? 'repository' : undefined;
    }
  }
}

function canReadWake(db: DataDatabase, cv: Conversation, wake: Wake) {
  return wake.conversation === cv.id && wake.agent === cv.agent && wakeWordAllowed(db, cv, wake.onWord)
    && !!watchable(db, cv, wake.onWord, wake.job, storedWatch(wake.kind, wake.key));
}

function deliveryDeadline(wake: Wake, mailed: number) {
  const expires = Date.parse(wake.askedAt) + WAKE_MS;
  // A due time first seen after downtime gets one delivery window.
  return wake.kind === 'time' && wake.attempt === 1 && mailed >= expires ? mailed + DAY_MS : expires;
}

/** Recheck the watched subject and the asker's word at the body's input door. */
export function mayReleaseWake(db: DataDatabase, cv: Conversation, item: typeof inbox.$inferSelect, now: number) {
  if (!isWakeMail(item)) return true;
  const wake = wakeForMail(db, item.sourceId);
  return !!wake && !wakeConversationClosed(db, cv) && canReadWake(db, cv, wake)
    && (wake.state === 'fired' || wake.state === 'delivering' && now < deliveryDeadline(wake, Date.parse(item.at)));
}

const names = (values: string[]) => [...new Set(values)].sort();
function checkFingerprint(checks: Reading['checks']) {
  return checks?.map(check => JSON.stringify([check.name, check.status, check.conclusion])).sort();
}
function reading(facts: ChangeFacts, updated: string | null, readAt: number, text: string, people: unknown, checks: Reading['checks'], order: ReturnType<typeof wakeReadOrder>): Reading {
  const sourceUpdated = Date.parse(updated ?? '') || 0;
  return { facts, updated: sourceUpdated, readAt, order,
    checks, fingerprint: digest([facts, sourceUpdated, text, people, checkFingerprint(checks)]), finishedHeads: finished(facts) ? [facts.head] : [] };
}

function freshReading(c: Change, readAt: number, order: ReturnType<typeof wakeReadOrder>): Reading {
  return reading({ state: c.state, draft: c.draft, head: c.head.id, title: c.title, checks: c.checks.state,
    failing: names(c.checks.failing), running: names(c.checks.running),
    review: c.review.state, reviewers: names(c.people.filter(person => person.role === 'reviewer').map(person => person.login)),
    mergeable: c.mergeable }, c.updated, readAt, c.body, names([...c.people.map(p => p.role + ':' + p.login), 'author:' + c.author.login]), c.checks.contexts, order);

}

function older(next: Pick<Reading, 'readAt' | 'updated' | 'order'>, before: Pick<Reading, 'readAt' | 'updated' | 'order'>) {
  return next.updated < before.updated || next.readAt < before.readAt ||
    (next.order && before.order && next.order.process === before.order.process && next.order.sequence < before.order.sequence);
}

export function installWakes(db: DataDatabase, clock: Clock, operations: Operations, mail: Conversations,
  body: (viewer: Viewer) => Work | undefined, read?: WakePullReader) {
  const stamp = () => new Date(clock.now()).toISOString();
  const waiting = eq(wakes.state, 'waiting');
  const end = (wake: Wake, why: string) => endWake(db, wake, stamp(), why);
  const delivery = (wake: Wake) => db.select().from(inbox).where(and(eq(inbox.conversation, wake.conversation),
    eq(inbox.source, 'notice'), eq(inbox.fromKind, 'schedule'), eq(inbox.sourceId, occurrence(wake)))).get();

  function deliver(wake: Wake, words: string) {
    const attempt = wake.attempt + 1;
    const ready = wake.kind === 'change' ? { reading: JSON.stringify({
      ...JSON.parse(wake.reading ?? wake.baseline ?? '{}'), ready: words,
    }) } : {};
    if (!changeWake(db, wake, { ...ready, state: 'delivering', attempt })) return;
    mail.send({ toKind: 'agent', to: wake.agent, conversation: wake.conversation, source: 'notice', sourceId: occurrence({ id: wake.id, attempt }),
      fromKind: 'schedule', thread: wakeThread(db, wake.conversation)?.id, words: ('Wake from loom. ' + words).slice(0, WAKE_WORDS_MAX - (wake.note?.length ?? 0) - 2) + (wake.note ? '\n\n' + wake.note : ''),
      ...(wake.onWord.kind !== 'agent' ? { onWordKind: wake.onWord.kind, onWord: wake.onWord.id } : {}) });
  }

  function checkDelivery(wake: Wake) {
    const item = delivery(wake);
    const cv = db.select().from(conversations).where(eq(conversations.id, wake.conversation)).get();
    const deadline = deliveryDeadline(wake, item ? Date.parse(item.at) : 0);
    const reason = !cv || wakeConversationClosed(db, cv) ? WAKE_CLOSED
      : !canReadWake(db, cv, wake) ? WATCH_ENDED
      : clock.now() >= deadline ? UNDELIVERED : undefined;
    const job = item?.job ? db.select().from(jobs).where(eq(jobs.id, item.job)).get() : undefined;
    if (!reason && item?.state === 'waiting' && item.volume !== 'mute' && (!item.job || job && jobUnended(job.state))
      && !wakeBlocked(db, wake.agent)) return;
    if (item) {
      const why = reason ?? 'The wake will be tried again.';
      withdrawWakeMail(db, item, stamp(), why);
      stopEmptyWakeJob(db, item.job, stamp(), why);
    }
    if (reason) end(wake, reason);
    else changeWake(db, wake, { state: 'waiting' });
  }
  function outcome(watched: Watched, at: number): string | undefined {
    const id = watched.kind === 'time' ? watched.at : watched.id;
    switch (watched.kind) {
      case 'time': return Date.parse(id) <= at ? `It is ${id}.` : undefined;
      case 'job': {
        const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
        return row?.endedAt && !jobUnended(row.state) ? `Job ${id} ended with state ${row.state}.` : undefined;
      }
      case 'approval': {
        const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
        return row?.decidedAt && ['allowed', 'denied', 'used'].includes(row.state) ? `Approval ${id} was ${row.state === 'used' ? 'allowed' : row.state}.` : undefined;
      }
      case 'question': {
        const row = db.select().from(inbox).where(eq(inbox.id, id)).get();
        return row?.answeredAt && row.state === 'answered' ? `Question ${id} was answered.` : undefined;
      }
    }
  }
  function evaluate(wake: Wake, event?: WakeSource) {
    const at = clock.now();
    const expired = at - Date.parse(wake.askedAt) >= WAKE_MS;
    const due = wake.kind === 'time' && Date.parse(wake.key) <= at;
    if (expired && (wake.attempt || !due)) return end(wake, wake.attempt ? UNDELIVERED : EXPIRED);
    const cv = db.select().from(conversations).where(eq(conversations.id, wake.conversation)).get();
    if (!cv || cv.agent !== wake.agent || wakeConversationClosed(db, cv)) return end(wake, WAKE_CLOSED);
    if (!wakeWordAllowed(db, cv, wake.onWord)) return end(wake, WATCH_ENDED);
    const watched = storedWatch(wake.kind, wake.key);
    if (!watchable(db, cv, wake.onWord, wake.job, watched)) return end(wake, WATCH_ENDED);

    const blocked = wakeBlocked(db, wake.agent);
    if (expired && blocked) return end(wake, EXPIRED);
    const before = JSON.parse(wake.reading ?? wake.baseline ?? 'null') as Reading | null;
    if (event?.kind === 'change') {
      if (watched.kind === 'change' && event.change.sourceRepository !== undefined && event.change.sourceRepository !== watched.repository) return end(wake, WATCH_ENDED);
      if (wake.attempt && before?.ready) return; // A failed occurrence is retried on the next sweep.
      const baseline = JSON.parse(wake.baseline ?? 'null') as Reading | null;
      const next = freshReading(event.change, event.readAt, event.order);
      if (before && (older(next, before) || next.fingerprint === before.fingerprint)) {
        if (before.ready && !blocked) deliver(wake, before.ready);
        return;
      }
      const condition = wake.condition ?? 'changed';
      let words: string | undefined;
      if (condition === 'checks-finished') {
        const seen = before?.finishedHeads ?? [];
        next.finishedHeads = seen;
        if (finished(next.facts) && !seen.includes(next.facts.head)) {
          next.finishedHeads = [...seen, next.facts.head].slice(-20);
          words = changeHappened(condition, changeName(wake.key), before?.facts, next.facts);
        }
      } else if (condition !== 'changed' || next.fingerprint !== baseline?.fingerprint) {
        words = changeHappened(condition, changeName(wake.key), condition === 'changed' ? baseline?.facts : before?.facts, next.facts);
      }
      if (before?.facts.head === next.facts.head) words ??= before.ready;
      if (!words && next.facts.state !== 'open') return end(wake, 'The watch ended because the pull request closed.');
      if (words) next.ready = words;
      const recorded = { ...wake, reading: JSON.stringify(next) };
      if (words && !blocked) deliver(recorded, words);
      else changeWake(db, wake, { reading: recorded.reading });
      return;
    }
    if (blocked) return;
    const ready = before?.ready && (wake.attempt || newestWakeRead(db, wake.key)?.head === before.facts.head) ? before.ready : undefined;
    const words = ready ?? outcome(watched, at);
    if (words) deliver(wake, words);
  }
  function recordRead(key: string, reading: Reading) {
    const newest = newestWakeRead(db, key);
    if (newest && older(reading, newest)) return null;
    const next = { head: reading.facts.head, updated: reading.updated, readAt: reading.readAt, order: reading.order };
    recordNewestWakeRead(db, key, next);
    return next;
  }

  const close = observeWakeSources(db, event => {
    if (event.kind === 'agent-removed' || event.kind === 'member-removed') {
      const affected = event.kind === 'agent-removed' ? eq(wakes.agent, event.id)
        : sql`json_extract(${wakes.onWord}, '$.kind') = 'member' and json_extract(${wakes.onWord}, '$.id') = ${event.id}`;
      for (const wake of db.select().from(wakes).where(and(activeWakes, affected)).all()) {
        const item = wake.state === 'delivering' && delivery(wake);
        if (item) withdrawWakeMail(db, item, stamp(), WATCH_ENDED);
        end(wake, WATCH_ENDED);
      }
      return;
    }
    if (event.kind === 'change' && (event.change.sourceRepository === undefined || event.id === `github:${event.change.sourceRepository}#${event.change.number}`)) {
      if (!recordRead(event.id, freshReading(event.change, event.readAt, event.order))) return;
    }
    for (const wake of db.select().from(wakes).where(and(waiting, eq(wakes.kind, event.kind), eq(wakes.key, event.id))).all()) evaluate(wake, event);
  });
  const current = (viewer: Viewer) => {
    const work = body(viewer);
    return work?.cv.venue === 'loom' ? work : refuse(BODY_REQUIRED);
  };
  const receiptPartition = (viewer: Viewer) => {
    const { cv, job } = current(viewer);
    return JSON.stringify([cv.id, job.id]);
  };
  function allowed(viewer: Viewer, input: z.infer<typeof wakeInput>) {
    const { cv, job } = current(viewer);
    const word = asking(db, viewer, cv.agent, { cv, job });
    if (wakeConversationClosed(db, cv) || !wakeWordAllowed(db, cv, word)) refuse(WATCH_REFUSAL);
    const watched = readWatched(input.what, clock.now());
    if (input.when && watched.kind !== 'change') throw new OperationError('invalid', 'A condition is for a pull request.');
    if (!watchable(db, cv, word, job.id, watched)) refuse(WATCH_REFUSAL);
    const pending = (filter: ReturnType<typeof eq>) => db.select({ n: count() }).from(wakes).where(and(activeWakes, filter)).get()!.n;
    if (pending(eq(wakes.conversation, cv.id)) >= WAKES_PER_CONVERSATION)
      throw new OperationError('conflict', 'Too many waiting wakes.');
    return { cv, job, word, watched };
  }
  operations.register(operation({
    name: 'tempo.wake', input: wakeInput, output: z.object({ id: z.string() }), write: true, refuses: true,
    receiptPartition, may: () => true,
    async prepare(input, { viewer }) {
      const { watched } = allowed(viewer, input);
      if (watched.kind !== 'change') return;
      // The project's authorized repository may be read even when the number doesn't exist.
      // Requests outside that scope were refused above, before any forge call.
      const at = clock.now(), order = wakeReadOrder();
      try {
        const change = await read?.(watched.repository, Number(watched.id.split('#')[1]), at);
        return change && change.id === watched.id && change.repo === `github:${watched.repository}`
          && (change.sourceRepository ?? watched.repository) === watched.repository ? freshReading(change, at, order) : null;
      } catch { return null; }
    },
    run({ viewer }, input, prepared) {
      const { cv, job, word, watched } = allowed(viewer, input);
      const key = watched.kind === 'time' ? watched.at : watched.id;
      const baseline = watched.kind === 'change' ? prepared as Reading | null : null;
      if (watched.kind === 'change' && !baseline) refuse(WATCH_REFUSAL);
      if (baseline?.facts.state && baseline.facts.state !== 'open' || outcome(watched, clock.now()))
        throw new OperationError('invalid', 'That has already happened.');
      const id = `wake-${randomUUID()}`;
      const newest = baseline ? recordRead(key, baseline) : null;
      if (baseline && !newest) refuse(WATCH_REFUSAL);
      insertWake(db, { newest, id, agent: cv.agent, conversation: cv.id, job: job.id, onWord: word, kind: watched.kind, key,
        condition: watched.kind === 'change' ? input.when ?? 'changed' : null, note: input.note,
        baseline: baseline ? JSON.stringify(baseline) : null, state: 'waiting', askedAt: stamp() });
      return { id };
    },
  }));
  operations.register(operation({
    name: 'tempo.waits', input: z.object({}).strict(), output: z.array(z.object({ id: z.string(), what: z.string().nullable(), note: z.string().nullable(), state: z.enum(wakes.state.enumValues), why: z.string().nullable() })),
    may: () => true,
    run({ viewer }) {
      const { cv } = current(viewer);
      const here = eq(wakes.conversation, cv.id);
      const since = new Date(clock.now() - DAY_MS).toISOString();
      const pending = db.select().from(wakes).where(and(here, activeWakes)).orderBy(asc(wakes.askedAt), asc(wakes.id)).all();
      const recent = db.select().from(wakes).where(and(here, gte(wakes.endedAt, since))).orderBy(desc(wakes.endedAt), asc(wakes.id)).all();
      return [...pending, ...recent].map(wake => ({ id: wake.id, state: wake.state, why: wake.why,
        what: wake.key ? wakeClause(storedWatch(wake.kind, wake.key), wake.condition ?? undefined) : null, note: wake.note }));
    },
  }));
  operations.register(operation({
    name: 'tempo.wakeCancel', input: z.object({ id: z.string().min(1).max(200) }).strict(), output: z.object({ saved: z.literal(true) }),
    write: true, receiptPartition, may: () => true,
    run({ viewer }, { id }) {
      const { cv } = current(viewer);
      const wake = db.select().from(wakes).where(and(waiting, eq(wakes.conversation, cv.id), eq(wakes.id, id))).get() ?? refuse(CANCEL_REFUSAL);
      end(wake, 'The watch was cancelled.');
      return { saved: true };
    },
  }));
  return {
    close,
    sweep() {
      const pending = db.select().from(wakes).where(activeWakes).all();
      for (const wake of pending) {
        if (wake.state === 'delivering') checkDelivery(wake);
        else evaluate(wake);
      }
    },
  };
}
