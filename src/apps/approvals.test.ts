import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { agents, members, tempoSettings, projects, conversations } from '../core/data/schema.js';
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

it('keeps reported steps as named facts and lists them in time order', () => {
  const step = service.report({ agent: 'art', kind: 'command', target: 'worker:one', what: 'Rebuilt the test image' });
  expect(step).toMatchObject({ agent: 'art', kind: 'command', target: 'worker:one', what: 'Rebuilt the test image', at });
  at = '2026-11-14T20:01:00.000Z';
  const second = service.report({ agent: 'art', kind: 'merge', target, what: 'Merged the pump script' });
  expect(service.notices()).toEqual([step, second]);
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
