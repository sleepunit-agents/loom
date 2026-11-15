import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { agents, members, tempoSettings, projects, conversations, inbox, inboxRefs } from '../core/data/schema.js';
import { Conversations } from '../core/conversations/index.js';
import { approvalService, type ApprovalRequest } from './approvals.js';

let client: Database.Database, db: DataDatabase, at: string, service: ReturnType<typeof approvalService>;
const target = `github:house/loom#12@${'a'.repeat(40)}`;
const proposal = (): ApprovalRequest => ({ kind: 'merge', target, agent: 'art', what: 'Merge the pump script', why: 'Checks pass', askedFrom: 'house', actingFor: 'owner', ask: 'Merge the pump script?', ifYes: 'I merge this commit', ifNo: 'I leave it open' });
beforeEach(() => {
  at = '2026-11-14T20:00:00.000Z'; client = new Database(':memory:'); db = createDataSchema(client, () => at);
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
  service = approvalService(db, new Map(), () => at);
});
afterEach(() => client.close());

it('allows one exact head once and keeps rejected uses in the permanent record', () => {
  const request = service.request(proposal());
  expect(service.use(request.id, 'art', 'merge', target).ok).toBe(false);
  service.allow(request.id, 'jonathan');
  expect(service.use(request.id, 'other', 'merge', target).ok).toBe(false);
  expect(service.use(request.id, 'art', 'merge', target.replace(/a{40}$/, 'b'.repeat(40))).ok).toBe(false);
  expect(service.use(request.id, 'art', 'command', target).ok).toBe(false);
  expect(service.use(request.id, 'art', 'merge', target)).toMatchObject({ ok: true, approval: { usedAt: at } });
  expect(service.use(request.id, 'art', 'merge', target).ok).toBe(false);
  expect(service.record(request.id).map(r => r.event)).toEqual(['request', 'refused-use', 'allow', 'refused-use', 'refused-use', 'refused-use', 'use', 'refused-use']);
  expect(() => client.prepare('DELETE FROM approval_record').run()).toThrow('permanent record');
  expect(() => client.prepare("UPDATE approval_record SET note='changed'").run()).toThrow('permanent record');
  expect(() => service.request({ ...proposal(), target: 'github:house/loom#12' })).toThrow('exact commit');
});

it('expires at the allowance deadline and records denial overriding an older allowance', () => {
  const first = service.request({ ...proposal(), minutes: 1 }); service.allow(first.id, 'jonathan');
  at = '2026-11-14T20:01:00.000Z';
  expect(service.use(first.id, 'art', 'merge', target)).toMatchObject({ ok: false, approval: { state: 'expired' } });
  const older = service.request(proposal()); service.allow(older.id, 'jonathan');
  const denial = service.request(proposal());
  expect(service.deny(denial.id, 'jonathan')).toMatchObject({ state: 'denied', decidedBy: 'jonathan', decidedAt: at });
  expect(service.record(denial.id).at(-1)).toMatchObject({ event: 'deny', note: 'jonathan', at });
  expect(service.record(older.id).at(-1)).toMatchObject({ event: 'deny', note: `Overridden by ${denial.id}`, at });
  expect(service.get(older.id)).toMatchObject({ state: 'denied', overriddenBy: denial.id });
  expect(service.use(older.id, 'art', 'merge', target).ok).toBe(false);
  expect(() => service.allow(denial.id, 'jonathan')).toThrow('already answered');
});

it('runs a proposed setting operation on Allow, with the answer, use and database edit committed together', () => {
  db.insert(tempoSettings).values({ whoKind: 'person', who: 'jonathan', settleSeconds: 5 }).run();
  const apply = () => db.update(tempoSettings).set({ settleSeconds: 60 }).where(eq(tempoSettings.who, 'jonathan')).run();
  service = approvalService(db, new Map([['inbox-minute', () => { apply(); }]]), () => at);
  const proposed = service.request({ ...proposal(), kind: 'setting', target: 'tempo:jonathan', operation: 'inbox-minute', changeSummary: 'Before: 5 seconds. After: 60 seconds.' });
  expect(service.allow(proposed.id, 'jonathan')).toMatchObject({ state: 'used', usedAt: at });
  expect(db.select().from(tempoSettings).get()?.settleSeconds).toBe(60);
  expect(service.record(proposed.id).map(r => r.event)).toEqual(['request', 'allow', 'use']);
  expect(() => service.allow(proposed.id, 'jonathan')).toThrow();
  expect(() => service.request({ ...proposal(), kind: 'setting' })).toThrow('before/after');
  expect(() => service.request({ ...proposal(), operation: 'shell:whatever' })).toThrow('Unknown');
});

