/** The work trace of a handed-off job, over the real doors (docs/specs/boards.md, "Sessions"): a body in a
 * handoff conversation reports a step, loom keeps it beside that conversation, and only the member of the
 * originating thread reads it. All people and words are fictional. */
import { afterEach, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as s from './core/data/schema.js';
import { reviewPlace } from './core/conversations/review-place.js';
import { JobTraceQueries, TRACE_PAGE_MAX, TRACE_STEPS_PER_CONVERSATION_MAX, TRACE_STEPS_PER_JOB_MAX, TRACE_TOOL_MAX } from './core/conversations/job-trace.js';
import { jobHeld } from './shared-place-mail.js';
import { TRACE_KEEP_DAYS } from './core/conversations/retention.js';
import { bodyFixture, bodyCredentials, credentialHash } from '../test/fixtures/conversation-body.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const childToken = 'body_' + 'c'.repeat(64), bobToken = 'n'.repeat(64), oliveToken = 'o'.repeat(64);
const expiredQuery = (conversation: string, job = 'child-job') => `{sessionTraceExpired(conversation:${JSON.stringify(conversation)},job:${JSON.stringify(job)})}`;
const step = { kind: 'card', clientId: 'step-1', words: 'PRIVATE STEP OUTPUT', tool: 'Terminal', cardState: 'done' };

async function fixture(place = reviewPlace('job', 'brief')) {
  const f = await bodyFixture(clean), at = () => new Date(f.clock.now()).toISOString();
  const child = f.root.writes.run(() => {
    // Another member with the same agent and project, and a full owner: neither is the thread's member.
    f.db.insert(s.memberAgents).values({ member: 'bob', agent: 'art' }).run();
    f.db.insert(s.projectMembers).values({ project: 'pond', member: 'bob' }).run();
    f.db.insert(s.members).values({ id: 'olive', role: 'owner', fullOwner: true, joinedAt: at() }).run();
    f.db.insert(s.memberAgents).values({ member: 'olive', agent: 'art' }).run();
    const cv = f.root.services.conversations.open({ agent: 'art', member: 'alice', project: 'pond', venue: 'handoff', place, label: 'Compare fictional pumps', direct: false });
    const parent = f.db.select().from(s.jobs).where(eq(s.jobs.id, 'job')).get()!;
    f.db.insert(s.jobs).values({ ...parent, id: 'child-job', conversation: cv.id, title: 'Child' }).run();
    f.db.insert(s.tokens).values([
      { fingerprint: credentialHash(childToken), label: 'Child body', kind: 'agent', agent: 'art', job: 'child-job', createdAt: at() },
      { fingerprint: credentialHash(bobToken), label: 'Bob', kind: 'owner', member: 'bob', createdAt: at() },
      { fingerprint: credentialHash(oliveToken), label: 'Olive', kind: 'owner', member: 'olive', createdAt: at() },
    ]).run();
    return cv.id;
  }).value;
  const query = async (source: string, token: string) => {
    const response = await f.root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ query: source }) });
    return await response.json() as { data?: Record<string, any>; errors?: unknown[] };
  };
  const trace = (token: string, fields = 'seq job tool cardState words wordsKeepUntil') => query(`{sessionTrace(conversation:${JSON.stringify(child)}){${fields}}}`, token);
  const report = (input: unknown, id: string) => f.call('message', input, id, childToken);
  return { ...f, child, query, trace, report };
}

