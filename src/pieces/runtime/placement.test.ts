import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
import type { RuntimeRecords } from './records.js';
import { boxUp, meets, PLACE_UP_MS, placeBody } from './placement.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const box = (id: string, extra: Partial<RuntimeRecords['box']> = {}): RuntimeRecords['box'] => ({
  id, name: id, owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [],
  alwaysOn: false, reportOnly: false, createdAt: 1, ...extra,
});
async function setup(boxes: RuntimeRecords['box'][] = []) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-placement-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, next: true, sharing: fixtureSharing });
  cleanups.push(app.close);
  const store = runtimeStore(app.db);
  const put = (...values: RuntimeRecords['box'][]) => app.db.transaction(() => { for (const value of values) store.put('box', value, clock.now()); })();
  put(...boxes);
  const prefer = (ids: string[]) => app.db.transaction(() => store.put('settings', { id: 'art', agent: 'art', boxes: ids }, clock.now()))();
  const place = (input: { box?: string; needs?: string[] } = {}, agent = 'art') => placeBody(store, fixtureSharing(), agent, input, clock.now());
  return { app, store, clock, put, prefer, place };
}
it('uses explicit local metadata and never invents the control host', async () => {
  const { place, put, store } = await setup();
  expect(() => place()).toThrow('No preferred or local box');
  expect(store.ids('box')).toEqual([]);
  put(box('local-runner', { local: true }));
  expect(place()).toBe('local-runner');
  put(box('local-runner', { local: true, owner: 'pollock' }));
  expect(() => place()).toThrow('No preferred or local box');
});
it('takes the first live eligible preference, otherwise waits on the first eligible one', async () => {
  const { place, put, prefer, clock } = await setup([box('a'), box('b'), box('local', { local: true })]);
  prefer(['a', 'b', 'local']);
  expect(place()).toBe('local');
  put(box('b', { lastSeen: clock.now() }));
  expect(place()).toBe('b');
  put(box('a', { lastSeen: clock.now() }));
  expect(place()).toBe('a');
  prefer(['a', 'b']);
  clock.advance(PLACE_UP_MS + 1);
  expect(place()).toBe('a');
  put(box('a', { revokedAt: clock.now() }));
  expect(place()).toBe('b');
  put(box('b', { reportOnly: true }));
  expect(place()).toBe('local');
});
it('counts local as up, honors the exact freshness boundary and does not confuse epoch zero with absent', () => {
  expect(boxUp(box('a'), 0)).toBe(false);
  expect(boxUp(box('a', { lastSeen: 0 }), PLACE_UP_MS)).toBe(true);
  expect(boxUp(box('a', { lastSeen: 0 }), PLACE_UP_MS + 1)).toBe(false);
  expect(boxUp(box('a', { local: true }), 999999)).toBe(true);
  expect(boxUp(box('a', { local: true, revokedAt: 0 }), 1)).toBe(false);
  expect(boxUp(box('a', { local: true, reportOnly: true }), 1)).toBe(false);
});
it('matches exact capability keys, partial values, bare labels and owner labels', async () => {
  expect(meets(['gpu:NVIDIA-GeForce-RTX-5090'], 'gpu:5090')).toBe(true);
  expect(meets(['gpu:nvidia'], 'GPU:nvidia')).toBe(false);
  expect(meets(['gpu:nvidia'], 'gpu')).toBe(true);
  expect(meets(['rig'], 'rig')).toBe(true);
  expect(meets(['rig-other'], 'rig')).toBe(false);
  expect(meets(['gpu'], 'gpu:nvidia')).toBe(false);
  const { place } = await setup([box('a', { facts: ['arch:arm64'] }), box('b', { labels: ['gpu:NVIDIA-5090', 'rig'] })]);
  expect(place({ needs: ['gpu:5090', 'rig'] })).toBe('b');
  expect(() => place({ needs: ['gpu:h100'] })).toThrow('No permitted box has gpu:h100');
  expect(() => place({ needs: ['arch:arm64', 'gpu:5090'] })).toThrow('No one permitted box has all');
});
it('requires explicit choice for several capable boxes unless a preference decides', async () => {
  const { place, prefer, put, clock } = await setup([box('a', { facts: ['gpu:nvidia'] }), box('b', { facts: ['gpu:nvidia'] }), box('local', { local: true })]);
  expect(() => place({ needs: ['gpu:nvidia'] })).toThrow('Several permitted boxes');
  prefer(['b', 'a']);
  expect(place({ needs: ['gpu:nvidia'] })).toBe('b');
  put(box('a', { facts: ['gpu:nvidia'], lastSeen: clock.now() }));
  expect(place({ needs: ['gpu:nvidia'] })).toBe('a');
});
it('explicit placement resolves live ids/names and waits even when silent, but checks every need', async () => {
  const { place } = await setup([box('a', { name: 'rig', facts: ['gpu:5090'] }), box('b', { name: 'rig' }), box('revoked', { revokedAt: 2 })]);
  expect(place({ box: 'a', needs: ['gpu:5090'] })).toBe('a');
  expect(() => place({ box: 'rig' })).toThrow('Several boxes');
  expect(() => place({ box: 'revoked' })).toThrow('No live box');
  expect(() => place({ box: 'missing' })).toThrow('No live box');
  expect(() => place({ box: 'b', needs: ['gpu:5090'] })).toThrow('does not have gpu:5090');
});
it('excludes unowned, disallowed, report-only and revoked hosts even with matching capabilities', async () => {
  const { place, prefer, put } = await setup([
    box('foreign', { owner: 'pollock', facts: ['gpu:5090'] }),
    box('denied', { mayHost: ['pond-bot'], facts: ['gpu:5090'] }),
    box('watch', { reportOnly: true, facts: ['gpu:5090'] }),
    box('gone', { revokedAt: 1, facts: ['gpu:5090'] }),
  ]);
  prefer(['foreign', 'denied', 'watch', 'gone']);
  expect(() => place()).toThrow('No preferred or local box');
  expect(() => place({ needs: ['gpu:5090'] })).toThrow('No permitted box');
  for (const id of ['foreign', 'denied', 'watch']) expect(() => place({ box: id })).toThrow('may not host');
  put(box('foreign', { owner: 'pollock', lentTo: ['art'], facts: ['gpu:5090'] }));
  expect(place({ needs: ['gpu:5090'] })).toBe('foreign');
});
it('placement is read-only and returns an id without queueing, changing preferences or starting jobs', async () => {
  const { place, prefer, store, app } = await setup([box('a')]);
  prefer(['a']);
  const before = app.db.prepare('SELECT * FROM runtime_settings').all();
  expect(place()).toBe('a');
  expect(place()).toBe('a');
  expect(app.db.prepare('SELECT * FROM runtime_settings').all()).toEqual(before);
  expect(store.ids('job')).toEqual([]);
});
