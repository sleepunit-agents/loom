import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startLoom } from '../../foundation.js';
import { FakeClock, operation, failure, type Viewer, type RecordType } from '../../core/index.js';
import { installAttention } from './index.js';
import { conversationId } from './conversations.js';
import { digestId } from './digests.js';
const dirs: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const alice: Viewer = { kind: 'member', id: 'alice' }, art: Viewer = { kind: 'agent', id: 'art' };
const sharing = () => ({ members: { alice: { owner: true, agents: ['art'] }, bob: { owner: true, agents: ['art'] }, carol: { owner: false, agents: [] }, dave: { owner: false, agents: [] } }, projects: { shared: { members: ['alice', 'carol'], agents: ['art'] }, beta: { members: ['dave'], agents: [] } }, services: { reader: { types: ['attention.digest'], operations: [] }, listed: { types: ['attention.digest'], operations: ['attention.digests'] }, writer: { types: ['attention.digest'], operations: ['attention.writeDigest'] } } });
const conversation = conversationId('art', 'relay', 'test');
const question = { ask: 'Continue with the change?', if_yes: 'I finish it.', if_no: 'I stop.', refs: ['t-40'] };
async function setup(scope = {}) {
  const home = mkdtempSync(join(tmpdir(), 'attention-digest-')); dirs.push(home);
  const types = new Map<string, RecordType>();
  const app = await startLoom({ home, clock: new FakeClock(), sharing, install(app) {
    const register = app.live.register.bind(app.live); app.live.register = t => { types.set(t.name, t); register(t); };
    installAttention(app.db, app.operations, app.live, sharing);
  } }); closes.push(app.close); let seq = 0;
  const call = (name: string, input: unknown, viewer = alice, id = `test-${++seq}`) => app.operations.call('direct', viewer, `attention.${name}`, input, id);
  expect(call('recordTurn', { agent: 'art', ...scope, turn: { venue: 'relay', place: 'test', at: '2026-11-12T00:00:00Z', from: { kind: 'person', slug: 'alice' }, kind: 'message' } })).toMatchObject({ ok: true });
  const write = (digest: object, run = 'run-1', viewer = art, id?: string) => call('writeDigest', { conversation, run, digest: { summary: 'Made progress.', ...digest } }, viewer, id);
  return { app, call, write, types };
}
it('keeps the old digest identity, replaces per run, and gives each deliberate ask its own revision', async () => {
  const { call, write } = await setup();
  const first = write({ needs_owner: question }, 'run-1', art, 'retry');
  expect(first).toMatchObject({ ok: true, value: { id: digestId(conversation, 'run-1'), revision: 1, order: 1 } });
  if (!first.ok) throw new Error('write failed');
  const d = first.value as { ask: string };
  expect(call('get', { id: d.ask })).toMatchObject({ value: { state: 'open', agent: 'art', source: { kind: 'conversation', id: conversation }, answers: 'yes-no' } });
  expect(call('answer', { id: d.ask, answer: { kind: 'yes' } })).toMatchObject({ ok: true });
  expect(write({ needs_owner: question }, 'run-1', art, 'retry')).toEqual(first);
  expect(call('get', { id: d.ask })).toMatchObject({ value: { state: 'answered' } });
  expect(write({ needs_owner: question })).toMatchObject({ value: { revision: 2, ask: `${digestId(conversation, 'run-1')}:2` } });
  expect(call('get', { id: d.ask })).toMatchObject({ value: { state: 'answered', answer: { kind: 'yes' } } });
  expect(call('digests', { conversation })).toMatchObject({ value: [{ revision: 2, order: 2 }] });
});
it('uses commit order at the same clock, clears older asks including other runs, and keeps the current project union', async () => {
  const { call, write } = await setup();
  write({ needs_owner: question, projects: ['alpha'] });
  write({ needs_owner: 'Help me choose.', projects: ['beta'] }, 'run-2');
  expect(call('get', { id: `${digestId(conversation, 'run-1')}:1` })).toMatchObject({ value: { state: 'resolved' } });
  expect(call('get', { id: `${digestId(conversation, 'run-2')}:1` })).toMatchObject({ value: { answers: 'words', state: 'open' } });
  write({ projects: ['gamma', 'gamma'], needs_owner: null });
  expect(call('get', { id: `${digestId(conversation, 'run-2')}:1` })).toMatchObject({ value: { state: 'resolved' } });
  expect(call('digests', { conversation })).toMatchObject({ value: [{ run: 'run-1', order: 3, ask: null }, { run: 'run-2', order: 2 }] });
  expect(call('conversation', { id: conversation })).toMatchObject({ value: { projects: ['beta', 'gamma'] } });
});
it('preserves question validation and caps before receipt or digest storage', async () => {
  const { app, write } = await setup();
  const receipts = app.db.prepare('SELECT count(*) AS n FROM core_operations').get();
  for (const digest of [ { summary: '' }, { summary: 'x'.repeat(601) }, { text: 'delivered words' }, { asks: Array(9).fill('ask') }, { tasks: ['x'.repeat(65)] }, { decisions: [' '] }, { decisions: Array(9).fill('decision') }, { tasks: Array(17).fill('t-40') }, { asks: ['x'.repeat(201)] }, { projects: ['a', 'b', 'c', 'd', 'e'] }, { needs_owner: 'x'.repeat(201) }, { needs_owner: { ask: 'x'.repeat(141) } }, ...['why', 'if_yes', 'if_no', 'href'].map(field => ({ needs_owner: { ask: 'OK?', [field]: 'x'.repeat(field === 'why' ? 241 : field === 'href' ? 501 : 141) } })), { projects: ['Not a slug'] }, { needs_owner: { ...question, text: 'secret' } }, { needs_owner: { ask: 'Merge t-40?' } }, { needs_owner: { ask: 'OK?', waits_on: { pr: 'x#1' } } }, { needs_owner_href: 'https://example.com' }, { needs_owner: question, needs_owner_href: 'http://example.com' } ]) expect(write(digest)).toMatchObject({ code: 'invalid' });
  expect(app.db.prepare('SELECT * FROM attention_digests').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
  expect(app.db.prepare('SELECT count(*) AS n FROM core_operations').get()).toEqual(receipts);
  expect(write({ needs_owner: question, needs_owner_href: 'https://example.com' })).toMatchObject({ value: { needs_owner: { href: 'https://example.com' } } });
});
it('inherits scope, filters live and reads, and rolls back if nested central ask policy refuses', async () => {
  const { call, write, types, app } = await setup({ member: 'alice' });
  expect(write({ needs_owner: question })).toMatchObject({ code: 'denied' });
  expect(write({ needs_owner: question }, 'run-1', alice)).toMatchObject({ ok: true });
  for (const viewer of [art, { kind: 'member', id: 'bob' }, { kind: 'service', id: 'reader' }] as Viewer[]) {
    expect(call('digests', { conversation }, viewer)).toMatchObject({ code: 'denied' });
    expect(types.get('attention.digest')!.read(digestId(conversation, 'run-1'), viewer)).toBeUndefined();
  }
  expect(types.get('attention.digest')!.read(digestId(conversation, 'run-1'), alice)).toMatchObject({ member: 'alice' });
  expect(call('get', { id: `${digestId(conversation, 'run-1')}:1` })).toMatchObject({ value: { member: 'alice' } });
  expect(types.get('attention.digest')!.inScope({ id: 'd', conversation } as never, conversation)).toBe(true);
  expect(app.db.prepare('SELECT count(*) AS n FROM attention_digests').get()).toEqual({ n: 1 });
});
it('rolls back digests, asks, conversation projects, receipts and notifications with an outer abort', async () => {
  const { app, call, write } = await setup();
  const changed = vi.spyOn(app.live, 'changed');
  app.operations.register(operation({ name: 'test.digest', write: true, input: z.boolean(), output: z.unknown(), may: () => true,
    run(_ctx, abort) { expect(write({ needs_owner: question, projects: ['alpha'] }, 'run-1', alice)).toMatchObject({ ok: true }); expect(changed).not.toHaveBeenCalled(); return abort ? failure('conflict', 'abort') : null; },
  }));
  expect(app.operations.call('direct', alice, 'test.digest', true, 'abort')).toMatchObject({ code: 'conflict' });
  expect(app.db.prepare('SELECT * FROM attention_digests').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
  expect(call('conversation', { id: conversation })).toMatchObject({ value: { projects: [] } });
  expect(changed).not.toHaveBeenCalled();
  changed.mockImplementation(() => { expect(app.db.inTransaction).toBe(false); });
  expect(app.operations.call('direct', alice, 'test.digest', false, 'commit')).toMatchObject({ ok: true });
  expect(changed).toHaveBeenCalledTimes(1);
});
it('requires all central grants for nested ask writes and leaves no partial digest on denial', async () => {
  const { app, write, call } = await setup();
  const service: Viewer = { kind: 'service', id: 'writer' };
  expect(write({ needs_owner: question }, 'run-1', service)).toMatchObject({ code: 'denied' });
  expect(app.db.prepare('SELECT * FROM attention_digests').all()).toEqual([]);
  expect(write({}, 'run-1', service)).toMatchObject({ code: 'denied' });
  expect(write({}, 'run-1', alice)).toMatchObject({ ok: true });
  expect(write({}, 'run-1', service)).toMatchObject({ ok: true });
  expect(call('digests', { conversation }, { kind: 'service', id: 'reader' })).toMatchObject({ code: 'denied' });
  expect(call('digests', { conversation }, { kind: 'service', id: 'listed' })).toMatchObject({ value: [{ run: 'run-1' }] });
});
it('preserves authored fields on replacement and pins the legacy hash vector', async () => {
  const { write, call } = await setup();
  expect(digestId(conversation, 'run-1')).toBe('dg-29237ec06e2f');
  const fields = { summary: '  First summary.  ', asks: ['  First ask  '], decisions: ['First decision'], tasks: ['t-40'] };
  expect(write(fields)).toMatchObject({ value: { summary: 'First summary.', asks: ['First ask'], decisions: ['First decision'], tasks: ['t-40'] } });
  expect(call('digests', { conversation })).toMatchObject({ value: [{ summary: 'First summary.', asks: ['First ask'], decisions: ['First decision'], tasks: ['t-40'] }] });
  const replacement = { summary: 'Replacement.', asks: ['New ask'], decisions: ['New decision'], tasks: ['t-41'] };
  expect(write(replacement)).toMatchObject({ value: replacement });
  expect(call('digests', { conversation })).toMatchObject({ value: [replacement] });
});
it('bounds digest collection defaults, explicit limits and invalid limits', async () => {
  const { write, call } = await setup();
  for (let n = 0; n < 102; n++) expect(write({}, `run-${n}`)).toMatchObject({ ok: true });
  const defaults = call('digests', { conversation });
  if (!defaults.ok) throw new Error('read failed');
  expect(defaults.value).toHaveLength(100);
  expect(call('digests', { conversation, limit: 1 })).toMatchObject({ value: [{ run: 'run-101' }] });
  const max = call('digests', { conversation, limit: 500 });
  if (!max.ok) throw new Error('read failed');
  expect(max.value).toHaveLength(102);
  for (const limit of [0, 501, 1.5]) expect(call('digests', { conversation, limit })).toMatchObject({ code: 'invalid' });
});
it('inherits policy project independently from replaceable digest reference projects', async () => {
  const { write, call, types } = await setup({ project: 'shared' });
  expect(write({ projects: ['alpha'], needs_owner: question })).toMatchObject({ value: { project: 'shared', projects: ['alpha'] } });
  expect(call('get', { id: `${digestId(conversation, 'run-1')}:1` })).toMatchObject({ value: { project: 'shared' } });
  expect(write({ projects: ['beta'] })).toMatchObject({ value: { project: 'shared', projects: ['beta'] } });
  expect(call('conversation', { id: conversation })).toMatchObject({ value: { project: 'shared', projects: ['beta'] } });
  expect(types.get('attention.digest')!.read(digestId(conversation, 'run-1'), art)).toMatchObject({ project: 'shared' });
  expect(call('digests', { conversation }, { kind: 'member', id: 'carol' })).toMatchObject({ value: [{ project: 'shared' }] });
  expect(call('digests', { conversation }, { kind: 'member', id: 'dave' })).toMatchObject({ code: 'denied' });
  expect(types.get('attention.digest')!.read(digestId(conversation, 'run-1'), { kind: 'member', id: 'dave' })).toBeUndefined();
});
it('rolls back earlier nested resolutions when a later resolution refuses', async () => {
  const { app, call, write } = await setup();
  write({ needs_owner: question, projects: ['alpha'] });
  write({ needs_owner: question, projects: ['beta'] }, 'run-2');
  const before = ['attention_asks', 'attention_digests', 'attention_conversations', 'core_operations'].map(table => app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const changed = vi.spyOn(app.live, 'changed');
  const original = app.operations.call.bind(app.operations); let resolves = 0;
  const intercept = vi.spyOn(app.operations, 'call').mockImplementation((door, viewer, name, input, id) => {
    if (name === 'attention.resolve' && ++resolves === 2) return failure('denied', 'Resolution refused');
    return original(door, viewer, name, input, id);
  });
  expect(write({ needs_owner: null, projects: ['gamma'] })).toMatchObject({ code: 'denied' });
  expect(resolves).toBe(2); intercept.mockRestore();
  expect(['attention_asks', 'attention_digests', 'attention_conversations', 'core_operations'].map(table => app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
  expect(changed).not.toHaveBeenCalled();
  expect(call('get', { id: `${digestId(conversation, 'run-2')}:1` })).toMatchObject({ value: { state: 'open' } });
});
it('restores an open ask when a subsequent nested raise is refused', async () => {
  const { app, write, call } = await setup();
  write({ needs_owner: question });
  const original = app.operations.call.bind(app.operations);
  const intercept = vi.spyOn(app.operations, 'call').mockImplementation((door, viewer, name, input, id) => name === 'attention.raise' ? failure('denied', 'Raise refused') : original(door, viewer, name, input, id));
  expect(write({ needs_owner: question, projects: ['new'] })).toMatchObject({ code: 'denied' });
  intercept.mockRestore();
  expect(call('get', { id: `${digestId(conversation, 'run-1')}:1` })).toMatchObject({ value: { state: 'open' } });
  expect(call('digests', { conversation })).toMatchObject({ value: [{ revision: 1, projects: [] }] });
});

it('requires separate agent and project visibility when creating a digest', async () => {
  const { app, write, call } = await setup({ project: 'shared' });
  const carol: Viewer = { kind: 'member', id: 'carol' };
  expect(call('conversation', { id: conversation }, carol)).toMatchObject({ ok: true });
  expect(write({}, 'run-new', carol)).toMatchObject({ code: 'denied' });
  expect(app.db.prepare('SELECT * FROM attention_digests').all()).toEqual([]);
  expect(write({}, 'run-new', art)).toMatchObject({ ok: true });
  expect(call('digests', { conversation }, carol)).toMatchObject({ value: [{ run: 'run-new' }] });
});