it('keeps a handed-off job\'s step beside its conversation, sealed, and out of the originating thread', async () => {
  const f = await fixture();
  expect(await (await f.report(step, 'one')).json()).toEqual({ ok: true, value: { saved: true, seq: 1 } });
  expect(await (await f.report({ ...step, clientId: 'step-2', words: 'Second step', tool: 'Read', cardState: 'running' }, 'two')).json()).toEqual({ ok: true, value: { saved: true, seq: 2 } });
  // A retry of the same step, under the same receipt or a new one, writes nothing more.
  expect(await (await f.report(step, 'one')).json()).toEqual({ ok: true, value: { saved: true, seq: 1 } });
  expect(await (await f.report(step, 'one-again')).json()).toEqual({ ok: true, value: { saved: true, seq: 1 } });
  const rows = f.db.select().from(s.jobTrace).all();
  expect(rows).toMatchObject([{ conversation: f.child, seq: 1, job: 'child-job', tool: 'Terminal', cardState: 'done', clientId: 'child-job:step-1' }, { seq: 2, tool: 'Read', cardState: 'running' }]);
  expect(await f.key.open(rows[0].words!)).toBe(step.words);
  expect(rows[0].keepUntil).toBe(new Date(f.clock.now() + TRACE_KEEP_DAYS * 86400000).toISOString());
  expect(f.db.$client.serialize().includes(Buffer.from(step.words))).toBe(false);
  // A step's state is not edited afterwards: the body reports each state as a step of its own.
  expect((await f.call('cardState', { clientId: 'step-1', cardState: 'failed' }, 'edit', childToken)).status).toBe(404);
  expect(f.db.select().from(s.jobTrace).all()).toMatchObject([{ cardState: 'done' }, { cardState: 'running' }]);
  // Nothing of it is in the originating thread: no message, no turn there, and its ordinary transcript read has no card.
  expect(f.db.select().from(s.messages).all()).toEqual([]);
  expect(f.db.select().from(s.turns).where(eq(s.turns.conversation, f.thread.conversation)).all()).toEqual([]);
  const transcript = await f.query(`{commsMessages(thread:${JSON.stringify(f.thread.id)}){kind words}}`, bodyCredentials.member);
  expect(transcript).toEqual({ data: { commsMessages: [] } });
});

it('shows the trace to the member of the originating thread and to nobody else', async () => {
  const f = await fixture();
  expect((await f.report(step, 'one')).status).toBe(200);
  expect((await f.report({ ...step, clientId: 'step-2', words: 'Second step', tool: 'Read', cardState: 'running' }, 'two')).status).toBe(200);
  const mine = await f.trace(bodyCredentials.member);
  expect(mine.errors).toBeUndefined();
  expect(mine.data!.sessionTrace).toEqual([
    { seq: 1, job: 'child-job', tool: 'Terminal', cardState: 'done', words: step.words, wordsKeepUntil: new Date(f.clock.now() + TRACE_KEEP_DAYS * 86400000).toISOString() },
    { seq: 2, job: 'child-job', tool: 'Read', cardState: 'running', words: 'Second step', wordsKeepUntil: new Date(f.clock.now() + TRACE_KEEP_DAYS * 86400000).toISOString() },
  ]);
  // The latest step alone, without opening any words, and one job's steps.
  expect((await f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},limit:1){seq tool}}`, bodyCredentials.member)).data).toEqual({ sessionTrace: [{ seq: 2, tool: 'Read' }] });
  expect((await f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},job:"another"){seq}}`, bodyCredentials.member)).data).toEqual({ sessionTrace: [] });
  // Another member with the same agent and project, a full owner, the agent outside this job, and the job's own body.
  for (const token of [bobToken, oliveToken, bodyCredentials.agent, childToken, bodyCredentials.body]) {
    for (const fields of ['seq tool cardState words', 'seq']) {
      const theirs = await f.trace(token, fields);
      expect(theirs.errors).toBeUndefined();
      expect(theirs.data).toEqual({ sessionTrace: [] });
    }
  }
  // The thread's member loses it with the conversation: once the conversation is another member's, it is theirs alone.
  f.root.writes.run(() => f.db.update(s.conversations).set({ member: 'bob' }).where(eq(s.conversations.id, f.child)).run());
  expect((await f.trace(bodyCredentials.member)).data).toEqual({ sessionTrace: [] });
});

