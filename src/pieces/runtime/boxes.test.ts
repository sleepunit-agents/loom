import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer, type Sharing } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
import type { RuntimeRecords } from './records.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const box = (id: string, extra: Partial<RuntimeRecords['box']> = {}): RuntimeRecords['box'] => ({ id, name: id, owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1, ...extra });
async function setup(sharing: () => Sharing = fixtureSharing) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-boxes-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, next: true, sharing }); cleanups.push(app.close);
  const store = runtimeStore(app.db);
  app.db.transaction(() => {
    for (const b of [box('local', { local: true, alwaysOn: true }), box('r1', { name: 'one' }), box('r2', { name: 'wunder' }), box('pond', { owner: 'pollock', mayHost: ['pond-bot'] })]) store.put('box', b, 1);
  })();
  let seq = 0;
  const call = (op: string, input: unknown, viewer: Viewer = owner, id = `op-${++seq}`) => app.operations.call('direct', viewer, `runtime.${op}`, input, id);
  return { app, clock, store, call };
}
it('configures existing box metadata without accepting credentials or creating boxes', async () => {
  const { call, store } = await setup();
  expect(call('configureBox', { box: 'one', set: { owner: 'pollock', mayHost: ['pond-bot'], lentTo: ['art'], labels: ['gpu:5090'], alwaysOn: true } })).toEqual({ ok: true, value: { box: 'r1' } });
  expect(store.read('box', 'r1')).toMatchObject({ owner: 'pollock', lentTo: ['art'], labels: ['gpu:5090'], alwaysOn: true });
  expect(call('configureBox', { box: 'absent', set: {} })).toMatchObject({ ok: false, code: 'not-found' });
  expect(call('configureBox', { box: 'one', set: { token: 'secret' } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(call('configureBox', { box: 'one', set: { owner: 'missing' } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(store.ids('box')).toHaveLength(4);
});
it('limits household controls to household owners even with explicit service grants', async () => {
  const { call, store } = await setup(() => ({ ...fixtureSharing(), services: { svc: { types: ['runtime.box', 'runtime.settings'], operations: ['runtime.configureBox', 'runtime.setBoxes'] } } }));
  for (const viewer of [{ kind: 'agent', id: 'art' }, { kind: 'runner', id: 'r1' }, { kind: 'member', id: 'pollock' }, { kind: 'member', id: 'missing' }, { kind: 'service', id: 'svc' }] as Viewer[]) {
    expect(call('configureBox', { box: 'one', set: { mayHost: [] } }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  }
  expect(store.read('box', 'r1')?.mayHost).toBe('*');
});
it('resolves exact ids first, rejects ambiguous live names and ignores revoked names', async () => {
  const { app, call, store } = await setup();
  app.db.transaction(() => { store.put('box', box('twin', { name: 'one' }), 1); store.put('box', box('shadow', { name: 'local' }), 1); })();
  expect(call('configureBox', { box: 'one', set: { labels: ['x'] } })).toMatchObject({ ok: false, code: 'conflict' });
  expect(call('configureBox', { box: 'r1', set: { labels: ['x'] } })).toMatchObject({ ok: true, value: { box: 'r1' } });
  expect(call('configureBox', { box: 'local', set: { labels: ['exact'] } })).toMatchObject({ ok: true, value: { box: 'local' } });
  app.db.transaction(() => store.put('box', box('twin', { name: 'one', revokedAt: 2 }), 2))();
  expect(call('configureBox', { box: 'one', set: {} })).toMatchObject({ ok: true, value: { box: 'r1' } });
  expect(call('configureBox', { box: 'twin', set: {} })).toMatchObject({ ok: false, code: 'not-found' });
});
it('keeps local runners hosting and counts report-only runners as always on', async () => {
  const { call, store } = await setup();
  expect(call('configureBox', { box: 'local', set: { reportOnly: true, alwaysOn: false } }).ok).toBe(true);
  expect(store.read('box', 'local')).toMatchObject({ reportOnly: false, alwaysOn: true });
  expect(call('configureBox', { box: 'one', set: { reportOnly: true, alwaysOn: false } }).ok).toBe(true);
  expect(store.read('box', 'r1')).toMatchObject({ reportOnly: true, alwaysOn: true });
});
it('stores ordered preferences, canonicalizes references and preserves unrelated settings', async () => {
  const { app, call, store } = await setup();
  app.db.transaction(() => store.put('settings', { id: 'art', agent: 'art', boxes: [], model: 'gpt-6.1-sol' }, 1))();
  expect(call('setBoxes', { agent: 'art', boxes: ['one', 'wunder', 'local'] })).toEqual({ ok: true, value: { agent: 'art', boxes: ['r1', 'r2', 'local'] } });
  expect(store.read('settings', 'art')).toMatchObject({ boxes: ['r1', 'r2', 'local'], model: 'gpt-6.1-sol' });
  expect(call('setBoxes', { agent: 'art', boxes: ['local'] })).toMatchObject({ ok: true, value: { boxes: [] } });
  expect(call('setBoxes', { agent: 'art', boxes: [] })).toMatchObject({ ok: true, value: { boxes: [] } });
});
it('rejects duplicate, missing, revoked, report-only, unowned and disallowed preferences atomically', async () => {
  const { app, call, store } = await setup();
  expect(call('setBoxes', { agent: 'art', boxes: ['one'] }).ok).toBe(true);
  for (const [boxes, code] of [[['one', 'r1'], 'invalid'], [['wunder', 'missing'], 'not-found'], [['pond'], 'conflict'], [Array(9).fill('one'), 'invalid']] as [string[], string][]) {
    expect(call('setBoxes', { agent: 'art', boxes })).toMatchObject({ ok: false, code });
    expect(store.read('settings', 'art')?.boxes).toEqual(['r1']);
  }
  app.db.transaction(() => { store.put('box', box('r2', { revokedAt: 2 }), 2); })();
  expect(call('setBoxes', { agent: 'art', boxes: ['r2'] })).toMatchObject({ ok: false, code: 'not-found' });
  expect(call('configureBox', { box: 'one', set: { reportOnly: true } }).ok).toBe(true);
  expect(call('setBoxes', { agent: 'art', boxes: ['one'] })).toMatchObject({ ok: false, code: 'conflict' });
});
it('checks agent setup centrally and requires both host permission and ownership or a loan', async () => {
  const { call, store } = await setup();
  const pollock: Viewer = { kind: 'member', id: 'pollock' };
  expect(call('setBoxes', { agent: 'pond-bot', boxes: ['pond'] }, pollock).ok).toBe(true);
  expect(call('setBoxes', { agent: 'art', boxes: [] }, pollock)).toMatchObject({ ok: false, code: 'denied' });
  for (const viewer of [{ kind: 'agent', id: 'art' }, { kind: 'runner', id: 'r1' }, { kind: 'service', id: 'keyholder' }] as Viewer[]) expect(call('setBoxes', { agent: 'art', boxes: [] }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  expect(call('setBoxes', { agent: 'pond-bot', boxes: ['one'] }, pollock)).toMatchObject({ ok: false, code: 'conflict' });
  expect(call('configureBox', { box: 'one', set: { lentTo: ['pond-bot'], mayHost: ['art'] } }).ok).toBe(true);
  expect(call('setBoxes', { agent: 'pond-bot', boxes: ['one'] }, pollock)).toMatchObject({ ok: false, code: 'conflict' });
  expect(call('configureBox', { box: 'one', set: { mayHost: '*' } }).ok).toBe(true);
  expect(call('setBoxes', { agent: 'pond-bot', boxes: ['one'] }, pollock).ok).toBe(true);
  expect(store.read('settings', 'pond-bot')?.boxes).toEqual(['r1']);
});
it('deduplicates retries, rejects changed retry input and preserves timestamps on no-op writes', async () => {
  const { call, clock, store } = await setup();
  const input = { box: 'one', set: { labels: ['gpu'] } };
  expect(call('configureBox', input, owner, 'stable').ok).toBe(true);
  const at = store.read('box', 'r1')?.changedAt;
  clock.advance(100);
  expect(call('configureBox', input, owner, 'stable').ok).toBe(true);
  expect(call('configureBox', input).ok).toBe(true);
  expect(store.read('box', 'r1')?.changedAt).toBe(at);
  expect(call('configureBox', { box: 'one', set: { labels: [] } }, owner, 'stable')).toMatchObject({ ok: false, code: 'conflict' });
});
