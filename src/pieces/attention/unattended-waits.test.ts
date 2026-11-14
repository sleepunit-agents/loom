import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { installAttentionMaintenance } from './daemon.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
const owner: Viewer = { kind: 'member', id: 'jonathan' }, service: Viewer = { kind: 'service', id: 'attention' };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'unattended-waits-')); fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const grants = { taskType: true, taskRead: true, approvalType: true, approvalRead: true, inventoryRead: true, askType: true };
  let database: SharingDatabase;
  const app = await startLoom({ home, next: true, staging: true, clock, stdout: () => {}, install: app => { database = new SharingDatabase(app.db, home); }, sharing: () => {
    const snapshot = database.sharing();
    const attention = snapshot.services.attention;
    if (attention) snapshot.services = { ...snapshot.services, attention: { types: attention.types.filter(type => (type !== 'attention.ask' || grants.askType) && (type !== 'task' || grants.taskType) && (type !== 'approval' || grants.approvalType)), operations: attention.operations.filter(op => (op !== 'attention.pendingWaits' || grants.inventoryRead) && (op !== 'tasks.show' || grants.taskRead) && (op !== 'approvals.check' || grants.approvalRead)) } };
    return snapshot;
  } });
  cleanups.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  let seq = 0;
  const call = (name: string, input: unknown, viewer = owner) => app.operations.call('direct', viewer, name, input, `unattended-${++seq}`);
  const raise = (id: string, waits_on: { task: string } | { approval: string }, extra = {}) => {
    expect(call('attention.raise', { id, agent: 'art', ask: 'Check this work?', source: { kind: 'conversation', id: 'cv-test' }, waits_on, ...extra })).toMatchObject({ ok: true });
  };
  const read = (id: string) => call('attention.get', { id });
  const close = () => expect(call('tasks.close', { id: 't-1', actor: 'jonathan', at: '2026-11-13T12:00:00Z' })).toMatchObject({ value: { result: { ok: true } } });
  return { app, clock, grants, call, raise, read, close };
}
it('resolves public task waits without a page, preserves answers and leaves private/missing waits open', async () => {
  const { app, clock, call, raise, read, close } = await setup();
  raise('public', { task: 't-1' }); raise('private', { task: 't-1' }, { member: 'jonathan' }); raise('missing', { task: 't-999' });
  raise('answered', { task: 't-1' }); call('attention.answer', { id: 'answered', answer: { kind: 'no' } });
  const calls = vi.spyOn(app.operations, 'call');
  clock.advance(0); expect(read('public')).toMatchObject({ value: { state: 'open' } });
  close(); clock.advance(59_999); expect(read('public')).toMatchObject({ value: { state: 'open' } });
  clock.advance(1);
  expect(read('public')).toMatchObject({ value: { state: 'resolved', resolution: 't-1 is closed' } });
  expect(read('private')).toMatchObject({ value: { state: 'open' } });
  expect(read('missing')).toMatchObject({ value: { state: 'open' } });
  expect(read('answered')).toMatchObject({ value: { state: 'answered', answer: { kind: 'no' } } });
  const checks = calls.mock.calls.filter(c => c[2] === 'attention.checkWait');
  expect(checks.every(c => JSON.stringify(c[1]) === JSON.stringify(service))).toBe(true);
  expect(checks.some(c => (c[3] as { id: string }).id === 'private')).toBe(false);
  const ids = checks.map(c => c[4]); expect(new Set(ids).size).toBe(ids.length);
});
it.each(['taskType', 'taskRead'] as const)('requires %s on every sweep, with no task mutation grants', async grant => {
  const { clock, grants, call, raise, read, close } = await setup();
  raise('public', { task: 't-1' }); close(); grants[grant] = false;
  clock.advance(0); expect(read('public')).toMatchObject({ value: { state: 'open' } });
  grants[grant] = true; clock.advance(60_000); expect(read('public')).toMatchObject({ value: { state: 'resolved' } });
  for (const op of ['tasks.close', 'tasks.comment', 'tasks.list']) expect(call(op, { id: 't-1' }, service)).toMatchObject({ ok: false, code: 'denied' });
});
it('uses actual public Approval terminal facts without spending them; private approval state remains hidden', async () => {
  const { app, clock, grants, call, raise, read } = await setup();
  const requested = call('approvals.request', { kind: 'merge', target: `github:acme/app#12@${'a'.repeat(40)}`, ask: 'Merge the fix?', why: 'Fix it.', if_yes: 'I merge it.', if_no: 'I leave it.' }, { kind: 'agent', id: 'art' });
  expect(requested).toMatchObject({ ok: true });
  const id = (requested as { ok: true; value: { id: string } }).value.id;
  raise('approval', { approval: id });
  clock.advance(0); expect(read('approval')).toMatchObject({ value: { state: 'open' } });
  expect(call('approvals.answer', { id, action: 'allow' })).toMatchObject({ ok: true });
  grants.approvalType = false; clock.advance(60_000); expect(read('approval')).toMatchObject({ value: { state: 'open' } });
  grants.approvalType = true; grants.approvalRead = false; clock.advance(60_000); expect(read('approval')).toMatchObject({ value: { state: 'open' } });
  expect(call('approvals.check', { id }, service)).toMatchObject({ code: 'denied' });
  grants.approvalRead = true; clock.advance(60_000); expect(read('approval')).toMatchObject({ value: { state: 'resolved', resolution: 'the approval was allowed' } });
  expect(call('approvals.open', { id }, service)).toMatchObject({ code: 'denied' });
  expect(call('approvals.check', { id }, { kind: 'agent', id: 'art' })).toMatchObject({ value: { state: 'allowed' } });
  // A member-private approval can be read only by that member, even when the ask is public.
  const privateAsk = call('approvals.request', { kind: 'merge', target: `github:acme/app#13@${'b'.repeat(40)}`, ask: 'Merge private work?', why: 'Fix it.', if_yes: 'I merge it.', if_no: 'I leave it.' }, { kind: 'agent', id: 'art' });
  expect(privateAsk).toMatchObject({ ok: true });
  const privateId = (privateAsk as { ok: true; value: { id: string } }).value.id;
  // Seed retained private filing as owning-piece fixture metadata, never through Attention.
  const row = app.db.prepare('SELECT record FROM approvals_approvals WHERE id=?').get(privateId) as { record: string };
  const record = { ...JSON.parse(row.record), member: 'jonathan' };
  app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify(record), privateId);
  expect(await app.operations.callAsync('socket', owner, 'approvals.answer', { id: privateId, action: 'allow' }, 'private-answer', true)).toMatchObject({ ok: true });
  expect(call('approvals.answer', { id, action: 'deny' }, service)).toMatchObject({ ok: false, code: 'denied' });
  raise('private-dependency', { approval: privateId });
  clock.advance(60_000); expect(read('private-dependency')).toMatchObject({ value: { state: 'open' } });
  expect(call('attention.checkWait', { id: 'private-dependency' })).toMatchObject({ value: { state: 'resolved' } });
});

