import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer, type Sharing } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
import type { RuntimeRecords } from './records.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const art: Viewer = { kind: 'agent', id: 'art' };
const runner: Viewer = { kind: 'runner', id: 'r1' };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(home?: string, nextMode = true, sharing: () => Sharing = fixtureSharing, viewer: Viewer = art) {
  if (!home) { home = mkdtempSync(join(tmpdir(), 'runtime-storage-')); const dir = home; cleanups.push(() => rmSync(dir, { recursive: true, force: true })); }
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, next: nextMode, sharing, authenticate: () => ({ viewer, valid: () => true }) });
  cleanups.push(app.close);
  const call = (op: string, viewer = owner, scope?: string) => app.operations.call('direct', viewer, `runtime.${op}`, scope === undefined ? {} : { scope });
  return { app, clock, home, store: runtimeStore(app.db), call };
}
const box: RuntimeRecords['box'] = { id: 'wunder', name: 'wunder', owner: 'jonathan', local: true, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: true, reportOnly: false, createdAt: 1 };
const job = (id: string, extra: Partial<RuntimeRecords['job']> = {}): RuntimeRecords['job'] => ({ id, agent: 'art', runner: 'r1', box: 'wunder', title: 'Work', state: 'queued', createdAt: 1, ...extra });
it('installs empty metadata collections in next mode without pretending execution is installed', async () => {
  const { app, call } = await setup();
  for (const name of ['listBoxes', 'listJobs', 'listSettings', 'listBindings']) expect(call(name)).toEqual({ ok: true, value: { records: [] } });
  expect(app.operations.call('direct', owner, 'runtime.startBody', {}, 'start')).toMatchObject({ ok: false, code: 'invalid' });
  expect(app.db.prepare("SELECT count(*) AS n FROM core_migrations WHERE piece='runtime'").get()).toEqual({ n: 9 });
});
it('does not install runtime tables or operations in legacy mode', async () => {
  const { app, call } = await setup(undefined, false);
  expect(call('listBoxes')).toMatchObject({ ok: false, code: 'not-found' });
  expect(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runtime_%'").all()).toEqual([]);
});
it('checks each record with central policy, including private and exact runner jobs', async () => {
  const { app, store, call } = await setup();
  app.db.transaction(() => {
    store.put('box', box, 1);
    store.put('job', job('assigned'), 1);
    store.put('job', job('other-runner', { runner: 'r2' }), 1);
    store.put('job', job('private', { member: 'jonathan', project: 'pond' }), 1);
    store.put('job', job('other-agent', { agent: 'pond-bot', runner: 'r2' }), 1);
    store.put('settings', { id: 'art', agent: 'art', boxes: ['wunder'] }, 1);
    store.put('binding', { id: 'cv-private', agent: 'art', member: 'jonathan', project: 'pond', venue: 'loom', place: 'thread' }, 1);
  })();
  const ids = (name: string, viewer: Viewer, scope?: string) => {
    const result = call(name, viewer, scope); if (!result.ok) throw Error(result.code);
    return (result.value as { records: { id: string }[] }).records.map(r => r.id);
  };
  expect(ids('listBoxes', owner)).toEqual(['wunder']);
  expect(ids('listBoxes', art)).toEqual([]);
  expect(ids('listJobs', art)).toEqual(['assigned', 'other-runner']);
  expect(ids('listJobs', runner)).toEqual(['assigned']);
  expect(ids('listJobs', { kind: 'runner', id: 'r2' })).toEqual(['other-agent', 'other-runner']);
  expect(ids('listJobs', owner, 'pond-bot')).toEqual(['other-agent']);
  expect(ids('listBindings', owner)).toEqual(['cv-private']);
  expect(ids('listJobs', owner)).toContain('private');
  expect(ids('listBindings', art)).toEqual([]);
  expect(ids('listBindings', { kind: 'member', id: 'pollock' })).toEqual([]);
  expect(ids('listSettings', art)).toEqual(['art']);
  expect(ids('listSettings', runner)).toEqual([]);
});
it('requires both a service type grant and a service operation grant', async () => {
  const { app, store, call } = await setup(undefined, true, () => ({ ...fixtureSharing(), services: {
    typed: { types: ['runtime.job'], operations: [] },
    operation: { types: [], operations: ['runtime.listJobs'] },
    allowed: { types: ['runtime.job'], operations: ['runtime.listJobs'] },
  } }));
  app.db.transaction(() => { store.put('job', job('shared'), 1); store.put('job', job('private', { member: 'jonathan' }), 1); })();
  for (const id of ['typed', 'operation']) expect(call('listJobs', { kind: 'service', id })).toMatchObject({ ok: false, code: 'denied' });
  expect(call('listJobs', { kind: 'service', id: 'allowed' })).toMatchObject({ ok: true, value: { records: [{ id: 'shared' }] } });
  expect(call('listBindings', { kind: 'service', id: 'allowed' })).toMatchObject({ ok: false, code: 'denied' });
});
it('persists records across restart, preserves timestamps on no-ops and rolls back interrupted writes', async () => {
  const first = await setup();
  expect(() => first.store.put('box', box, 10)).toThrow('transaction');
  first.app.db.transaction(() => {
    expect(first.store.put('box', box, 10)).toBe(true);
    expect(first.store.put('box', box, 20)).toBe(false);
  })();
  expect(() => first.app.db.transaction(() => { first.store.put('job', job('rolled-back'), 30); throw Error('interrupted'); })()).toThrow('interrupted');
  await first.app.close();
  const second = await setup(first.home);
  expect(second.store.read('box', box.id)).toEqual({ ...box, changedAt: 10 });
  expect(second.store.ids('job')).toEqual([]);
  expect(second.app.db.prepare("SELECT count(*) AS n FROM core_migrations WHERE piece='runtime'").get()).toEqual({ n: 9 });
});
it('rejects extra words/credentials, mismatched settings ids and duplicate conversation keys', async () => {
  const { app, store } = await setup();
  expect(() => app.db.transaction(() => store.put('job', { ...job('j'), brief: 'Private words' } as RuntimeRecords['job'], 1))()).toThrow();
  expect(() => app.db.transaction(() => store.put('box', { ...box, token: 'credential' } as RuntimeRecords['box'], 1))()).toThrow();
  expect(() => app.db.transaction(() => store.put('settings', { id: 'wrong', agent: 'art', boxes: [] }, 1))()).toThrow('Settings id');
  expect(() => app.db.transaction(() => store.put('settings', { id: 'art', agent: 'art', boxes: [], token: 'credential' } as RuntimeRecords['settings'], 1))()).toThrow();
  expect(() => app.db.transaction(() => store.put('binding', { id: 'bad', agent: 'art', venue: 'loom', place: 'bad', text: 'private words' } as RuntimeRecords['binding'], 1))()).toThrow();
  const binding = { id: 'one', agent: 'art', venue: 'loom', place: 'thread' };
  app.db.transaction(() => store.put('binding', binding, 1))();
  expect(() => app.db.transaction(() => store.put('binding', { ...binding, id: 'two' }, 1))()).toThrow();
  expect(store.ids('binding')).toEqual(['one']);
});
it('uses the same policy for live sets and removes records after access changes', async () => {
  const { app, store } = await setup();
  app.db.transaction(() => { store.put('job', job('live'), 1); store.put('job', job('private', { member: 'jonathan' }), 1); store.put('job', job('visible-off-scope', { agent: 'pond-bot', project: 'pond' }), 1); })();
  const { next } = await subscribe(app, 'runtime.job', 'art');
  expect(await next()).toMatchObject({ kind: 'set', records: [{ id: 'live' }] });
  app.db.transaction(() => store.put('job', job('live', { member: 'jonathan' }), 2))();
  app.live.changed([{ type: 'runtime.job', id: 'live' }]);
  expect(await next()).toMatchObject({ kind: 'del', id: 'live' });
});

async function subscribe(app: { url: string }, type: string, scope?: string) {
  const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live');
  const queue: unknown[] = [], waiters: Array<(v: unknown) => void> = [];
  ws.on('message', raw => { const value = JSON.parse(raw.toString()); const next = waiters.shift(); if (next) next(value); else queue.push(value); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
  await once(ws, 'open'); cleanups.push(() => { ws.terminate(); });
  ws.send(JSON.stringify({ kind: 'subscribe', type, scope }));
  return { ws, next };
}

it('limits runner live records to its assigned non-private jobs', async () => {
  const { app, store } = await setup(undefined, true, fixtureSharing, runner);
  app.db.transaction(() => {
    store.put('box', box, 1);
    store.put('job', job('assigned'), 1);
    store.put('job', job('unassigned', { runner: 'r2' }), 1);
    store.put('job', job('private', { member: 'jonathan' }), 1);
  })();
  const jobs = await subscribe(app, 'runtime.job');
  expect(await jobs.next()).toMatchObject({ kind: 'set', records: [{ id: 'assigned' }] });
  const boxes = await subscribe(app, 'runtime.box');
  expect(await boxes.next()).toMatchObject({ kind: 'set', records: [] });
});
it('requires live service type grants, excludes private jobs and refreshes on lost grants', async () => {
  const access = { ...fixtureSharing(), services: { reader: { types: ['runtime.job'], operations: [] as string[] } } };
  const { app, store } = await setup(undefined, true, () => access, { kind: 'service', id: 'reader' });
  app.db.transaction(() => { store.put('job', job('shared'), 1); store.put('job', job('private', { member: 'jonathan' }), 1); })();
  const jobs = await subscribe(app, 'runtime.job');
  expect(await jobs.next()).toMatchObject({ kind: 'set', records: [{ id: 'shared' }] });
  access.services.reader.types = [];
  access.services.reader.operations = ['runtime.listJobs'];
  app.live.refreshAccess();
  expect(await jobs.next()).toMatchObject({ kind: 'set', records: [] });
});
