import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
import { initializeLocalBox, hearBox } from './lifecycle.js';
import { placeBody, PLACE_UP_MS } from './placement.js';
import type { RuntimeRecords } from './records.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const remote = (id: string, extra: Partial<RuntimeRecords['box']> = {}): RuntimeRecords['box'] => ({
  id, name: id, owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [],
  alwaysOn: false, reportOnly: false, createdAt: 0, ...extra,
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'runtime-lifecycle-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, next: true, sharing: fixtureSharing });
  cleanups.push(app.close);
  const store = runtimeStore(app.db);
  const tx = <T>(run: () => T): T => app.db.transaction(run)();
  const init = (input = { id: 'local-runner', name: 'loom-worker', owner: 'jonathan' }) =>
    tx(() => initializeLocalBox(app.db, input, clock.now()));
  const hear = (id: string, input: { facts?: string[] } = {}) => tx(() => hearBox(app.db, id, input, clock.now()));
  const put = (value: RuntimeRecords['box']) => tx(() => store.put('box', value, clock.now()));
  return { app, clock, store, tx, init, hear, put };
}
it('starts empty and creates only explicitly supplied local identity without inventing a heartbeat', async () => {
  const { store, init, clock } = await setup();
  expect(store.ids('box')).toEqual([]);
  expect(init()).toEqual({ box: 'local-runner', changed: true });
  expect(store.read('box', 'local-runner')).toEqual({
    ...remote('local-runner'), name: 'loom-worker', local: true, alwaysOn: true,
    createdAt: clock.now(), changedAt: clock.now(),
  });
  expect(placeBody(store, fixtureSharing(), 'art', {}, clock.now())).toBe('local-runner');
});
it('repeated initialization preserves owner choices, facts, creation time and change timestamp', async () => {
  const { init, hear, store, clock, tx } = await setup();
  init(); hear('local-runner', { facts: ['arch:arm64'] });
  const { changedAt: _, ...value } = store.read('box', 'local-runner')!;
  tx(() => store.put('box', { ...value, labels: ['rig'], lentTo: ['mark'], mayHost: ['art'] }, clock.now()));
  const before = store.read('box', 'local-runner');
  clock.advance(1234);
  expect(init()).toEqual({ box: 'local-runner', changed: false });
  expect(store.read('box', 'local-runner')).toEqual(before);
});
it('refuses identity drift, a second local box, remote promotion and revoked-id reuse', async () => {
  const { init, put, store } = await setup();
  init();
  for (const input of [
    { id: 'local-runner', name: 'new-name', owner: 'jonathan' },
    { id: 'local-runner', name: 'loom-worker', owner: 'pollock' },
    { id: 'second', name: 'second', owner: 'jonathan' },
  ]) expect(() => init(input)).toThrow('local');
  put(remote('remote')); put(remote('gone', { revokedAt: 0 }));
  for (const id of ['remote', 'gone']) expect(() => init({ id, name: id, owner: 'jonathan' })).toThrow();
  expect(store.ids('box')).toEqual(['gone', 'local-runner', 'remote']);
});
it('records only facts and server time, preserving all owner metadata and allowing facts to clear', async () => {
  const { hear, put, store, clock } = await setup();
  put(remote('a', { name: 'rig', owner: 'pollock', labels: ['gpu:5090'], mayHost: ['art'], lentTo: ['art'], reportOnly: true, alwaysOn: true }));
  expect(hear('a', { facts: ['arch:arm64', 'arch:arm64', 'gpu:NVIDIA RTX 5090'] })).toEqual({ box: 'a', changed: true });
  const before = store.read('box', 'a')!;
  expect(before.facts).toEqual(['arch:arm64', 'gpu:NVIDIA RTX 5090']);
  expect(before).toMatchObject({ owner: 'pollock', labels: ['gpu:5090'], mayHost: ['art'], lentTo: ['art'], reportOnly: true, alwaysOn: true, lastSeen: clock.now() });
  expect(hear('a')).toEqual({ box: 'a', changed: false });
  clock.advance(1); hear('a');
  expect(store.read('box', 'a')!.facts).toEqual(before.facts);
  hear('a', { facts: [] });
  expect(store.read('box', 'a')!.facts).toEqual([]);
});
it('uses exact enrolled ids, refusing shared names, unknown and revoked runners without writes', async () => {
  const { hear, put, app } = await setup();
  put(remote('a', { name: 'same' })); put(remote('b', { name: 'same' })); put(remote('gone', { revokedAt: 0 }));
  const before = app.db.prepare('SELECT * FROM runtime_boxes ORDER BY id').all();
  for (const id of ['same', 'absent', 'gone']) expect(() => hear(id)).toThrow('not enrolled');
  expect(app.db.prepare('SELECT * FROM runtime_boxes ORDER BY id').all()).toEqual(before);
});
it('rejects malformed reports and identity input before changing metadata', async () => {
  const { hear, put, init, app, tx, clock } = await setup();
  put(remote('a'));
  const before = app.db.prepare('SELECT * FROM runtime_boxes').all();
  for (const facts of [['BadKey'], ['gpu:'], ['x'.repeat(33)], Array.from({ length: 33 }, (_, i) => `cap${i}`)])
    expect(() => hear('a', { facts })).toThrow();
  expect(() => tx(() => hearBox(app.db, 'a', { owner: 'pollock' } as never, clock.now()))).toThrow();
  expect(() => init({ id: '', name: 'x', owner: 'jonathan' })).toThrow();
  expect(() => tx(() => initializeLocalBox(app.db, { id: 'x', name: 'x', owner: 'jonathan', facts: ['gpu:fake'] } as never, clock.now()))).toThrow();
  expect(app.db.prepare('SELECT * FROM runtime_boxes').all()).toEqual(before);
});
it('requires caller transactions even for no-ops, and rolls back lifecycle changes with the caller', async () => {
  const { app, store, init, tx, clock } = await setup();
  const input = { id: 'local-runner', name: 'loom-worker', owner: 'jonathan' };
  expect(() => initializeLocalBox(app.db, input, clock.now())).toThrow('transaction');
  expect(() => tx(() => { initializeLocalBox(app.db, input, clock.now()); throw Error('abort'); })).toThrow('abort');
  expect(store.ids('box')).toEqual([]);
  init();
  expect(() => initializeLocalBox(app.db, input, clock.now())).toThrow('transaction');
  expect(() => hearBox(app.db, input.id, {}, clock.now())).toThrow('transaction');
  const before = store.read('box', input.id);
  expect(() => tx(() => { hearBox(app.db, input.id, { facts: ['gpu:5090'] }, clock.now()); throw Error('abort'); })).toThrow('abort');
  expect(store.read('box', input.id)).toEqual(before);
});
it('heartbeat at epoch zero restores remote placement and expires at the placement boundary', async () => {
  const { app, store, put, hear, tx, clock } = await setup();
  put(remote('a')); put(remote('b'));
  tx(() => store.put('settings', { id: 'art', agent: 'art', boxes: ['a', 'b'] }, clock.now()));
  hear('b');
  const place = () => placeBody(store, fixtureSharing(), 'art', {}, clock.now());
  expect(place()).toBe('b');
  clock.advance(PLACE_UP_MS); expect(place()).toBe('b');
  clock.advance(1); expect(place()).toBe('a');
  hear('b'); expect(place()).toBe('b');
  expect(app.db.prepare('SELECT * FROM runtime_jobs').all()).toEqual([]);
});