it('still relays the job\'s final reply to the originating thread, and only that', async () => {
  const f = await fixture();
  expect((await f.report(step, 'one')).status).toBe(200);
  expect((await f.report({ kind: 'reply', clientId: 'review-result', words: 'PRIVATE FINDINGS', model: 'reviewer' }, 'reply')).status).toBe(200);
  const messages = f.db.select().from(s.messages).all();
  expect(messages).toMatchObject([{ thread: f.thread.id, kind: 'reply', run: 'child-job', clientId: 'review:' + f.child }]);
  expect(await f.key.open(messages[0].words!)).toBe('PRIVATE FINDINGS');
  expect(f.db.select().from(s.inbox).where(and(eq(s.inbox.conversation, f.thread.conversation), eq(s.inbox.source, 'handoff'))).all()).toHaveLength(1);
  expect(f.db.select().from(s.jobTrace).all()).toHaveLength(1);
  const transcript = await f.query(`{commsMessages(thread:${JSON.stringify(f.thread.id)}){kind words}}`, bodyCredentials.member);
  expect(transcript.data).toEqual({ commsMessages: [{ kind: 'reply', words: 'PRIVATE FINDINGS' }] });
});

it('keeps no trace for a handoff with no originating thread, or one whose thread is archived', async () => {
  // A brief handed to another conversation's body has the parent job as its place, and no thread to return to.
  const peer = await fixture('job');
  expect((await peer.report(step, 'one')).status).toBe(404);
  expect(peer.db.select().from(s.jobTrace).all()).toEqual([]);
  const f = await fixture();
  f.root.writes.run(() => f.db.update(s.threads).set({ archivedAt: new Date(f.clock.now()).toISOString() }).where(eq(s.threads.id, f.thread.id)).run());
  expect([403, 404]).toContain((await f.report(step, 'one')).status);
  expect(f.db.select().from(s.jobTrace).all()).toEqual([]);
});

it('keeps a step 90 days from when it was written, whatever the Comms keep time, and removes it with the originating thread', async () => {
  const day = 86400000;
  for (const commsDays of [1, 14]) {
    const f = await fixture();
    // The clock moves for months with no worker reporting; this is about the words, not a silent job (as in the handoff suite).
    f.root.services.runtime.close();
    f.root.writes.run(() => f.db.insert(s.household).values({ commsDays }).run());
    const written = f.clock.now();
    expect((await f.report(step, 'one')).status).toBe(200);
    expect((await f.report({ kind: 'reply', clientId: 'review-result', words: 'PRIVATE FINDINGS', model: 'reviewer' }, 'reply')).status).toBe(200);
    expect(f.db.select().from(s.jobTrace).get()?.keepUntil).toBe(new Date(written + TRACE_KEEP_DAYS * day).toISOString());
    // The chat's own words still go at the Comms keep time; the step does not go with them.
    expect(f.db.select().from(s.messages).get()?.keepUntil).toBe(new Date(written + commsDays * day).toISOString());
    f.clock.advance(commsDays * day);
    expect(f.db.select().from(s.messages).all()).toMatchObject([{ kind: 'reply', words: null }]);
    expect((await f.trace(bodyCredentials.member)).data!.sessionTrace[0].words).toBe(step.words);
    // Day 89, and the last millisecond before day 90: still read, with its words.
    f.clock.advance(89 * day - commsDays * day);
    expect((await f.trace(bodyCredentials.member)).data!.sessionTrace).toMatchObject([{ seq: 1, words: step.words, wordsKeepUntil: new Date(written + TRACE_KEEP_DAYS * day).toISOString() }]);
    f.clock.advance(day - 1);
    expect((await f.trace(bodyCredentials.member)).data!.sessionTrace[0].words).toBe(step.words);
    // A read at day 90 gives no words even where the sweep has not run yet.
    const late = new JobTraceQueries(f.db, f.key, () => sql`1`, () => new Date(written + TRACE_KEEP_DAYS * day).toISOString());
    const viewer = { kind: 'member', id: 'alice' } as Parameters<JobTraceQueries['steps']>[0];
    expect(f.db.select().from(s.jobTrace).get()?.words).not.toBeNull();
    expect(await late.opened(viewer, { conversation: f.child }, () => {})).toMatchObject([{ seq: 1, text: null }]);
    expect(late.keepUntil(f.db.select().from(s.jobTrace).get()!)).toBeNull();
    // Until then loom does not say the steps are gone.
    expect((await f.query(expiredQuery(f.child), bodyCredentials.member)).data).toEqual({ sessionTraceExpired: false });
    // At day 90 loom's own sweep deletes the step, row and all: no tool, no state and no time is left of it.
    f.clock.advance(1);
    expect(f.db.select().from(s.jobTrace).all()).toEqual([]);
    expect((await f.trace(bodyCredentials.member)).data).toEqual({ sessionTrace: [] });
    // The page still tells "no longer kept" from "never reported one": the job is older than a step is kept.
    expect((await f.query(expiredQuery(f.child), bodyCredentials.member)).data).toEqual({ sessionTraceExpired: true });
    for (const token of [bobToken, oliveToken, bodyCredentials.agent, childToken])
      expect((await f.query(expiredQuery(f.child), token)).data, token[0]).toEqual({ sessionTraceExpired: false });
    expect((await f.query(expiredQuery(f.child, 'another'), bodyCredentials.member)).data).toEqual({ sessionTraceExpired: false });
  }
});