it('installs one sweep and cancels it before database shutdown', async () => {
  const { app, clock, raise } = await setup();
  raise('pending', { task: 't-1' });
  const calls = vi.spyOn(app.operations, 'call');
  installAttentionMaintenance(app); installAttentionMaintenance(app);
  clock.advance(0);
  expect(calls.mock.calls.filter(c => c[2] === 'attention.checkWait')).toHaveLength(1);
  const closeDb = app.db.close.bind(app.db);
  vi.spyOn(app.db, 'close').mockImplementation(() => {
    const count = calls.mock.calls.length; clock.advance(120_000); expect(calls).toHaveBeenCalledTimes(count); return closeDb();
  });
  await app.close();
});

it.each(['inventoryRead', 'askType'] as const)('holds all unattended work when %s is revoked, then recovers', async grant => {
  const { clock, grants, raise, read, close, call } = await setup();
  raise('public', { task: 't-1' }); raise('private', { task: 't-1' }, { member: 'jonathan' }); close();
  expect(call('attention.pendingWaits', {}, service)).toMatchObject({ value: ['public'] });
  grants[grant] = false;
  expect(call('attention.pendingWaits', {}, service)).toMatchObject({ code: 'denied' });
  clock.advance(0); expect(read('public')).toMatchObject({ value: { state: 'open' } });
  grants[grant] = true; clock.advance(60_000);
  expect(read('public')).toMatchObject({ value: { state: 'resolved' } });
  expect(read('private')).toMatchObject({ value: { state: 'open' } });
});

it('stops inventory work while empty, resumes on a new ask and stops its observer on close', async () => {
  const { app, clock, call, raise, close, read } = await setup();
  const calls = vi.spyOn(app.operations, 'call');
  clock.advance(5 * 60_000);
  expect(calls.mock.calls.filter(c => c[2] === 'attention.pendingWaits')).toHaveLength(1);
  raise('later', { task: 't-1' }); close(); clock.advance(0);
  expect(read('later')).toMatchObject({ value: { state: 'resolved' } });
  clock.advance(0);
  const count = calls.mock.calls.filter(c => c[2] === 'attention.pendingWaits').length;
  clock.advance(5 * 60_000);
  expect(calls.mock.calls.filter(c => c[2] === 'attention.pendingWaits')).toHaveLength(count);
  const closeDb = app.db.close.bind(app.db);
  vi.spyOn(app.db, 'close').mockImplementation(() => {
    app.live.changed([{ type: 'attention.ask', id: 'after-close' }]);
    const before = calls.mock.calls.length; clock.advance(60_000);
    expect(calls).toHaveBeenCalledTimes(before); return closeDb();
  });
  await app.close();
});
