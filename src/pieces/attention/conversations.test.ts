import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startLoom } from '../../foundation.js';
import { FakeClock, operation, failure, migrate, type RecordType, type Viewer } from '../../core/index.js';
import { installAttention } from './index.js';
import { conversationId } from './conversations.js';
import { schema } from './schema/001.js';
const dirs: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sharing = () => ({ members: { alice: { owner: true, agents: ['art'] }, bob: { owner: true, agents: ['art'] }, carol: { owner: false, agents: [] } }, projects: { shared: { members: ['alice'], agents: ['art'] }, other: { members: ['alice'], agents: ['art'] } }, services: {} });
const alice: Viewer = { kind: 'member', id: 'alice' };
const art: Viewer = { kind: 'agent', id: 'art' };
const turn = { venue: 'relay', place: 'test', at: '2026-11-12T00:00:00Z', from: { kind: 'person', slug: 'alice' }, kind: 'message' };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-conversation-')); dirs.push(home);
  const types = new Map<string, RecordType>();
  const app = await startLoom({ home, clock: new FakeClock(), sharing, install(app) {
    // Exercise upgrade from the already-shipped ask/status schema, preserving its data.
    migrate(app.db, 'attention', schema);
    app.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run('existing', '{"id":"existing"}');
    app.db.prepare('INSERT INTO attention_statuses VALUES (?,?)').run('existing-status', '{"id":"existing-status"}');
    const register = app.live.register.bind(app.live);
    app.live.register = t => { types.set(t.name, t); register(t); };
    installAttention(app.db, app.operations, app.live, sharing);
  } });
  closes.push(app.close); let n = 0;
  const call = (name: string, input: unknown, viewer: Viewer = alice, key = `op-${++n}`) => app.operations.call('direct', viewer, `attention.${name}`, input, key);
  const write = (t: unknown = turn, viewer = alice, key?: string) => call('recordTurn', { agent: 'art', turn: t }, viewer, key);
  return { app, call, write, types };
}
it('upgrades without losing asks; preserves ids, sequence, participants, bounds and reply latency', async () => {
  const { app, call, write } = await setup();
  expect(app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([{ id: 'existing', record: '{"id":"existing"}' }]);
  const id = conversationId('art', 'relay', 'test');
  expect(id).toBe('cv-b28ed6ba6479');
  expect(app.db.prepare('SELECT * FROM attention_statuses').all()).toEqual([{ id: 'existing-status', record: '{"id":"existing-status"}' }]);
  const first = write({ ...turn, label: 'Test' }, art, 'delivery');
  expect(first).toEqual({ ok: true, value: { conversation: id, seq: 1 } });
  expect(write({ ...turn, label: 'Test' }, art, 'delivery')).toEqual(first);
  expect(write(turn, art, 'delivery')).toMatchObject({ code: 'conflict' });
  write({ ...turn, at: '2026-11-12T00:00:01.000Z', from: { kind: 'agent', id: 'other' } });
  expect(write({ ...turn, at: '2026-11-12T00:00:03Z', kind: 'reply', from: { kind: 'agent', id: 'art' }, run: 'run-1', outcome: 'answered', model: 'test', harness: 'test' })).toMatchObject({ value: { seq: 3, latency_ms: 3000 } });
  expect(write({ ...turn, kind: 'reply', from: { kind: 'agent', id: 'art' }, run: 'run-1', outcome: 'none' })).toMatchObject({ value: { seq: 4 } });
  write({ ...turn, at: '2026-11-11T23:00:00Z', label: 'Renamed' });
  expect(call('conversation', { id })).toMatchObject({ value: { id, agent: 'art', label: 'Renamed', people: ['alice'], agents: ['other'], projects: [], started: '2026-11-11T23:00:00.000Z', last: '2026-11-12T00:00:03.000Z', turns: 5 } });
  const turns = call('turns', { conversation: id, after: 2, limit: 1 });
  expect(turns).toMatchObject({ value: [{ seq: 3, latency_ms: 3000, model: 'test', harness: 'test', writer: alice }] });
  expect(call('turns', { conversation: id, after: 3, limit: 1 })).toMatchObject({ value: [{ seq: 4 }] });
  if (turns.ok) expect((turns.value as object[])[0]).not.toHaveProperty('label');
});
it('rejects words, unknown nested fields and invalid own turns before any storage', async () => {
  const { app, write } = await setup();
  for (const bad of [
    { ...turn, text: 'secret words' }, { ...turn, from: { ...turn.from, text: 'secret words' } },
    { ...turn, run: 'run-1' }, { ...turn, model: 'test' }, { ...turn, harness: 'test' }, { ...turn, outcome: 'none' },
    { ...turn, kind: 'reply' },
    ...['reply', 'action', 'note'].flatMap(kind => [
      { ...turn, kind, from: { kind: 'agent', id: 'art' }, outcome: 'none' },
      { ...turn, kind, from: { kind: 'agent', id: 'art' }, run: 'run-1' },
    ]), { ...turn, kind: 'action', from: { kind: 'agent', id: 'other' }, run: 'run-1', outcome: 'none' },
    { ...turn, kind: 'note', from: { kind: 'agent', id: 'art' }, run: 'bad run', outcome: 'none' },
    { ...turn, venue: 'Bad' }, { ...turn, place: '' }, { ...turn, at: 'not-time' }, { ...turn, label: 'x'.repeat(81) },
  ]) expect(write(bad)).toMatchObject({ code: 'invalid' });
  expect(app.db.prepare('SELECT * FROM attention_conversations').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM attention_turns').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual([]);
});
it('keeps member scope immutable and filters reads and live metadata through central policy', async () => {
  const { call, types } = await setup();
  const input = { agent: 'art', member: 'alice', turn };
  expect(call('recordTurn', input, art)).toMatchObject({ code: 'denied' });
  expect(call('recordTurn', input)).toMatchObject({ ok: true });
  const id = conversationId('art', 'relay', 'test');
  expect(call('recordTurn', { agent: 'art', turn })).toMatchObject({ code: 'denied' });
  for (const viewer of [art, { kind: 'member', id: 'bob' }, { kind: 'member', id: 'carol' }] as Viewer[]) {
    expect(call('recordTurn', input, viewer)).toMatchObject({ code: 'denied' });
    expect(call('conversation', { id }, viewer)).toMatchObject({ code: 'denied' });
    expect(call('turns', { conversation: id }, viewer)).toMatchObject({ code: 'denied' });
    expect(call('conversations', {}, viewer)).toEqual({ ok: true, value: [] });
    for (const [name, recordId] of [['attention.conversation', id], ['attention.turn', `${id}:1`]]) expect(types.get(name)!.read(recordId, viewer)).toBeUndefined();
  }
  expect(call('conversations', {})).toMatchObject({ value: [{ id }] });
  expect(types.get('attention.turn')!.read(`${id}:1`, alice)).toMatchObject({ conversation: id, member: 'alice' });
});
it('caps participant sets but keeps all turns, and filters and orders conversation lists', async () => {
  const { call, write } = await setup();
  for (let n = 0; n < 35; n++) write({ ...turn, from: { kind: 'person', slug: `person-${n}` } });
  for (let n = 0; n < 18; n++) write({ ...turn, from: { kind: 'agent', id: `agent-${n}` } });
  write({ ...turn, place: 'new', at: '2026-11-12T01:00:00Z' });
  const id = conversationId('art', 'relay', 'test');
  const held = call('conversation', { id });
  expect(held).toMatchObject({ value: { turns: 53 } });
  if (held.ok) { const c = held.value as { people: string[]; agents: string[] }; expect(c.people).toHaveLength(32); expect(c.agents).toHaveLength(16); }
  expect(call('conversations', { limit: 1 })).toMatchObject({ value: [{ place: 'new' }] });
  expect(call('conversations', { people: 'person-0', venue: 'relay', agent: 'art' })).toMatchObject({ value: [{ id }] });
  expect(call('conversations', { since: '2026-11-12T00:30:00Z' })).toMatchObject({ value: [{ place: 'new' }] });
});
it('rolls back nested metadata writes and only publishes changes after the outer commit', async () => {
  const { app, write } = await setup();
  const changed = vi.spyOn(app.live, 'changed');
  app.operations.register(operation({ name: 'test.turn', write: true, input: z.boolean(), output: z.unknown(), may: () => true,
    run(_ctx, abort) { expect(write()).toMatchObject({ ok: true }); expect(changed).not.toHaveBeenCalled(); return abort ? failure('conflict', 'abort') : null; },
  }));
  expect(app.operations.call('direct', alice, 'test.turn', true, 'abort')).toMatchObject({ code: 'conflict' });
  expect(app.db.prepare('SELECT * FROM attention_conversations').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM attention_turns').all()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
  changed.mockImplementation(() => { expect(app.db.inTransaction).toBe(false); });
  expect(app.operations.call('direct', alice, 'test.turn', false, 'commit')).toMatchObject({ ok: true });
  expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'attention.conversation', id: conversationId('art', 'relay', 'test') }, { type: 'attention.turn', id: `${conversationId('art', 'relay', 'test')}:1` }]);
});