it('removes a kept trace when its originating thread is deleted, and keeps a stored earlier limit', async () => {
  const f = await fixture();
  f.root.services.runtime.close();
  expect((await f.report(step, 'one')).status).toBe(200);
  expect((await f.report({ ...step, clientId: 'step-2' }, 'two')).status).toBe(200);
  // A row stored before this rule keeps the limit it was stamped with: nothing is backfilled.
  const early = new Date(f.clock.now() + 86400000).toISOString();
  f.root.writes.run(() => f.db.update(s.jobTrace).set({ keepUntil: early }).where(eq(s.jobTrace.seq, 1)).run());
  f.clock.advance(86400000);
  // The step past its stamped limit is deleted; the other stays, and the job is not said to be past its keep time.
  expect((await f.trace(bodyCredentials.member, 'seq words')).data).toEqual({ sessionTrace: [{ seq: 2, words: step.words }] });
  expect((await f.query(expiredQuery(f.child), bodyCredentials.member)).data).toEqual({ sessionTraceExpired: false });
  // Archiving the thread ends nothing that is already kept; deleting it removes the rows.
  f.root.writes.run(() => f.db.update(s.threads).set({ archivedAt: new Date(f.clock.now()).toISOString() }).where(eq(s.threads.id, f.thread.id)).run());
  expect((await f.trace(bodyCredentials.member, 'seq words')).data).toEqual({ sessionTrace: [{ seq: 2, words: step.words }] });
  f.root.writes.run(() => f.root.services.comms!.delete(f.thread.id));
  expect(f.db.select().from(s.jobTrace).all()).toEqual([]);
  expect((await f.trace(bodyCredentials.member)).data).toEqual({ sessionTrace: [] });
});

