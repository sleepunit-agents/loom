import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { agents, approvals, approvalRecord, changes, inbox, members, projects } from '../core/data/schema.js';
import { approvalService } from './approvals.js';
import { changeAnswers } from './changes-answers.js';

let client: Database.Database, db: DataDatabase, service: ReturnType<typeof approvalService>, answers: ReturnType<typeof changeAnswers>;
const at = '2026-11-14T20:00:00.000Z', id = 'github:house/loom#12', head = 'a'.repeat(40);
const request = () => service.request({ kind: 'merge', target: `${id}@${head}`, agent: 'art', project: 'loom', what: 'Merge the script', why: 'Ready', askedFrom: 'loom', actingFor: 'owner', ask: 'Merge this commit?', ifYes: 'Art merges this commit.', ifNo: 'Art leaves it open.' });
const answer = (approval: string, allow = true) => answers.answer({ change: id, head, approval, member: 'jonathan', allow });
beforeEach(() => {
  client = new Database(':memory:'); db = createDataSchema(client, () => at);
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
  db.insert(projects).values({ id: 'loom', name: 'Loom' }).run();
  db.insert(changes).values({ id, repository: 'house/loom', number: 12, title: 'Script', body: '', url: 'https://github.com/house/loom/pull/12', state: 'open', draft: false, authorLogin: 'art-e-fish', project: 'loom', agent: 'art', branch: 'script', headCommit: head, baseBranch: 'main', checks: 'passing', review: 'approved', mergeable: 'yes', waitingOn: 'you', openedAt: at, updatedAt: at }).run();
  service = approvalService(db, new Map(), () => at); answers = changeAnswers(db, service);
});
afterEach(() => client.close());

it('answers through Approvals, returns an Inbox answer and leaves the agent one exact-head spend', () => {
  const row = request();
  expect(answer(row.id)).toMatchObject({ state: 'allowed', decidedBy: 'jonathan' });
  expect(db.select().from(changes).get()?.waitingOn).toBe('agent');
  expect(db.select().from(inbox).all()).toEqual(expect.arrayContaining([expect.objectContaining({ toKind: 'agent', to: 'art', source: 'answer' })]));
  expect(service.use(row.id, 'art', 'merge', `${id}@${'b'.repeat(40)}`).ok).toBe(false);
  expect(service.use(row.id, 'art', 'merge', `${id}@${head}`).ok).toBe(true);
  expect(() => answer(row.id)).toThrow('already answered');
});

it('refuses stale or closed copies and mismatched approval bindings without answering', () => {
  const row = request();
  expect(() => answers.answer({ change: id, head: 'b'.repeat(40), approval: row.id, member: 'jonathan', allow: true })).toThrow('head');
  for (const patch of [{ target: `${id}@${'b'.repeat(40)}` }, { kind: 'command' as const }, { project: null }]) {
    db.update(approvals).set(patch).where(eq(approvals.id, row.id)).run();
    expect(() => answer(row.id)).toThrow('match');
    db.update(approvals).set({ target: `${id}@${head}`, kind: 'merge', project: 'loom' }).where(eq(approvals.id, row.id)).run();
  }
  db.update(changes).set({ agent: null }).run(); expect(() => answer(row.id)).toThrow('match');
  db.update(changes).set({ agent: 'art', state: 'closed' }).run(); expect(() => answer(row.id)).toThrow('open');
  expect(service.get(row.id).state).toBe('pending');
  expect(service.record(row.id).map(r => r.event)).toEqual(['request']);
});

it('denies through the same record, revokes an allowance and preserves unrelated blockers', () => {
  const first = request(); answer(first.id);
  db.update(changes).set({ waitingOn: 'ci', checks: 'running' }).run();
  const second = request(); expect(answer(second.id, false).state).toBe('denied');
  expect(service.get(first.id)).toMatchObject({ state: 'denied', overriddenBy: second.id });
  expect(db.select().from(changes).get()?.waitingOn).toBe('ci');
  expect(service.use(first.id, 'art', 'merge', `${id}@${head}`).ok).toBe(false);
});

it('rolls the answer, audit and Inbox delivery back if updating the change fails', () => {
  const row = request(); const before = db.select().from(inbox).all();
  client.exec("CREATE TRIGGER broken_change BEFORE UPDATE ON changes BEGIN SELECT RAISE(ABORT, 'cache unavailable'); END");
  expect(() => answer(row.id)).toThrow('cache unavailable');
  expect(service.get(row.id).state).toBe('pending');
  expect(db.select().from(approvalRecord).all().map(r => r.event)).toEqual(['request']);
  expect(db.select().from(inbox).all()).toEqual(before);
  expect(db.select().from(changes).get()?.waitingOn).toBe('you');
  client.exec('DROP TRIGGER broken_change');
  expect(answer(row.id).state).toBe('allowed');
});
