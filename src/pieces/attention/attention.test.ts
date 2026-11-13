import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { z } from 'zod';
import { FakeClock, operation, failure, mayCreate, type RecordType, type Viewer } from '../../core/index.js';
import { installAttention } from './index.js';
const dirs: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sharing = () => ({ members: { alice: { owner: true, agents: ['art'] }, bob: { owner: true, agents: ['art'] } }, projects: {}, services: {} });
async function setup(install = true, next = false) {
  const types = new Map<string, RecordType>();
  const home = mkdtempSync(join(tmpdir(), 'attention-')); dirs.push(home);
  if (next) fixture(home);
  const app = await startLoom({ home, next, clock: new FakeClock(), sharing, install: install ? app => {
    const register = app.live.register.bind(app.live);
    app.live.register = type => { types.set(type.name, type); register(type); };
    installAttention(app.db, app.operations, app.live, sharing);
  } : undefined });
  closes.push(app.close); let n = 0;
  const call = (name: string, input: unknown, viewer: Viewer = { kind: 'member', id: 'alice' }, key = `operation-${++n}`) => app.operations.call('direct', viewer, `attention.${name}`, input, key);
  return { app, call, types };
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
  expect(call('resolve', { id: ask.id, reason: 'Hidden' }, { kind: 'member', id: 'bob' })).toMatchObject({ code: 'denied' });
  expect(call('raise', privateAsk, { kind: 'member', id: 'bob' })).toMatchObject({ code: 'denied' });
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

it('requires explicit installation for tables, operations and live registrations', async () => {
  const { app, call, types } = await setup(false);
  expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'attention_%'").all()).toEqual([]);
  expect(app.operations.offered('direct').filter(op => op.name.startsWith('attention.'))).toEqual([]);
  expect(call('raise', ask)).toMatchObject({ code: 'not-found' });
  // Installing now must succeed, including both live registrations (no hidden duplicates).
  installAttention(app.db, app.operations, app.live, sharing);
  expect(app.operations.has('attention.raise')).toBe(true);
  expect(types.size).toBe(0);
});
it('filters both live types for visible and invisible viewers', async () => {
  const { call, types } = await setup();
  call('raise', { ...ask, member: 'alice' });
  call('reportStatus', { id: 'art', agent: 'art', member: 'alice', state: 'idle', work: '', jobs: [], watched: [] });
  for (const [name, id] of [['attention.ask', ask.id], ['attention.agent', 'art']]) {
    const type = types.get(name)!;
    expect(type.ids(undefined)).toEqual([id]);
    expect(type.read(id, { kind: 'member', id: 'alice' })).toMatchObject({ id });
    expect(type.read(id, { kind: 'member', id: 'bob' })).toBeUndefined();
    expect(type.read(id, { kind: 'agent', id: 'art' })).toBeUndefined();
  }
});
it('rolls back nested writes and notifications, then publishes only after commit', async () => {
  const { app, call } = await setup();
  const changed = vi.spyOn(app.live, 'changed');
  app.operations.register(operation({ name: 'test.raise', write: true, input: z.boolean(), output: z.unknown(), may: () => true,
    run(_ctx, fail) {
      expect(call('raise', ask)).toMatchObject({ ok: true });
      expect(app.db.inTransaction).toBe(true);
      expect(changed).not.toHaveBeenCalled();
      return fail ? failure('conflict', 'Abort outer operation') : null;
    },
  }));
  expect(app.operations.call('direct', { kind: 'member', id: 'alice' }, 'test.raise', true, 'abort')).toMatchObject({ code: 'conflict' });
  expect(app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
  changed.mockImplementation(() => { expect(app.db.inTransaction).toBe(false); });
  expect(app.operations.call('direct', { kind: 'member', id: 'alice' }, 'test.raise', false, 'commit')).toMatchObject({ ok: true });
  expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'attention.ask', id: ask.id }]);
});
it('preserves open and resolved identity and every status audience field', async () => {
  const { call } = await setup();
  const first = call('raise', ask);
  expect(call('raise', { ...ask, ask: 'Changed?' })).toEqual(first);
  const resolved = call('resolve', { id: ask.id, reason: 'External fact' });
  expect(call('raise', { ...ask, ask: 'Reopen?' })).toEqual(resolved);
  const status = { id: 'art', agent: 'art', state: 'idle', work: '', jobs: [], watched: [] };
  call('reportStatus', status);
  for (const scope of [{ member: 'alice' }, { project: 'new' }, { agent: 'other' }]) {
    expect(mayCreate({ kind: 'member', id: 'alice' }, { type: 'attention.agent', ...status, ...scope }, sharing(), 'attention.reportStatus')).toBe(true);
    expect(call('reportStatus', { ...status, ...scope })).toMatchObject({ code: 'denied' });
  }
});

it.each([undefined, 'yes-no', 'words'] as const)('records public words for answer mode %s with first-answer and retry semantics', async answers => {
  const { call } = await setup(true, true);
  expect(call('raise', { ...ask, ...(answers ? { answers } : {}) })).toMatchObject({ ok: true });
  const input = { id: ask.id, answer: { kind: 'words', text: '  Continue after the small fix.  ' } };
  const first = call('answer', input, undefined, 'public-words');
  expect(first).toMatchObject({ ok: true, value: { state: 'answered', answer: { kind: 'words', text: 'Continue after the small fix.', by: { id: 'alice' } } } });
  expect(call('answer', input, undefined, 'public-words')).toEqual(first);
  expect(call('answer', { id: ask.id, answer: { kind: 'no' } }, { kind: 'member', id: 'bob' })).toMatchObject({ code: 'conflict' });
});
it.each([undefined, 'yes-no', 'words'] as const)('never persists private reply words in mode %s, even from the private member', async answers => {
  const { app, call } = await setup(true, true);
  call('raise', { ...ask, member: 'alice', ...(answers ? { answers } : {}) });
  const before = app.db.prepare('SELECT * FROM core_operations').all();
  const changed = vi.spyOn(app.live, 'changed');
  expect(call('answer', { id: ask.id, answer: { kind: 'words', text: 'private-reply-canary' } })).toMatchObject({ code: 'invalid' });
  expect(call('get', { id: ask.id })).toMatchObject({ value: { state: 'open' } });
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  expect(JSON.stringify(app.db.prepare('SELECT * FROM attention_asks').all())).not.toContain('private-reply-canary');
  expect(changed).not.toHaveBeenCalled();
});