it('only times messages after the previous reply and clamps a clock-skewed reply to zero', async () => {
  const { write } = await setup();
  const reply = { ...turn, from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'run-1', outcome: 'answered' };
  write(turn);
  expect(write({ ...reply, at: '2026-11-12T00:00:10Z' })).toMatchObject({ value: { latency_ms: 10000 } });
  write({ ...turn, at: '2026-11-12T00:00:20Z' });
  write({ ...turn, at: '2026-11-12T00:00:21Z' });
  expect(write({ ...reply, at: '2026-11-12T00:00:23Z' })).toMatchObject({ value: { latency_ms: 3000 } });
  write({ ...turn, at: '2026-11-12T00:01:00Z' });
  expect(write({ ...reply, at: '2026-11-12T00:00:59Z' })).toMatchObject({ value: { latency_ms: 0 } });
});
it('persists project scope on both records and refuses changing or removing it', async () => {
  const { call, types } = await setup();
  const id = conversationId('art', 'relay', 'test');
  const input = { agent: 'art', project: 'shared', turn };
  expect(call('recordTurn', input, art)).toMatchObject({ ok: true });
  expect(call('recordTurn', { ...input, project: 'other' })).toMatchObject({ code: 'denied' });
  expect(call('recordTurn', { agent: 'art', turn })).toMatchObject({ code: 'denied' });
  expect(call('recordTurn', { ...input, member: 'alice' })).toMatchObject({ code: 'denied' });
  expect(call('conversation', { id })).toMatchObject({ value: { project: 'shared', agent: 'art' } });
  expect(call('turns', { conversation: id })).toMatchObject({ value: [{ project: 'shared', agent: 'art' }] });
  for (const [name, recordId] of [['attention.conversation', id], ['attention.turn', `${id}:1`]]) {
    expect(types.get(name)!.read(recordId, art)).toMatchObject({ project: 'shared', agent: 'art' });
    expect(types.get(name)!.read(recordId, { kind: 'member', id: 'carol' })).toBeUndefined();
  }
});

it('times the first recorded pending message even when later deliveries have earlier timestamps', async () => {
  const { write } = await setup();
  write({ ...turn, at: '2026-11-12T00:00:20Z' });
  write({ ...turn, at: '2026-11-12T00:00:10Z' });
  expect(write({ ...turn, at: '2026-11-12T00:00:23Z', kind: 'reply', from: { kind: 'agent', id: 'art' }, run: 'run-1', outcome: 'answered' })).toMatchObject({ value: { latency_ms: 3000 } });
});