it('refuses a step past the caps for a job and for a session, with a message, and keeps what it has', async () => {
  const f = await fixture(), at = new Date(f.clock.now()).toISOString(), until = new Date(f.clock.now() + 86400000).toISOString();
  const fill = (job: string, from: number, count: number) => f.root.writes.run(() => f.db.$client.prepare(
    `WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO job_trace (conversation, seq, job, at, tool, card_state, client_id, words, keep_until) SELECT ?, i, ?, ?, 'Read', 'done', ? || ':filled-' || i, x'00', ? FROM n`)
    .run(from, from + count - 1, f.child, job, at, job, until));
  expect((await f.report(step, 'one')).status).toBe(200);
  fill('child-job', 2, TRACE_STEPS_PER_JOB_MAX - 1);
  const over = await f.report({ ...step, clientId: 'step-over' }, 'over');
  expect(over.status).toBe(400);
  expect(await over.json()).toMatchObject({ ok: false, code: 'invalid', message: `This job has reported ${TRACE_STEPS_PER_JOB_MAX} steps, the most loom keeps for one job. Later steps are not recorded; the work itself is not affected.` });
  expect(f.db.select().from(s.jobTrace).all()).toHaveLength(TRACE_STEPS_PER_JOB_MAX);
  // A retry of a step already kept is still answered.
  expect(await (await f.report(step, 'one-again')).json()).toEqual({ ok: true, value: { saved: true, seq: 1 } });
  // The job's reply is not a step, and is still delivered.
  expect((await f.report({ kind: 'reply', clientId: 'review-result', words: 'PRIVATE FINDINGS', model: 'reviewer' }, 'reply')).status).toBe(200);
  // A session's later jobs share the session's own cap.
  const parent = f.db.select().from(s.jobs).where(eq(s.jobs.id, 'child-job')).get()!;
  f.root.writes.run(() => { for (let n = 2; n <= TRACE_STEPS_PER_CONVERSATION_MAX / TRACE_STEPS_PER_JOB_MAX; n++) f.db.insert(s.jobs).values({ ...parent, id: 'child-job-' + n, state: 'done', box: null }).run(); });
  for (let n = 2; n <= TRACE_STEPS_PER_CONVERSATION_MAX / TRACE_STEPS_PER_JOB_MAX; n++) fill('child-job-' + n, (n - 1) * TRACE_STEPS_PER_JOB_MAX + 1, TRACE_STEPS_PER_JOB_MAX - (n === 2 ? 1 : 0) - (n === 5 ? 0 : 0));
  const last = f.db.select().from(s.jobTrace).all().length;
  expect(last).toBe(TRACE_STEPS_PER_CONVERSATION_MAX - 1);
  f.root.writes.run(() => f.db.delete(s.jobTrace).where(and(eq(s.jobTrace.job, 'child-job'), sql`${s.jobTrace.seq} > 10`)).run());
  fill('child-job-2', TRACE_STEPS_PER_CONVERSATION_MAX + 1, 1);
  fill('child-job-3', TRACE_STEPS_PER_CONVERSATION_MAX + 2, TRACE_STEPS_PER_JOB_MAX - 10);
  expect(f.db.select().from(s.jobTrace).all()).toHaveLength(TRACE_STEPS_PER_CONVERSATION_MAX);
  const full = await f.report({ ...step, clientId: 'step-full' }, 'full');
  expect(await full.json()).toMatchObject({ ok: false, code: 'invalid', message: `This session has reported ${TRACE_STEPS_PER_CONVERSATION_MAX} steps, the most loom keeps for one session. Later steps are not recorded; the work itself is not affected.` });
  expect(f.db.select().from(s.jobTrace).all()).toHaveLength(TRACE_STEPS_PER_CONVERSATION_MAX);
});

it('takes a step\'s tool as one short clean line and refuses anything else', async () => {
  const f = await fixture();
  for (const tool of ['two\nlines', 'tab\there', 'zero\u200bwidth', 'turned\u202eround', 'x'.repeat(TRACE_TOOL_MAX + 1)]) {
    const refused = await f.report({ ...step, clientId: 'bad', tool }, 'bad-' + tool.length + tool.charCodeAt(3));
    expect(refused.status, JSON.stringify(tool)).toBe(400);
  }
  expect(f.db.select().from(s.jobTrace).all()).toEqual([]);
  expect((await f.report({ ...step, tool: 'Subagent · reviewer → mcp__loom__task_create' }, 'fine')).status).toBe(200);
});

