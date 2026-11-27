/** The work trace of a handed-off job, over the real doors (docs/specs/boards.md, "Sessions"): a body in a
 * handoff conversation reports a step, loom keeps it beside that conversation, and only the member of the
 * originating thread reads it. All people and words are fictional. */
import { afterEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as s from './core/data/schema.js';
import { reviewPlace } from './core/conversations/review-place.js';
import { bodyFixture, bodyCredentials, credentialHash } from '../test/fixtures/conversation-body.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const childToken = 'body_' + 'c'.repeat(64), bobToken = 'n'.repeat(64), oliveToken = 'o'.repeat(64);
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
  expect(rows[0].keepUntil).toBe(new Date(f.clock.now() + 14 * 86400000).toISOString());
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
    { seq: 1, job: 'child-job', tool: 'Terminal', cardState: 'done', words: step.words, wordsKeepUntil: new Date(f.clock.now() + 14 * 86400000).toISOString() },
    { seq: 2, job: 'child-job', tool: 'Read', cardState: 'running', words: 'Second step', wordsKeepUntil: new Date(f.clock.now() + 14 * 86400000).toISOString() },
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

it('erases the trace\'s words at the keep time a message\'s are, and removes it with the originating thread', async () => {
  const f = await fixture();
  // The clock moves a day with no worker reporting; this is about the words, not a silent job (as in the handoff suite).
  f.root.services.runtime.close();
  f.root.writes.run(() => f.db.insert(s.household).values({ commsDays: 1 }).run());
  expect((await f.report(step, 'one')).status).toBe(200);
  expect(f.db.select().from(s.jobTrace).get()?.keepUntil).toBe(new Date(f.clock.now() + 86400000).toISOString());
  f.clock.advance(86400000 - 1);
  expect((await f.trace(bodyCredentials.member)).data!.sessionTrace[0].words).toBe(step.words);
  // At the keep time loom's own sweep erases the words; the step's name, state and time stay.
  f.clock.advance(1);
  expect(f.db.select().from(s.jobTrace).all()).toMatchObject([{ seq: 1, tool: 'Terminal', cardState: 'done', words: null }]);
  expect((await f.trace(bodyCredentials.member)).data).toEqual({ sessionTrace: [{ seq: 1, job: 'child-job', tool: 'Terminal', cardState: 'done', words: null, wordsKeepUntil: null }] });
  f.root.writes.run(() => f.root.services.comms!.delete(f.thread.id));
  expect(f.db.select().from(s.jobTrace).all()).toEqual([]);
});
