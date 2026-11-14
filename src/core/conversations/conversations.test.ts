import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { agents, members, conversations, turns, conversationPeople, inbox, inboxReads, inboxRefs, digests, digestItems, jobs } from '../data/schema.js';
import { Conversations } from './index.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let now = '2026-11-14T18:00:00.000Z';
  const db = createDataSchema(client, () => now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const service = new Conversations(db, () => now);
  const cv = service.open({ agent: 'art', venue: 'loom', place: 'thread-1', label: 'Pond pump', member: 'jonathan' });
  return { db, service, cv, advance: () => { now = '2026-11-14T18:01:00.000Z'; } };
}
it('reuses an agent/place conversation across venues and records only turn metadata and speakers', () => {
  const { db, service, cv, advance } = fixture();
  expect(service.open({ agent: 'art', venue: 'loom', place: 'thread-1', label: 'Retry' }).id).toBe(cv.id);
  for (const venue of ['discord', 'slack', 'wake', 'handoff'] as const) {
    const other = service.open({ agent: 'art', venue, place: 'thread-1', label: venue });
    expect(other.id).not.toBe(cv.id);
  }
  service.turn({ conversation: cv.id, kind: 'message', fromKind: 'person', fromId: 'jonathan' });
  advance();
  service.turn({ conversation: cv.id, kind: 'reply', fromKind: 'agent', fromId: 'art', run: 'run-1', model: 'model-1', outcome: 'answered', latencyMs: 100 });
  expect(service.conversation(cv.id)).toMatchObject({ turnCount: 2, lastAt: '2026-11-14T18:01:00.000Z' });
  expect(db.select().from(turns).all().map(t => t.seq)).toEqual([1, 2]);
  expect(db.select().from(conversationPeople).all().map(p => p.who).sort()).toEqual(['art', 'jonathan']);
  expect(db.select().from(turns).all()[0]).not.toHaveProperty('words');
});
it('deduplicates all sources and lets only the running conversation job take and confirm agent mail in order', () => {
  const { db, service, cv } = fixture();
  const ids: string[] = [];
  for (const source of ['thread', 'discord', 'slack', 'trigger', 'handoff'] as const) {
    const input = { toKind: 'agent' as const, to: 'art', conversation: cv.id, source, sourceId: 'external-1', fromKind: 'person' as const, fromId: 'jonathan', words: source, refs: ['t-1', 't-1'] };
    const item = service.send(input); ids.push(item.id);
    expect(service.send({ ...input, words: 'duplicate' })).toEqual(item);
  }
  expect(db.select().from(inboxRefs).all()).toHaveLength(5);
  expect(() => service.take(cv.id, 'wrong-job')).toThrow('not running');
  db.insert(jobs).values({ id: 'job-1', agent: 'art', conversation: cv.id, title: 'Find pump', state: 'running', brief: '', model: 'model-1', startedByKind: 'member', startedBy: 'jonathan', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: service.now() }).run();
  db.update(conversations).set({ job: 'job-1' }).where(eq(conversations.id, cv.id)).run();
  expect(service.take(cv.id, 'job-1').map(i => i.id)).toEqual(ids);
  expect(service.take(cv.id, 'job-1').map(i => i.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(() => service.confirm(ids[0], 'wrong-job')).toThrow('not held');
  const confirmed = service.confirm(ids[0], 'job-1');
  expect(service.confirm(ids[0], 'job-1')).toEqual(confirmed);
  expect(confirmed.state).toBe('done');
  expect(service.take(cv.id, 'job-1').map(i => i.id)).toEqual(ids.slice(1));
  expect(() => service.send({ toKind: 'agent', to: 'mark', conversation: cv.id, source: 'handoff', fromKind: 'agent' })).toThrow('Recipient differs');
});
it('records one answer and read mark, and returns exactly one answer item to the agent', () => {
  const { db, service, cv, advance } = fixture();
  const question = service.send({ toKind: 'person', to: 'jonathan', conversation: cv.id, source: 'thread', fromKind: 'agent', fromId: 'art', words: 'Order it?', answers: 'yes-no', ifYes: 'I order it today.', ifNo: 'I find a cheaper one.' });
  service.read(question.id, 'jonathan'); advance(); service.read(question.id, 'jonathan');
  expect(db.select().from(inboxReads).all()).toEqual([{ item: question.id, member: 'jonathan', readAt: service.now() }]);
  const answered = service.answer(question.id, 'jonathan', 'yes');
  expect(answered).toMatchObject({ state: 'answered', answer: 'yes', answeredBy: 'jonathan', answeredAt: service.now() });
  expect(service.answer(question.id, 'jonathan', 'no')).toEqual(answered);
  const answer = db.select().from(inbox).where(eq(inbox.source, 'answer')).all();
  expect(answer).toHaveLength(1);
  expect(answer[0]).toMatchObject({ toKind: 'agent', to: 'art', sourceId: question.id, conversation: cv.id, seq: 2, words: 'yes\nOrder it?\nI order it today.', member: 'jonathan' });
});
it('keeps source decisions at their source and resolves linked questions without fabricating an answer', () => {
  const { db, service, cv } = fixture();
  const item = service.send({ toKind: 'person', to: 'jonathan', conversation: cv.id, source: 'task', sourceId: 't-1', fromKind: 'agent', words: 'Book the electrician?', answers: 'yes-no', waitsOnKind: 'task', waitsOnId: 't-1', link: '/tasks/t-1' });
  expect(() => service.answer(item.id, 'jonathan', 'yes')).toThrow('linked source');
  expect(service.resolve('task', 't-1', 'Task closed')[0]).toMatchObject({ state: 'resolved', answer: null, resolution: 'Task closed' });
  expect(service.resolve('task', 't-1', 'Task closed')).toEqual([]);
  expect(db.select().from(inbox).all()).toHaveLength(1);
});
it('revises digests by run, replaces lists, resolves old questions and rolls back a failed rewrite', () => {
  const { db, service, cv } = fixture();
  const first = service.digest({ conversation: cv.id, run: 'run-1', summary: 'Picked a pump', items: [{ kind: 'task', text: 't-1' }], question: { to: 'jonathan', words: 'Order it?', answers: 'yes-no' } });
  expect(service.item(first.inboxItem!).state).toBe('waiting');
  expect(() => service.digest({ conversation: cv.id, run: 'run-1', summary: 'Bad rewrite', question: { to: 'missing-member', words: 'Order it?', answers: 'yes-no' } })).toThrow();
  expect(service.item(first.inboxItem!).state).toBe('waiting');
  const second = service.digest({ conversation: cv.id, run: 'run-1', summary: 'Ready', items: [{ kind: 'decision', text: 'Middle model' }] });
  expect(second).toMatchObject({ id: first.id, revision: 2, inboxItem: null });
  expect(service.item(first.inboxItem!)).toMatchObject({ state: 'resolved', resolution: 'Digest rewritten' });
  expect(db.select().from(digests).all()).toHaveLength(1);
  expect(db.select().from(digestItems).all()).toEqual([{ digest: first.id, kind: 'decision', text: 'Middle model' }]);
  expect(() => service.digest({ conversation: cv.id, run: 'run-2', summary: 'x'.repeat(601) })).toThrow('600');
});