it('reads only the steps after one the reader already has, earliest first, a bounded page at a time', async () => {
  const f = await fixture();
  for (let n = 1; n <= 5; n++) expect((await f.report({ ...step, clientId: 'step-' + n, words: 'Step ' + n }, 'r' + n)).status).toBe(200);
  const after = (seq: number, limit?: number) => f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},after:${seq}${limit ? ',limit:' + limit : ''}){seq words}}`, bodyCredentials.member);
  expect((await after(3)).data).toEqual({ sessionTrace: [{ seq: 4, words: 'Step 4' }, { seq: 5, words: 'Step 5' }] });
  expect((await after(5)).data).toEqual({ sessionTrace: [] });
  // The earliest after it, so a reader that is far behind reads on page by page and misses none.
  expect((await after(0, 2)).data).toEqual({ sessionTrace: [{ seq: 1, words: 'Step 1' }, { seq: 2, words: 'Step 2' }] });
  expect((await after(2, 2)).data).toEqual({ sessionTrace: [{ seq: 3, words: 'Step 3' }, { seq: 4, words: 'Step 4' }] });
  // Without it, the latest page as before.
  expect((await f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},limit:2){seq}}`, bodyCredentials.member)).data).toEqual({ sessionTrace: [{ seq: 4 }, { seq: 5 }] });
  // Only the steps asked for are opened.
  let opened = 0; const key = { ...f.key, open: async (sealed: Buffer) => { opened++; return f.key.open(sealed); } };
  const queries = new JobTraceQueries(f.db, key, () => sql`1`, () => new Date(f.clock.now()).toISOString());
  expect((await queries.opened({ kind: 'member', id: 'alice' } as Parameters<JobTraceQueries['steps']>[0], { conversation: f.child, after: 4 }, () => {})).map(row => row.text)).toEqual(['Step 5']);
  expect(opened).toBe(1);
  expect((await after(-1)).errors).toBeDefined();
  expect((await f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},limit:${TRACE_PAGE_MAX + 1}){seq}}`, bodyCredentials.member)).errors).toBeDefined();
  // Nobody else reads anything this way either.
  expect((await f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},after:0){seq}}`, bobToken)).data).toEqual({ sessionTrace: [] });
});

it('reads the latest steps before one the reader already has, oldest first, and counts every step', async () => {
  const f = await fixture();
  for (let n = 1; n <= 5; n++) expect((await f.report({ ...step, clientId: 'step-' + n, words: 'Step ' + n }, 'r' + n)).status).toBe(200);
  const before = (seq: number, limit?: number) => f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},before:${seq}${limit ? ',limit:' + limit : ''}){seq words}}`, bodyCredentials.member);
  expect((await before(4, 2)).data).toEqual({ sessionTrace: [{ seq: 2, words: 'Step 2' }, { seq: 3, words: 'Step 3' }] });
  expect((await before(2, 2)).data).toEqual({ sessionTrace: [{ seq: 1, words: 'Step 1' }] });
  expect((await before(1)).data).toEqual({ sessionTrace: [] });
  expect((await before(0)).errors).toBeDefined();
  expect((await f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},before:3,after:1){seq}}`, bodyCredentials.member)).errors).toBeDefined();
  const total = (token: string) => f.query(`{n:sessionTraceCount(conversation:${JSON.stringify(f.child)})}`, token);
  expect((await total(bodyCredentials.member)).data).toEqual({ n: 5 });
  // Nobody else reads anything this way, nor learns how many there are.
  expect((await f.query(`{sessionTrace(conversation:${JSON.stringify(f.child)},before:5){seq}}`, bobToken)).data).toEqual({ sessionTrace: [] });
  expect((await total(bobToken)).data).toEqual({ n: 0 });
});

it('keeps no step for a job on anybody else\'s word, whatever its body sends', async () => {
  const f = await fixture(), at = new Date(f.clock.now()).toISOString();
  const job = f.db.select().from(s.jobs).where(eq(s.jobs.id, 'child-job')).get()!;
  expect(jobHeld(f.db, job)).toBe(false);
  expect((await f.report(step, 'one')).status).toBe(200);
  // Mail from a member who does not have the agent is now behind the job: it works on anybody else's word.
  f.root.writes.run(() => {
    f.db.insert(s.members).values({ id: 'carol', role: 'member', joinedAt: at }).run();
    f.db.insert(s.inbox).values({ id: 'guest-mail', toKind: 'agent', to: 'art', source: 'thread', fromKind: 'person', fromId: 'carol', at, state: 'taken', changedAt: at, job: 'child-job', conversation: f.child }).run();
  });
  expect(jobHeld(f.db, job)).toBe(true);
  const refused = await f.report({ ...step, clientId: 'step-2' }, 'two');
  expect(refused.status).toBe(403);
  expect(f.db.select().from(s.jobTrace).all()).toHaveLength(1);
});

