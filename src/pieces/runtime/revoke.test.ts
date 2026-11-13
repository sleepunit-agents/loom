import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Db, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { installRuntime } from './index.js';
import type { RuntimeCredentials } from './credentials.js';
import type { RuntimeRecords } from './records.js';
import { runtimeStore } from './store.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const box = (id: string, extra: Partial<RuntimeRecords['box']> = {}): RuntimeRecords['box'] => ({ id, name: id, owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1, ...extra });
async function setup(installed = true) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-revoke-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock();
  // Test-only central credential fake: it uses the supplied transaction rather
  // than an in-memory counter, so rollback checks cover credential changes too.
  let fail = false;
  const revoke = vi.fn((db: Db, input: { box: string; jobs: readonly string[]; now: number }) => {
    expect(db.inTransaction).toBe(true);
    db.prepare('UPDATE fake_credentials SET revoked=? WHERE target=?').run(input.now, input.box);
    for (const id of input.jobs) db.prepare('UPDATE fake_credentials SET revoked=? WHERE target=?').run(input.now, id);
    if (fail) throw new Error('central revocation failed');
  });
  const credentials: RuntimeCredentials = { revokeBox: revoke };
  const sharing = () => ({ ...fixtureSharing(), services: { keyholder: { types: ['runtime.box'], operations: ['runtime.revokeBox'] } } });
  const app = await startLoom({ home, clock, next: true, sharing, install(app) {
    installRuntime(app.db, app.operations, app.live, sharing, { credentials: installed ? credentials : undefined });
    app.db.exec('CREATE TABLE fake_credentials (id TEXT PRIMARY KEY, target TEXT, revoked INTEGER)');
  } });
  cleanups.push(app.close);
  const store = runtimeStore(app.db);
  const states = ['queued', 'starting', 'running', 'waiting', 'uncertain', 'done', 'failed', 'stopped', 'lost'] as const;
  app.db.transaction(() => {
    for (const b of [box('r1', { name: 'one' }), box('r2'), box('local', { local: true })]) store.put('box', b, 1);
    for (const state of states) store.put('job', { id: state, agent: 'art', box: 'r1', runner: 'r1', title: state, state, createdAt: 1, ...(state === 'done' ? { endedAt: 2 } : {}) }, 1);
    store.put('job', { id: 'other', agent: 'pond-bot', box: 'r2', runner: 'r2', title: 'other', state: 'running', createdAt: 1 }, 1);
    store.put('settings', { id: 'art', agent: 'art', boxes: ['r2', 'r1', 'local'], model: 'gpt-6.1-sol' }, 1);
    store.put('settings', { id: 'pond-bot', agent: 'pond-bot', boxes: ['r1'] }, 1);
    store.put('settings', { id: 'untouched', agent: 'untouched', boxes: ['r2'] }, 1);
    // More than one credential for a principal must go.
    for (const [i, target] of ['r1', 'r1', 'r2', ...states, 'other'].entries()) app.db.prepare('INSERT INTO fake_credentials VALUES (?,?,NULL)').run(`token-${i}`, target);
  })();
  let seq = 0;
  const call = (input: unknown = { box: 'one' }, viewer = owner, id = `revoke-${++seq}`) => app.operations.call('direct', viewer, 'runtime.revokeBox', input, id);
  const tokens = () => app.db.prepare('SELECT target,revoked FROM fake_credentials ORDER BY id').all() as { target: string; revoked: number | null }[];
  return { app, clock, store, call, revoke, tokens, failing: (value: boolean) => { fail = value; } };
}
it('atomically revokes the box and all its credentials, loses active jobs and removes every preference', async () => {
  const { app, clock, store, call, revoke, tokens } = await setup();
  clock.advance(100);
  const changed = vi.spyOn(app.live, 'changed');
  expect(call()).toEqual({ ok: true, value: { box: 'r1', revoked: true } });
  expect(store.read('box', 'r1')?.revokedAt).toBe(clock.now());
  for (const id of ['queued', 'starting', 'running', 'waiting', 'uncertain']) expect(store.read('job', id)).toMatchObject({ state: 'lost', endedAt: clock.now(), changedAt: clock.now() });
  for (const id of ['done', 'failed', 'stopped', 'lost']) expect(store.read('job', id)).toMatchObject({ state: id, changedAt: 1 });
  expect(store.read('job', 'done')?.endedAt).toBe(2);
  expect(store.read('job', 'other')).toMatchObject({ state: 'running', changedAt: 1 });
  expect(store.read('settings', 'art')).toMatchObject({ boxes: ['r2', 'local'], model: 'gpt-6.1-sol' });
  expect(store.read('settings', 'pond-bot')?.boxes).toEqual([]);
  expect(store.read('settings', 'untouched')?.changedAt).toBe(1);
  expect(revoke).toHaveBeenCalledOnce();
  for (const t of tokens()) expect(t.revoked).toBe(['r2', 'other'].includes(t.target) ? null : clock.now());
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0][0]).toEqual([
    { type: 'runtime.box', id: 'r1' },
    ...['queued', 'running', 'starting', 'uncertain', 'waiting'].map(id => ({ type: 'runtime.job', id })),
    { type: 'runtime.settings', id: 'art' }, { type: 'runtime.settings', id: 'pond-bot' },
  ]);
});
it('rolls back credential failure and leaves no retry receipt or notification, then permits retry', async () => {
  const { app, store, call, revoke, tokens, failing } = await setup();
  const changed = vi.spyOn(app.live, 'changed');
  failing(true);
  expect(call({ box: 'one' }, owner, 'stable')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(tokens().every(t => t.revoked === null)).toBe(true);
  expect(store.read('box', 'r1')?.revokedAt).toBeUndefined();
  expect(store.read('job', 'running')?.state).toBe('running');
  expect(store.read('settings', 'art')?.boxes).toEqual(['r2', 'r1', 'local']);
  expect(changed).not.toHaveBeenCalled();
  expect(app.db.prepare('SELECT count(*) AS n FROM core_operations').get()).toEqual({ n: 0 });
  failing(false);
  expect(call({ box: 'one' }, owner, 'stable').ok).toBe(true);
  expect(revoke).toHaveBeenCalledTimes(2);
});
it('rolls back central credentials and earlier metadata if a later settings write fails', async () => {
  const { app, store, call, tokens } = await setup();
  app.db.exec("CREATE TRIGGER reject_settings BEFORE UPDATE ON runtime_settings BEGIN SELECT RAISE(ABORT, 'settings unavailable'); END");
  const changed = vi.spyOn(app.live, 'changed');
  expect(call()).toMatchObject({ ok: false, code: 'unavailable' });
  expect(tokens().every(t => t.revoked === null)).toBe(true);
  expect(store.read('box', 'r1')?.revokedAt).toBeUndefined();
  expect(store.read('job', 'running')?.state).toBe('running');
  expect(store.read('settings', 'art')?.boxes).toEqual(['r2', 'r1', 'local']);
  expect(changed).not.toHaveBeenCalled();
});
it('fails closed without central credentials and refuses local, missing and ambiguous boxes', async () => {
  const { app, store, call, tokens } = await setup(false);
  expect(call()).toMatchObject({ ok: false, code: 'unavailable' });
  expect(call({ box: 'local' })).toMatchObject({ ok: false, code: 'conflict' });
  expect(call({ box: 'absent' })).toMatchObject({ ok: false, code: 'not-found' });
  app.db.transaction(() => store.put('box', box('twin', { name: 'one' }), 1))();
  expect(call()).toMatchObject({ ok: false, code: 'conflict' });
  expect(store.read('box', 'r1')?.revokedAt).toBeUndefined();
  expect(tokens().every(t => t.revoked === null)).toBe(true);
});
it('denies every non-household owner centrally before touching credentials', async () => {
  const { call, revoke } = await setup();
  for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'member', id: 'missing' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'r1' }, { kind: 'service', id: 'keyholder' }] as Viewer[]) expect(call({ box: 'one' }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  expect(revoke).not.toHaveBeenCalled();
});
it('replays the same acknowledgement without revoking again or notifying, and rejects changed retry inputs', async () => {
  const { app, call, revoke } = await setup();
  expect(call({ box: 'one' }, owner, 'stable')).toEqual({ ok: true, value: { box: 'r1', revoked: true } });
  const changed = vi.spyOn(app.live, 'changed');
  expect(call({ box: 'one' }, owner, 'stable')).toEqual({ ok: true, value: { box: 'r1', revoked: true } });
  expect(call({ box: 'r2' }, owner, 'stable')).toMatchObject({ ok: false, code: 'conflict' });
  expect(call()).toMatchObject({ ok: false, code: 'not-found' });
  expect(revoke).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
});

it('accepts absent and previously revoked credentials and still commits the remaining revocation', async () => {
  const { app, store, call, tokens } = await setup();
  app.db.prepare('DELETE FROM fake_credentials WHERE target=?').run('queued');
  app.db.prepare('UPDATE fake_credentials SET revoked=2 WHERE target=?').run('running');
  app.db.prepare('DELETE FROM fake_credentials WHERE id=?').run('token-0');
  expect(call()).toEqual({ ok: true, value: { box: 'r1', revoked: true } });
  expect(store.read('box', 'r1')?.revokedAt).toBeDefined();
  expect(store.read('job', 'queued')?.state).toBe('lost');
  expect(store.read('job', 'running')?.state).toBe('lost');
  expect(store.read('settings', 'art')?.boxes).toEqual(['r2', 'local']);
  for (const token of tokens()) expect(token.revoked === null).toBe(['r2', 'other'].includes(token.target));
});
