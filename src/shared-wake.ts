import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from './core/clock.js';
import type { Conversations } from './core/conversations/index.js';
import type { DataDatabase } from './core/data/database.js';
import { agentPauses, approvals, changeChecks, changePeople, changes, conversations, deletedThreads, inbox, jobs, projectRepositories, threads, wakes } from './core/data/schema.js';
import { jobUnended } from './core/data/job-states.js';
import { operation, OperationError, type Operations } from './core/operations/index.js';
import { changeHappened, changeName, finished, readWatched, storedWatch, wakeClause, wakeInput, WAKE_MS, WAKE_WORDS_MAX, WAKES_MAX, WAKES_PER_CONVERSATION, WATCH_ENDED, type ChangeFacts, type Watched } from './core/tempo/wake.js';
import { observeWakeSources, type WakeSource } from './core/tempo/wake-sources.js';
import type { PullRequestReader } from './apps/changes.js';
import type { Change } from './pieces/changes/model.js';
import { holds, inHousehold, mayRunPrivateWork, tableRules, type Asker, type Viewer } from './policy.js';
import { isBridgeVenue, placeClosed, privateRefusal, stillKnown } from './shared-place-mail.js';
import { asking } from './shared-place-triggers.js';
import { conversationQuestionPolicy } from './shared-conversation-questions.js';
import { sharedSharing } from './shared-sharing.js';

type Wake = typeof wakes.$inferSelect;
type Conversation = typeof conversations.$inferSelect;
type Work = { cv: Conversation; job: Pick<typeof jobs.$inferSelect, 'id' | 'agent' | 'conversation'> };
type Reading = { facts: ChangeFacts; updated: number; readAt: number; fingerprint: string; finishedHead: string | null; rerunning: boolean };
const BODY_REQUIRED = 'Only a runtime body in its own conversation can use wakes.';
const WATCH_REFUSAL = 'That is not something you can watch.';
const CANCEL_REFUSAL = 'That is not one of your waits.';
const EXPIRED = 'The watch ended after 14 days.';
const CLOSED = 'The watch ended because its conversation closed.';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = (message: string): never => { throw new OperationError('denied', message); };

function livePlace(db: DataDatabase, cv: Conversation, word: Asker): string | undefined {
  if (db.select({ id: deletedThreads.id }).from(deletedThreads).where(eq(deletedThreads.conversation, cv.id)).get()
      || db.select({ archivedAt: threads.archivedAt }).from(threads).where(eq(threads.conversation, cv.id)).get()?.archivedAt
      || isBridgeVenue(cv.venue) && placeClosed(db, cv)) return CLOSED;
  const sharing = sharedSharing(db);
  if (!sharing.agents?.includes(cv.agent) || !stillKnown(db, cv.agent, word) || privateRefusal(cv.member, word)) return WATCH_ENDED;
  if (word.kind === 'member' && !mayRunPrivateWork({ agent: cv.agent, member: word.id, project: cv.project ?? undefined }, sharing)) return WATCH_ENDED;
  if (cv.project && !sharing.projects[cv.project]?.agents.includes(cv.agent)) return WATCH_ENDED;
}

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

const names = (values: string[]) => [...new Set(values)].sort();
function reading(facts: ChangeFacts, updated: string | null, readAt: number, text: string, people: unknown): Reading {
  const sourceUpdated = Date.parse(updated ?? '') || 0;
  return { facts, updated: sourceUpdated, readAt,
    fingerprint: digest([facts, sourceUpdated, text, people]), finishedHead: finished(facts) ? facts.head : null, rerunning: false };
}

function freshReading(c: Change, readAt: number): Reading {
  return reading({ state: c.state, draft: c.draft, head: c.head.id, title: c.title, checks: c.checks.state,
    failing: names(c.checks.failing), running: names(c.checks.running),
    review: c.review.state, reviewers: names(c.people.filter(person => person.role === 'reviewer').map(person => person.login)),
    mergeable: c.mergeable }, c.updated, readAt, c.body, names([...c.people.map(p => p.role + ':' + p.login), 'author:' + c.author.login]));
}