it('takes with a deleted thread its boards, the trace and ticket links of the sessions handed off from it, and its reply notices; a blueprint stays the member\'s', async () => {
  const f = await fixture(), at = new Date(f.clock.now()).toISOString();
  f.root.services.runtime.close();
  expect((await f.report(step, 'one')).status).toBe(200);
  const ticketSessions = async () => (await f.query('{ticketSessions(ticket:"t-1"){conversation title}}', bodyCredentials.member)).data!.ticketSessions;
  f.root.writes.run(() => {
    f.db.insert(s.tasks).values({ id: 't-1', title: 'Fix the fictional pump', project: 'pond', ownerKind: 'household', createdByKind: 'member', createdBy: 'alice', createdAt: at, changedAt: at }).run();
    f.db.insert(s.conversationTasks).values({ conversation: f.child, task: 't-1' }).run();
    f.db.insert(s.boardThreads).values({ thread: f.thread.id, since: at }).run();
    f.db.insert(s.blueprints).values({ id: 'bp-1', agent: 'art', member: 'alice', name: 'pulse', description: '', parameters: '[]', design: '[]', createdAt: at }).run();
    f.db.insert(s.boards).values({ id: 'bd-1', thread: f.thread.id, title: 'Pond', blueprint: 'bp-1', revision: 2, agentSeen: 0, openedAt: at, trailAt: at, changedAt: at }).run();
    f.db.insert(s.boardPlacements).values([{ id: 'pl-1', board: 'bd-1', brick: 'ticket', params: '{"ticket":"t-1"}', rank: 0, placedByKind: 'agent', placedAt: at },
      { id: 'pl-2', board: 'bd-1', brick: 'ticket', params: '{"ticket":"t-2"}', rank: 0, placedByKind: 'agent', placedAt: at, removedAt: at }]).run();
    f.db.insert(s.boardChanges).values([{ board: 'bd-1', revision: 1, seq: 0, at, actorKind: 'agent', change: 'open' }, { board: 'bd-1', revision: 2, seq: 0, at, actorKind: 'member', change: 'act', placement: 'pl-1', action: 'close', detail: '{}' }]).run();
    f.db.insert(s.sessions).values({ id: 'push-session', token: credentialHash(bodyCredentials.member), device: 'Phone', via: 'link', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
    f.db.insert(s.notificationDevices).values({ endpoint: 'https://fcm.googleapis.com/fcm/send/fictional', member: 'alice', session: 'push-session', keys: '{}', device: 'Phone', createdAt: at, seenAt: at, replies: true }).run();
    f.db.insert(s.notificationReplies).values({ device: 'https://fcm.googleapis.com/fcm/send/fictional', thread: f.thread.id, seq: 1, queuedAt: at }).run();
  });
  expect(await ticketSessions()).toMatchObject([{ conversation: f.child, title: 'Child' }]);
  f.root.writes.run(() => f.root.services.comms!.delete(f.thread.id));
  const left = (table: Parameters<typeof f.db.select>[0] extends never ? never : any) => f.db.select().from(table).all(); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const table of [s.boards, s.boardPlacements, s.boardChanges, s.boardThreads, s.jobTrace, s.conversationTasks, s.notificationReplies, s.threads])
    expect(left(table), (table as unknown as { [k: symbol]: string })[Symbol.for('drizzle:Name')]).toEqual([]);
  // The ticket no longer lists the session, so its job's title is no longer read through the ticket.
  expect(await ticketSessions()).toEqual([]);
  // What stays, by design: the blueprint (it is the member's with that agent, not the thread's), the device, the
  // ticket, and the handoff conversation and its job rows, which nothing in loom deletes.
  expect(f.db.select().from(s.blueprints).all()).toMatchObject([{ id: 'bp-1', member: 'alice' }]);
  expect(f.db.select().from(s.notificationDevices).all()).toHaveLength(1);
  expect(f.db.select().from(s.conversations).where(eq(s.conversations.id, f.child)).all()).toHaveLength(1);
  expect(f.db.select().from(s.jobs).where(eq(s.jobs.id, 'child-job')).all()).toHaveLength(1);
  expect(f.db.$client.pragma('foreign_key_check')).toEqual([]);
});

it('gives a handed-off session\'s final report to whoever may read its originating thread, and to nobody else', async () => {
  const f = await fixture();
  const report = (token: string, conversation = f.child) => f.query(`{sessionReport(conversation:${JSON.stringify(conversation)}){kind run clientId words}}`, token);
  // Unfinished: no report yet, and an unknown session gives the same.
  expect((await report(bodyCredentials.member)).data).toEqual({ sessionReport: null });
  expect((await report(bodyCredentials.member, 'no-such-session')).data).toEqual({ sessionReport: null });
  expect((await f.report(step, 'one')).status).toBe(200);
  expect((await report(bodyCredentials.member)).data).toEqual({ sessionReport: null });
  expect((await f.report({ kind: 'reply', clientId: 'review-result', words: 'PRIVATE FINDINGS', model: 'reviewer' }, 'reply')).status).toBe(200);
  const mine = await report(bodyCredentials.member);
  expect(mine.errors).toBeUndefined();
  expect(mine.data).toEqual({ sessionReport: { kind: 'reply', run: 'child-job', clientId: 'review:' + f.child, words: 'PRIVATE FINDINGS' } });
  // Another member of the agent and project, and a full owner, read none of the originating thread, and get the
  // same null as "no report yet".
  for (const token of [bobToken, oliveToken]) {
    expect((await f.query(`{commsMessages(thread:${JSON.stringify(f.thread.id)}){words}}`, token)).data?.commsMessages ?? [], token).toEqual([]);
    expect((await report(token)).data, token).toEqual({ sessionReport: null });
  }
  // The rule is the thread's own, nothing wider or narrower: the session's body, which the conversation rule lets
  // read that thread's messages, reads the report it wrote there too.
  expect((await f.query(`{commsMessages(thread:${JSON.stringify(f.thread.id)}){words}}`, childToken)).data).toEqual({ commsMessages: [{ words: 'PRIVATE FINDINGS' }] });
  expect((await report(childToken)).data).toEqual({ sessionReport: { kind: 'reply', run: 'child-job', clientId: 'review:' + f.child, words: 'PRIVATE FINDINGS' } });
  // Without a sign-in nothing is read.
  const anonymous = await f.root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `{sessionReport(conversation:${JSON.stringify(f.child)}){words}}` }) });
  expect((await anonymous.json() as { data?: { sessionReport?: unknown } }).data?.sessionReport ?? null).toBeNull();
});

it('never returns another session\'s report', async () => {
  const f = await fixture();
  expect((await f.report({ kind: 'reply', clientId: 'review-result', words: 'FIRST SESSION FINDINGS' }, 'reply')).status).toBe(200);
  // A second session handed off from the same job, with no report of its own yet.
  const other = f.root.writes.run(() => f.root.services.conversations.open({ agent: 'art', member: 'alice', project: 'pond', venue: 'handoff', place: reviewPlace('job', 'another brief'), label: 'Another', direct: false })).value.id;
  expect(other).not.toBe(f.child);
  expect((await f.query(`{sessionReport(conversation:${JSON.stringify(other)}){words}}`, bodyCredentials.member)).data).toEqual({ sessionReport: null });
  // The originating conversation itself is not a session and has no report.
  expect((await f.query(`{sessionReport(conversation:${JSON.stringify(f.thread.conversation)}){words}}`, bodyCredentials.member)).data).toEqual({ sessionReport: null });
  expect((await f.query(`{sessionReport(conversation:${JSON.stringify(f.child)}){words}}`, bodyCredentials.member)).data).toEqual({ sessionReport: { words: 'FIRST SESSION FINDINGS' } });
});
