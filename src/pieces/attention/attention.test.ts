import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installAttention } from './index.js';
const dirs: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sharing = () => ({ members: { alice: { owner: true, agents: ['art'] }, bob: { owner: true, agents: ['art'] } }, projects: {}, services: {} });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-')); dirs.push(home);
  const app = await startLoom({ home, clock: new FakeClock(), sharing, install: app => installAttention(app.db, app.operations, app.live, sharing) });
  closes.push(app.close); let n = 0;
  const call = (name: string, input: unknown, viewer: Viewer = { kind: 'member', id: 'alice' }, key = `operation-${++n}`) => app.operations.call('direct', viewer, `attention.${name}`, input, key);
  return { app, call };
}
const ask = { id: 'ask-1', agent: 'art', ask: 'Continue?', source: { kind: 'piece', id: 'example' } };
it('keeps stable asks immutable, first answer wins across owners, and retries return the receipt', async () => {
  const { call } = await setup();
  expect(call('raise', ask)).toMatchObject({ ok: true, value: { state: 'open' } });
  expect(call('answer', { id: ask.id, answer: { kind: 'yes' } }, { kind: 'agent', id: 'art' })).toMatchObject({ code: 'denied' });
  const input = { id: ask.id, answer: { kind: 'yes' } };
  const first = call('answer', input, undefined, 'first');
  expect(first).toMatchObject({ ok: true, value: { state: 'answered', answer: { kind: 'yes', by: { id: 'alice' } } } });
  expect(call('answer', input, undefined, 'first')).toEqual(first);
  expect(call('answer', { id: ask.id, answer: { kind: 'no' } }, { kind: 'member', id: 'bob' })).toMatchObject({ code: 'conflict' });
  expect(call('raise', { ...ask, ask: 'Changed?', member: 'bob' })).toEqual(first);
  expect(call('resolve', { id: ask.id, reason: 'Closed elsewhere' })).toEqual(first);
});
it('hides private asks, refuses agent private creates and resolves without a human answer', async () => {
  const { call } = await setup();
  const privateAsk = { ...ask, member: 'alice' };
  expect(call('raise', privateAsk, { kind: 'agent', id: 'art' })).toMatchObject({ code: 'denied' });
  expect(call('raise', privateAsk)).toMatchObject({ ok: true });
  expect(call('get', { id: ask.id }, { kind: 'member', id: 'bob' })).toMatchObject({ code: 'denied' });
  const resolved = call('resolve', { id: ask.id, reason: 'Task closed' });
  expect(resolved).toMatchObject({ ok: true, value: { state: 'resolved', resolution: 'Task closed' } });
  if (resolved.ok) expect(resolved.value).not.toHaveProperty('answer');
  expect(call('answer', { id: ask.id, answer: { kind: 'done' } })).toMatchObject({ code: 'conflict' });
});
it('validates answer mode and prevents status scope changes', async () => {
  const { call } = await setup();
  call('raise', { ...ask, answers: 'words' });
  expect(call('answer', { id: ask.id, answer: { kind: 'yes' } })).toMatchObject({ code: 'invalid' });
  expect(call('answer', { id: ask.id, answer: { kind: 'words', text: 'Go ahead' } })).toMatchObject({ ok: true });
  const status = { id: 'art', agent: 'art', state: 'idle', work: '', jobs: [], watched: [] };
  expect(call('reportStatus', status, { kind: 'agent', id: 'art' })).toMatchObject({ ok: true });
  expect(call('reportStatus', { ...status, member: 'alice' })).toMatchObject({ code: 'denied' });
});