function cachedReading(db: DataDatabase, id: string, readAt: number): Reading | undefined {
  const row = db.select().from(changes).where(eq(changes.id, id)).get();
  if (!row) return;
  const checks = db.select().from(changeChecks).where(eq(changeChecks.change, id)).all();
  const people = db.select().from(changePeople).where(eq(changePeople.change, id)).all();
  return reading({ state: row.state, draft: row.draft, head: row.headCommit, title: row.title, checks: row.checks,
    failing: names(checks.filter(c => c.state === 'failing').map(c => c.name)), running: names(checks.filter(c => c.state === 'running').map(c => c.name)),
    review: row.review, reviewers: names(people.filter(p => p.role === 'reviewer').map(p => p.login)),
    mergeable: row.mergeable }, row.updatedAt, readAt, row.body, names(people.map(p => p.role + ':' + p.login)));
}

export function installWakes(db: DataDatabase, clock: Clock, operations: Operations, mail: Conversations,
  body: (viewer: Viewer) => Work | undefined, read?: PullRequestReader) {
  const stamp = () => new Date(clock.now()).toISOString();
  const waiting = eq(wakes.state, 'waiting');
  function end(wake: Wake, why: string) {
    db.update(wakes).set({ state: 'ended', endedAt: stamp(), why }).where(and(eq(wakes.id, wake.id), waiting)).run();
  }
  function fire(wake: Wake, words: string) {
    db.update(wakes).set({ state: 'fired', endedAt: stamp() }).where(and(eq(wakes.id, wake.id), waiting)).run();
    // Conversation mail starts the next job. Its deduplication key is the wake itself.
    mail.send({ toKind: 'agent', to: wake.agent, conversation: wake.conversation, source: 'notice', sourceId: wake.id,
      fromKind: 'schedule', words: ('Wake from loom. ' + words).slice(0, WAKE_WORDS_MAX - (wake.note?.length ?? 0) - 2) + (wake.note ? '\n\n' + wake.note : ''),
      ...(wake.onWord.kind !== 'agent' ? { onWordKind: wake.onWord.kind, onWord: wake.onWord.id } : {}) });
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
    if (at - Date.parse(wake.askedAt) >= WAKE_MS) return end(wake, EXPIRED);
    const cv = db.select().from(conversations).where(eq(conversations.id, wake.conversation)).get();
    if (!cv || cv.agent !== wake.agent) return end(wake, CLOSED);
    const closed = livePlace(db, cv, wake.onWord);
    if (closed) return end(wake, closed);
    const watched = storedWatch(wake.kind, wake.key);
    if (!watchable(db, cv, wake.onWord, wake.job, watched)) return end(wake, WATCH_ENDED);

    if (event?.kind === 'change') {
      if (watched.kind === 'change' && event.change.sourceRepository !== undefined && event.change.sourceRepository !== watched.repository) return end(wake, WATCH_ENDED);
      const before = JSON.parse(wake.reading ?? wake.baseline ?? 'null') as Reading | null;
      const baseline = JSON.parse(wake.baseline ?? 'null') as Reading | null;
      const next = freshReading(event.change, event.readAt);
      if (before && (next.updated < before.updated || next.readAt < before.readAt
          || next.fingerprint === before.fingerprint)) return;
      const condition = wake.condition ?? 'changed';
      let words: string | undefined;
      if (condition === 'checks-finished') {
        const sameHead = before?.facts.head === next.facts.head;
        const reported = sameHead ? before.finishedHead : null;
        next.finishedHead = finished(next.facts) ? next.facts.head : reported;
        next.rerunning = !!(sameHead && reported && (before.rerunning || next.facts.running.length || next.facts.checks === 'running'));
        if (finished(next.facts) && (!reported || next.rerunning))
          words = changeHappened(condition, changeName(wake.key), before?.facts, next.facts);
      } else if (condition !== 'changed' || next.fingerprint !== baseline?.fingerprint) {
        words = changeHappened(condition, changeName(wake.key), condition === 'changed' ? baseline?.facts : before?.facts, next.facts);
      }
      if (words) fire(wake, words);
      else if (next.facts.state !== 'open') end(wake, 'The watch ended because the pull request closed.');
      else db.update(wakes).set({ reading: JSON.stringify(next) }).where(and(eq(wakes.id, wake.id), waiting)).run();
      return;
    }
    if (wake.kind === 'time' && db.select().from(agentPauses).where(eq(agentPauses.agent, wake.agent)).get()) return;
    const words = outcome(watched, at);
    if (words) fire(wake, words);
  }
  const close = observeWakeSources(db, event => {
    if (event.kind === 'agent-removed' || event.kind === 'member-removed') {
      const affected = event.kind === 'agent-removed' ? eq(wakes.agent, event.id)
        : sql`json_extract(${wakes.onWord}, '$.kind') = 'member' and json_extract(${wakes.onWord}, '$.id') = ${event.id}`;
      for (const wake of db.select().from(wakes).where(and(waiting, affected)).all()) end(wake, WATCH_ENDED);
      return;
    }
    for (const wake of db.select().from(wakes).where(and(waiting, eq(wakes.kind, event.kind), eq(wakes.key, event.id))).all()) evaluate(wake, event);
  });
  const current = (viewer: Viewer) => body(viewer) ?? refuse(BODY_REQUIRED);
  const receiptPartition = (viewer: Viewer) => {
    const { cv, job } = current(viewer);
    return JSON.stringify([cv.id, job.id]);
  };
  function allowed(viewer: Viewer, input: z.infer<typeof wakeInput>) {
    const { cv, job } = current(viewer);
    const word = asking(db, viewer, cv.agent, { cv, job });
    if (livePlace(db, cv, word)) refuse(WATCH_REFUSAL);
    const watched = readWatched(input.what, clock.now());
    if (input.when && watched.kind !== 'change') throw new OperationError('invalid', 'A condition is for a pull request.');
    const way = watchable(db, cv, word, job.id, watched) ?? refuse(WATCH_REFUSAL);
    const pending = (filter: ReturnType<typeof eq>) => db.select({ n: count() }).from(wakes).where(and(waiting, filter)).get()!.n;
    if (pending(eq(wakes.conversation, cv.id)) >= WAKES_PER_CONVERSATION || pending(eq(wakes.agent, cv.agent)) >= WAKES_MAX)
      throw new OperationError('conflict', 'Too many waiting wakes.');
    return { cv, job, word, watched, way };
  }
  operations.register(operation({
    name: 'tempo.wake', input: wakeInput, output: z.object({ id: z.string() }), write: true, refuses: true,
    receiptPartition, may: () => true,
    async prepare(input, { viewer }) {
      const { way, watched } = allowed(viewer, input);
      if (way !== 'repository' || watched.kind !== 'change') return;
      const at = clock.now();
      try {
        const change = (await read?.(watched.repository, at))?.find(c => c.id === watched.id && c.repo === `github:${watched.repository}` && (c.sourceRepository ?? watched.repository) === watched.repository);
        return change ? freshReading(change, at) : null;
      } catch { return null; }
    },
    run({ viewer }, input, prepared) {
      const { cv, job, word, watched, way } = allowed(viewer, input);
      const key = watched.kind === 'time' ? watched.at : watched.id;
      const baseline = watched.kind === 'change'
        ? way === 'cached' ? cachedReading(db, key, clock.now()) : prepared as Reading | null
        : null;
      if (watched.kind === 'change' && !baseline) refuse(WATCH_REFUSAL);
      if (baseline?.facts.state && baseline.facts.state !== 'open' || outcome(watched, clock.now()))
        throw new OperationError('invalid', 'That has already happened.');
      const id = `wake-${randomUUID()}`;
      db.insert(wakes).values({ id, agent: cv.agent, conversation: cv.id, job: job.id, onWord: word, kind: watched.kind, key,
        condition: watched.kind === 'change' ? input.when ?? 'changed' : null, note: input.note,
        baseline: baseline ? JSON.stringify(baseline) : null, state: 'waiting', askedAt: stamp() }).run();
      return { id };
    },
  }));
  operations.register(operation({
    name: 'tempo.waits', input: z.object({}).strict(), output: z.array(z.object({ id: z.string(), what: z.string(), note: z.string().nullable() })),
    may: () => true,
    run({ viewer }) {
      const { cv } = current(viewer);
      return db.select().from(wakes).where(and(waiting, eq(wakes.conversation, cv.id))).orderBy(asc(wakes.askedAt), asc(wakes.id)).all()
        .map(wake => ({ id: wake.id, what: wakeClause(storedWatch(wake.kind, wake.key), wake.condition ?? undefined), note: wake.note }));
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
      const at = stamp(), old = new Date(clock.now() - WAKE_MS).toISOString();
      for (const wake of db.select().from(wakes).where(and(waiting, or(lte(wakes.askedAt, old), and(eq(wakes.kind, 'time'), lte(wakes.key, at))))).all()) evaluate(wake);
    },
  };
}
