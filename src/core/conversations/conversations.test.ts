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
  // These tests are about the mail itself, not whose word it is on: late mail from a person joins a running job here.
  const service = new Conversations(db, () => now, () => () => true);
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
    const input = { toKind: 'agent' as const, to: 'art', conversation: cv.id, source, sourceId: 'external-1', fromKind: 'person' as const, fromId: 'jonathan', words: source === 'handoff' ? null : source, refs: ['t-1', 't-1'] };
    const item = service.send(input); ids.push(item.id);
    expect(service.send({ ...input, words: 'duplicate' })).toEqual(item);
  }
  expect(db.select().from(inboxRefs).all()).toHaveLength(5);
  expect(() => service.take(cv.id, 'wrong-job')).toThrow('not running');
  db.insert(jobs).values({ id: 'job-1', agent: 'art', conversation: cv.id, title: 'Find pump', state: 'running', brief: '', model: 'model-1', startedByKind: 'member', startedBy: 'jonathan', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: service.now() }).run();
  expect(service.take(cv.id, 'job-1').map(i => i.id)).toEqual(ids);
  expect(service.take(cv.id, 'job-1').map(i => i.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(() => service.confirm(ids[0], 'wrong-job')).toThrow('not held');
  const confirmed = service.confirm(ids[0], 'job-1');
  expect(service.confirm(ids[0], 'job-1')).toEqual(confirmed);
  expect(confirmed.state).toBe('done');
  expect(service.take(cv.id, 'job-1').map(i => i.id)).toEqual(ids.slice(1));
  expect(() => service.send({ toKind: 'agent', to: 'mark', conversation: cv.id, source: 'handoff', fromKind: 'agent' })).toThrow('Recipient differs');
});
it('leaves muted mail waiting when a running job takes other mail in the same conversation', () => {
  const { db, service, cv } = fixture();
  // A person's mail: what the schedule or an agent sends after a job was admitted waits for the next job (pending).
  const send = () => service.send({ toKind: 'agent', to: 'art', conversation: cv.id, source: 'notice', fromKind: 'person', fromId: 'jonathan' });
  const muted = send(), dim = send();
  const quietUntil='2026-11-16T18:00:00.000Z';
  db.update(inbox).set({ volume: 'mute', quietUntil }).where(eq(inbox.id, muted.id)).run();
  db.update(inbox).set({ volume: 'dim', quietUntil }).where(eq(inbox.id, dim.id)).run();
  db.insert(jobs).values({ id: 'job-1', agent: 'art', conversation: cv.id, title: 'Find pump', state: 'running', brief: '', model: 'model-1', startedByKind: 'member', startedBy: 'jonathan', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: service.now() }).run();
  expect(service.take(cv.id, 'job-1').map(i => i.id)).toEqual([dim.id]);
  expect(service.item(dim.id)).toMatchObject({volume:'dim',quietUntil});
  expect(service.item(muted.id)).toMatchObject({ state: 'waiting', job: null, takenAt: null });
  db.update(inbox).set({ volume: 'full',quietUntil:null }).where(eq(inbox.id, muted.id)).run();
  expect(service.take(cv.id, 'job-1').map(i => i.id)).toEqual([muted.id, dim.id]);
  db.update(inbox).set({ volume: 'mute' }).where(eq(inbox.id, dim.id)).run();
  expect(service.take(cv.id, 'job-1').map(i => i.id)).toEqual([muted.id]);
});
it('records one public answer and read mark, and returns exactly one answer item to the agent', () => {
  const { db, service, cv, advance } = fixture();
  db.update(conversations).set({member:null}).where(eq(conversations.id,cv.id)).run();
  const question = service.send({ toKind: 'person', to: 'jonathan', conversation: cv.id, source: 'thread', fromKind: 'agent', fromId: 'art', words: 'Order it?', answers: 'yes-no', ifYes: 'I order it today.', ifNo: 'I find a cheaper one.' });
  service.read(question.id, 'jonathan'); advance(); service.read(question.id, 'jonathan');
  expect(db.select().from(inboxReads).all()).toEqual([{ item: question.id, member: 'jonathan', readAt: service.now() }]);
  const answered = service.answer(question.id, 'jonathan', 'yes');
  expect(answered).toMatchObject({ state: 'answered', answer: 'yes', answeredBy: 'jonathan', answeredAt: service.now() });
  expect(service.answer(question.id, 'jonathan', 'yes')).toEqual(answered);
  expect(() => service.answer(question.id, 'jonathan', 'no')).toThrow('already answered');
  const answer = db.select().from(inbox).where(eq(inbox.source, 'answer')).all();
  expect(answer).toHaveLength(1);
  expect(answer[0]).toMatchObject({ toKind: 'agent', to: 'art', sourceId: question.id, conversation: cv.id, seq: 2, words: 'yes\nOrder it?\nI order it today.', member: null });
});
it('keeps source decisions at their source and resolves linked questions without fabricating an answer', () => {
  const { db, service, cv } = fixture();
  const item = service.send({ toKind: 'person', to: 'jonathan', conversation: cv.id, source: 'task', sourceId: 't-1', fromKind: 'agent', words: 'Book the electrician?', answers: 'yes-no', waitsOnKind: 'task', waitsOnId: 't-1', link: '/tasks/t-1' });
  expect(() => service.answer(item.id, 'jonathan', 'yes')).toThrow('linked source');
  const unlinked = service.send({ toKind: 'person', to: 'jonathan', source: 'task', sourceId: 't-2', fromKind: 'agent', words: 'Source owns this?', answers: 'yes-no' });
  expect(() => service.answer(unlinked.id, 'jonathan', 'yes')).toThrow('linked source');
  expect(service.resolve('task', 't-1', 'Task closed')[0]).toMatchObject({ state: 'resolved', answer: null, resolution: 'Task closed' });
  expect(service.resolve('task', 't-1', 'Task closed')).toEqual([]);
  expect(db.select().from(inbox).all()).toHaveLength(2);
});
it('revises digests by run, replaces lists, resolves old questions and rolls back a failed rewrite', () => {
  const { db, service } = fixture();
  const cv = service.open({ agent: 'art', venue: 'wake', place: 'night', label: 'Night shift' });
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

it('records one wordless person turn for an Inbox answer and no extra turn on replay or failed commit', () => {
  const { db, service } = fixture();
  const cv = service.open({ agent: 'art', venue: 'wake', place: 'night', label: 'Night' });
  const question = service.send({ toKind: 'person', to: 'jonathan', conversation: cv.id, source: 'thread', fromKind: 'agent', words: 'Private wording?', answers: 'words' });
  const answer = service.answer(question.id, 'jonathan', 'words', 'Private answer');
  expect(service.answer(question.id, 'jonathan', 'words', 'Private answer')).toEqual(answer);
  expect(() => service.answer(question.id, 'jonathan', 'words', 'Retry')).toThrow('already answered');
  expect(db.select().from(turns).all()).toMatchObject([{ conversation: cv.id, seq: 1, kind: 'message', fromKind: 'person', fromId: 'jonathan' }]);
  expect(JSON.stringify(db.select().from(turns).all())).not.toContain('Private');
  const second = service.send({ toKind: 'person', to: 'jonathan', conversation: cv.id, source: 'thread', fromKind: 'agent', words: 'Another?', answers: 'yes-no' });
  expect(() => db.transaction(() => { service.answer(second.id, 'jonathan', 'yes'); throw new Error('rollback'); })).toThrow('rollback');
  expect(service.item(second.id).state).toBe('waiting');
  expect(service.conversation(cv.id).turnCount).toBe(1);
  expect(db.select().from(turns).all()).toHaveLength(1);
});
it.each(['dim','mute'] as const)('content resolution resets %s only according to recipient volume, never read or duplicate delivery', volume => {
 const {db,service}=fixture(),until='2026-11-21T18:00:00.000Z';
 const source={toKind:'person' as const,to:'jonathan',source:'approval' as const,sourceId:'approval-1',fromKind:'agent' as const,fromId:'art',answers:'yes-no' as const,words:'Allow the fixture?',waitsOnKind:'approval' as const,waitsOnId:'approval-1'};
 const item=service.send(source);db.update(inbox).set({volume,quietUntil:until}).where(eq(inbox.id,item.id)).run();
 service.read(item.id,'jonathan');expect(service.send({...source,words:'Duplicate contents'})).toMatchObject({words:source.words,volume,quietUntil:until});
 const resolved=service.resolve('approval','approval-1','Allowed');expect(resolved).toHaveLength(1);expect(resolved[0]).toMatchObject({state:'resolved',resolution:'Allowed',volume:volume==='dim'?'full':'mute',quietUntil:volume==='dim'?null:until});
 expect(service.resolve('approval','approval-1','Duplicate result')).toEqual([]);
 const named=service.send({...source,sourceId:'approval-2',waitsOnId:'approval-2'});expect(named).toMatchObject({volume:'full',quietUntil:null});expect(service.item(item.id)).toEqual(resolved[0]);
});
it.each(['dim','mute'] as const)('a real public answer changes %s volume atomically and replay preserves it',volume=>{
 const {db,service}=fixture(),until='2026-11-21T18:00:00.000Z';
 const item=service.send({toKind:'person',to:'jonathan',source:'notice',fromKind:'agent',fromId:'art',answers:'yes-no',words:'Use fixture?'});db.update(inbox).set({volume,quietUntil:until}).where(eq(inbox.id,item.id)).run();
 db.$client.exec('BEGIN');expect(()=>service.answer(item.id,'jonathan','yes')).not.toThrow();db.$client.exec('ROLLBACK');expect(service.item(item.id)).toMatchObject({state:'waiting',volume,quietUntil:until});
 expect(service.answer(item.id,'jonathan','yes')).toMatchObject({state:'answered',volume:volume==='dim'?'full':'mute',quietUntil:volume==='dim'?null:until});
 db.update(inbox).set({volume:'dim',quietUntil:until}).where(eq(inbox.id,item.id)).run();expect(service.answer(item.id,'jonathan','yes')).toMatchObject({volume:'dim',quietUntil:until});
});

it.each(['dim','mute'] as const)('acknowledging already-taken mail preserves a later %s preference and its deadline',level=>{
 const {db,service,cv}=fixture();
 const item=service.send({toKind:'agent',to:'art',conversation:cv.id,source:'trigger',fromKind:'schedule'});
 db.insert(jobs).values({id:'job-quiet',agent:'art',conversation:cv.id,title:'Mail',state:'running',brief:'',model:'model',startedByKind:'member',startedBy:'jonathan',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:service.now()}).run();
 service.take(cv.id,'job-quiet');
 const quietUntil='2026-11-16T18:00:00.000Z';
 db.update(inbox).set({volume:level,quietUntil}).where(eq(inbox.id,item.id)).run();
 expect(service.confirm(item.id,'job-quiet')).toMatchObject({state:'done',volume:level,quietUntil});
 expect(service.confirm(item.id,'job-quiet')).toMatchObject({state:'done',volume:level,quietUntil});
});
it('closes only waiting items, by source or by id, returns unconfirmed mail to waiting and blanks an answer in one place each', () => {
  const { db, service, cv } = fixture();
  db.insert(members).values({ id: 'lee', role: 'member', joinedAt: service.now() }).run();
  const notice = (to: string) => service.send({ toKind: 'person', to, source: 'notice', sourceId: 'outage:box', fromKind: 'unknown', words: 'Machine is quiet' });
  const mine = notice('jonathan'), theirs = notice('lee');
  // Named for one recipient, the other's item under the same source id stays.
  expect(service.resolveSource('notice', 'outage:box', 'Reporting again', { kind: 'person', id: 'jonathan' }).map(item => item.id)).toEqual([mine.id]);
  expect(service.item(mine.id)).toMatchObject({ state: 'resolved', resolution: 'Reporting again' });
  expect(service.item(theirs.id).state).toBe('waiting');
  // An item that no longer waits is not closed a second time, and keeps its first reason.
  expect(service.resolveSource('notice', 'outage:box', 'Again')).toHaveLength(1);
  expect(service.resolveItem(mine.id, 'Later')).toBeUndefined();
  expect(service.item(mine.id).resolution).toBe('Reporting again');
  const question = service.send({ toKind: 'person', to: 'jonathan', source: 'notice', sourceId: 'signin:1', fromKind: 'unknown', words: 'Answer with the code', answers: 'words' });
  service.answer(question.id, 'jonathan', 'words', 'one-time-code');
  service.redactAnswer(question.id, '(used)');
  expect(service.item(question.id)).toMatchObject({ state: 'answered', answerText: '(used)' });
  expect(service.resolveItem(question.id, 'Signed in')).toBeUndefined();
  const waiting = service.send({ toKind: 'person', to: 'jonathan', source: 'notice', sourceId: 'signin:2', fromKind: 'unknown', words: 'Open the page' });
  service.redactAnswer(waiting.id, '(used)');
  expect(service.item(waiting.id).answerText).toBeNull();
  expect(service.resolveItem(waiting.id, 'Signed in')?.state).toBe('resolved');
  // An answer to a question asked in a conversation is also mailed to its agent. The code goes from that copy too.
  const asked = service.send({ toKind: 'person', to: 'jonathan', conversation: cv.id, source: 'notice', sourceId: 'signin:3', fromKind: 'agent', fromId: 'art', words: 'Answer with the code', answers: 'words' });
  service.answer(asked.id, 'jonathan', 'words', 'second-code');
  expect(JSON.stringify(db.select().from(inbox).all())).toContain('second-code');
  service.redactAnswer(asked.id, '(used)');
  expect(db.select().from(inbox).where(eq(inbox.sourceId, asked.id)).get()).toMatchObject({ source: 'answer', toKind: 'agent', words: '(used)' });
  expect(JSON.stringify(db.select().from(inbox).all())).not.toContain('second-code');
  const mail = ['a', 'b'].map(sourceId => service.send({ toKind: 'agent', to: 'art', conversation: cv.id, source: 'thread', sourceId, fromKind: 'person', fromId: 'jonathan', words: sourceId }));
  for (const id of ['job-1', 'job-2']) db.insert(jobs).values({ id, agent: 'art', title: '', state: 'running', brief: '', model: 'm', startedByKind: 'member', startedBy: 'jonathan', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: service.now() }).run();
  db.update(inbox).set({ state: 'taken', job: 'job-1', takenAt: service.now() }).where(eq(inbox.id, mail[0].id)).run();
  db.update(inbox).set({ state: 'done', job: 'job-1', takenAt: service.now(), doneAt: service.now() }).where(eq(inbox.id, mail[1].id)).run();
  service.returnTaken('job-2');
  expect(service.item(mail[0].id).state).toBe('taken');
  service.returnTaken('job-1');
  expect(service.item(mail[0].id)).toMatchObject({ state: 'waiting', job: 'job-1', takenAt: null });
  expect(service.item(mail[1].id).state).toBe('done');
});