it('leaves a failed change pending without a partial database edit or an Allow/use record', () => {
  service = approvalService(db, new Map([['broken', () => { db.insert(tempoSettings).values({ whoKind: 'person', who: 'jonathan' }).run(); throw new Error('Setting changed since proposal'); }]]), () => at);
  const row = service.request({ ...proposal(), kind: 'setting', operation: 'broken', changeSummary: 'Before 5, after 60' });
  expect(() => service.allow(row.id, 'jonathan')).toThrow('changed since');
  expect(db.select().from(tempoSettings).all()).toEqual([]);
  expect(service.get(row.id).state).toBe('pending');
  expect(service.record(row.id).map(r => r.event)).toEqual(['request']);
  expect(() => service.withdraw(row.id, 'other')).toThrow();
  expect(service.withdraw(row.id, 'art').state).toBe('withdrawn');
});

it('preserves the labels and exact proposal and records the answerer and allowance times', () => {
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(conversations).values({ id: 'cv-pond', agent: 'art', member: 'jonathan', project: 'pond', venue: 'loom', place: 'thread', label: 'Pump', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const row = service.request({ ...proposal(), member: 'jonathan', project: 'pond', conversation: 'cv-pond', minutes: 10081, changeSummary: 'Merge this head', details: 'Pump script' });
  expect(service.get(row.id)).toMatchObject({ member: 'jonathan', project: 'pond', conversation: 'cv-pond', changeSummary: 'Merge this head', details: 'Pump script', askedAt: at, minutes: 10081 });
  at = '2026-11-14T20:01:00.000Z';
  expect(service.allow(row.id, 'jonathan')).toMatchObject({ decidedBy: 'jonathan', decidedAt: at, expiresAt: '2026-11-21T20:02:00.000Z' });
  expect(service.record(row.id)[1]).toMatchObject({ event: 'allow', note: 'jonathan', at });
});

it('keeps non-private tell-rule reported steps as named facts and lists them in time order', () => {
  const report=(kind:'merge'|'command',target:string,what:string)=>{
    const row=service.request({...proposal(),kind,target});service.allow(row.id,'jonathan','Standing tell rule fixture for household owner, set by jonathan');service.use(row.id,'art',kind,target);service.reportUsed(row.id,'art',what);return service.notices().at(-1)!;
  };
  const step=report('command','worker:one','Rebuilt the test image');
  expect(step).toMatchObject({agent:'art',kind:'command',target:'worker:one',what:'Rebuilt the test image',at});
  at='2026-11-14T20:01:00.000Z';const second=report('merge',target,'Merged the pump script');expect(service.notices()).toEqual([step,second]);
});

it('withdraws an allowed request and permanently records refusal of a later spend', () => {
  const row = service.request(proposal()); service.allow(row.id, 'jonathan');
  expect(service.withdraw(row.id, 'art').state).toBe('withdrawn');
  expect(service.use(row.id, 'art', 'merge', target).ok).toBe(false);
  expect(service.record(row.id).map(r => r.event)).toEqual(['request', 'allow', 'withdraw', 'refused-use']);
});

it('requires the exact dangerous-action proposal and performs it only on Allow', () => {
  service = approvalService(db, new Map([['queue-reset', () => { db.insert(tempoSettings).values({ whoKind: 'person', who: 'jonathan', settleSeconds: 60 }).run(); }]]), () => at);
  expect(() => service.request({ ...proposal(), kind: 'dangerous', operation: 'queue-reset' })).toThrow('before/after');
  expect(() => service.request({ ...proposal(), kind: 'dangerous', changeSummary: 'Before: 5. After: 60.' })).toThrow('before/after');
  const row = service.request({ ...proposal(), kind: 'dangerous', operation: 'queue-reset', changeSummary: 'Before: 5. After: 60.' });
  expect(db.select().from(tempoSettings).all()).toEqual([]);
  expect(service.allow(row.id, 'jonathan')).toMatchObject({ kind: 'dangerous', state: 'used', usedAt: at });
  expect(db.select().from(tempoSettings).get()?.settleSeconds).toBe(60);
  expect(service.record(row.id).map(r => r.event)).toEqual(['request', 'allow', 'use']);
});

it('projects approvals to every owner and returns one source answer to the original conversation', () => {
  db.insert(members).values([
    { id: 'second-owner', role: 'owner', joinedAt: at },
    { id: 'guest', role: 'member', joinedAt: at },
  ]).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(conversations).values({ id: 'cv-pond', agent: 'art', project: 'pond', member: 'jonathan', venue: 'loom', place: 'pump', label: 'Pump', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const row = service.request({ ...proposal(), project: 'pond', member: 'jonathan', conversation: 'cv-pond' });
  const questions = db.select().from(inbox).all();
  expect(questions.map(q => q.to)).toEqual(['jonathan', 'second-owner']);
  for (const question of questions) {
    expect(question).toMatchObject({ source: 'approval', sourceId: row.id, fromKind: 'agent', fromId: 'art', answers: 'yes-no', words: row.ask,
      waitsOnKind: 'approval', waitsOnId: row.id, conversation: 'cv-pond', project: 'pond', agent: 'art', member: 'jonathan', why: row.why, ifYes: row.ifYes, ifNo: row.ifNo });
    expect(db.select().from(inboxRefs).where(eq(inboxRefs.item, question.id)).all().map(r => r.ref)).toEqual([row.id]);
    expect(() => new Conversations(db, () => at).answer(question.id, question.to, 'yes')).toThrow('linked source');
  }
  service.allow(row.id, 'second-owner');
  expect(db.select().from(inbox).all().filter(q => q.toKind === 'person').map(q => [q.state, q.resolution])).toEqual([['resolved', 'Allowed'], ['resolved', 'Allowed']]);
  const answers = db.select().from(inbox).all().filter(q => q.toKind === 'agent');
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ source: 'answer', sourceId: questions[0].id, to: 'art', conversation: 'cv-pond', fromId: 'second-owner', words: `Allow\n${row.ask}\n${row.ifYes}` });
  expect(() => service.allow(row.id, 'jonathan')).toThrow('already answered');
  expect(db.select().from(inbox).all()).toHaveLength(3);
});

it('settles denial and withdrawal while preserving question history and notifying later revocation', () => {
  const denied = service.request(proposal());
  service.deny(denied.id, 'jonathan');
  expect(db.select().from(inbox).all()).toEqual(expect.arrayContaining([
    expect.objectContaining({ toKind: 'person', waitsOnId: denied.id, state: 'resolved', resolution: 'Denied' }),
    expect.objectContaining({ toKind: 'agent', fromId: 'jonathan', conversation: null, words: `Deny\n${denied.ask}\n${denied.ifNo}` }),
  ]));
  const withdrawn = service.request(proposal());
  service.withdraw(withdrawn.id, 'art');
  expect(db.select().from(inbox).where(eq(inbox.waitsOnId, withdrawn.id)).get()).toMatchObject({ state: 'resolved', resolution: 'Withdrawn' });
  const allowed = service.request(proposal()); service.allow(allowed.id, 'jonathan');
  service.deny(allowed.id, 'jonathan');
  expect(db.select().from(inbox).all()).toEqual(expect.arrayContaining([
    expect.objectContaining({ toKind: 'agent', source: 'approval', sourceId: `${allowed.id}:denied`, words: `Deny\n${allowed.ask}\n${allowed.ifNo}` }),
  ]));
  expect(service.use(allowed.id, 'art', 'merge', target).ok).toBe(false);
});

it('rolls back the request and permanent record if question delivery fails', () => {
  client.exec("CREATE TRIGGER fail_question BEFORE INSERT ON inbox WHEN NEW.to_kind = 'person' BEGIN SELECT RAISE(ABORT, 'question unavailable'); END");
  expect(() => service.request(proposal())).toThrow('question unavailable');
  expect(service.list()).toEqual([]);
  expect(db.select().from(inbox).all()).toEqual([]);
  expect(client.prepare('SELECT * FROM approval_record').all()).toEqual([]);
});

it('rolls back the answer, operation, audit and question resolution if answer delivery fails', () => {
  service = approvalService(db, new Map([['setting', () => { db.insert(tempoSettings).values({ whoKind: 'person', who: 'jonathan' }).run(); }]]), () => at);
  const row = service.request({ ...proposal(), kind: 'setting', operation: 'setting', changeSummary: 'Before: unset. After: defaults.' });
  client.exec("CREATE TRIGGER fail_answer BEFORE INSERT ON inbox WHEN NEW.to_kind = 'agent' BEGIN SELECT RAISE(ABORT, 'answer unavailable'); END");
  expect(() => service.allow(row.id, 'jonathan')).toThrow('answer unavailable');
  expect(service.get(row.id).state).toBe('pending');
  expect(service.record(row.id).map(r => r.event)).toEqual(['request']);
  expect(db.select().from(tempoSettings).all()).toEqual([]);
  expect(db.select().from(inbox).all()).toEqual([expect.objectContaining({ state: 'waiting', waitsOnId: row.id })]);
  expect(() => service.deny(row.id, 'jonathan')).toThrow('answer unavailable');
  expect(service.get(row.id).state).toBe('pending');
  client.exec('DROP TRIGGER fail_answer');
  expect(service.allow(row.id, 'jonathan').state).toBe('used');
  expect(db.select().from(inbox).all()).toHaveLength(2);
});
