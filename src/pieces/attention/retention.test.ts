import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startLoom } from '../../foundation.js';
import { FakeClock, operation, failure, type Viewer, type RecordType } from '../../core/index.js';
import { installAttention } from './index.js';
import { conversationId } from './conversations.js';
import { findingId, median, dueToProgressSeconds, startAttentionRetention } from './retention.js';
const dirs: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const alice: Viewer = { kind: 'member', id: 'alice' }, art: Viewer = { kind: 'agent', id: 'art' };
const sharing = () => ({ members: { alice: { owner: true, agents: ['art'] }, bob: { owner: true, agents: ['art'] }, carol: { owner: false, agents: [] } }, projects: { shared: { members: ['carol'], agents: ['art'] } }, services: {
  reader: { types: ['attention.day', 'attention.finding', 'attention.turn'], operations: [] },
  worker: { types: ['attention.day', 'attention.finding', 'attention.turn'], operations: ['attention.fold', 'attention.retain', 'attention.findings', 'attention.writeFinding'] },
  dayOnly: { types: ['attention.day'], operations: ['attention.retain'] },
} });
const base = { venue: 'relay', place: 'test', at: '2026-07-01T09:00:00Z', from: { kind: 'person', slug: 'alice' }, kind: 'message' };
const reply = { ...base, from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'r', outcome: 'answered' };
const id = conversationId('art', 'relay', 'test');
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-retention-')); dirs.push(home);
  const clock = new FakeClock(Date.parse('2026-11-02T12:00:00Z')), types = new Map<string, RecordType>();
  const app = await startLoom({ home, clock, sharing, install(app) {
    const register = app.live.register.bind(app.live); app.live.register = t => { types.set(t.name, t); register(t); };
    installAttention(app.db, app.operations, app.live, sharing);
  } }); closes.push(app.close);
  let n = 0;
  const call = (name: string, input: unknown, viewer: Viewer = alice, op = `retention-${++n}`) => app.operations.call('direct', viewer, `attention.${name}`, input, op);
  const write = (turn = base, scope: { member?: string; project?: string; agent?: string } = {}) => call('recordTurn', { agent: 'art', ...scope, turn });
  return { app, clock, call, write, types };
}
it('folds complete UTC days, preserves totals, digests and sequence, rejects late turns and never refolds', async () => {
  const { call, write, clock, types } = await setup();
  for (const t of [base, { ...reply, at: '2026-07-01T09:01:00Z', model: 'opus' }, { ...base, at: '2026-07-01T10:00:00Z' }, { ...reply, at: '2026-07-01T10:02:00Z', model: 'opus', outcome: 'failed' }, { ...reply, at: '2026-07-01T11:00:00Z' }, { ...base, at: '2026-08-04T01:00:00Z' }, { ...reply, at: '2026-08-04T20:00:00Z', model: 'opus' }]) expect(write(t)).toMatchObject({ ok: true });
  call('writeDigest', { conversation: id, run: 'r', digest: { summary: 'Kept for good' } });
  const stats = call('stats', { conversation: id });
  expect(stats).toEqual({ ok: true, value: { counts: { message: 3, reply: 4 }, outcomes: { answered: 3, failed: 1 } } });
  expect(call('fold', { conversation: id })).toEqual({ ok: true, value: { days: 1, turns: 5 } });
  expect(call('days', { conversation: id })).toMatchObject({ value: [{ id: `${id}:2026-07-01`, conversation: id, agent: 'art', day: '2026-07-01', counts: { message: 2, reply: 3 }, median_latency_ms: 90000, outcomes: { opus: { answered: 1, failed: 1 }, unknown: { answered: 1 } } }] });
  expect(call('stats', { conversation: id })).toEqual(stats);
  expect(call('turns', { conversation: id })).toMatchObject({ value: [{ seq: 6 }, { seq: 7 }] });
  expect(call('conversation', { id })).toMatchObject({ value: { turns: 7 } });
  expect(call('digests', { conversation: id })).toMatchObject({ value: [{ summary: 'Kept for good' }] });
  expect(types.get('attention.turn')!.read(`${id}:1`, alice)).toBeUndefined();
  expect(call('fold', { conversation: id })).toEqual({ ok: true, value: { days: 0, turns: 0 } });
  expect(write()).toMatchObject({ code: 'conflict' });
  clock.advance(12 * 3600000);
  expect(call('fold', { conversation: id })).toEqual({ ok: true, value: { days: 1, turns: 2 } });
  expect(write({ ...base, at: '2026-11-02T11:00:00Z' })).toMatchObject({ value: { seq: 8 } });
  const days = call('days', { conversation: id });
  if (days.ok) expect((days.value as { day: string }[]).map(d => d.day)).toEqual(['2026-07-01', '2026-08-04']);
});
it('uses a strict cutoff, rounded even medians, null missing latency and arbitrary printable model names', async () => {
  const { write, call, clock } = await setup();
  write({ ...base, at: '2026-08-04T12:00:00Z' });
  expect(call('fold', { conversation: id })).toMatchObject({ value: { days: 0 } });
  clock.advance(1);
  expect(call('fold', { conversation: id })).toMatchObject({ value: { days: 1 } });
  expect(call('days', { conversation: id })).toMatchObject({ value: [{ median_latency_ms: null, outcomes: {} }] });
  for (const t of [base, { ...reply, at: '2026-07-01T09:00:00.001Z', model: '__proto__' }, { ...base, at: '2026-07-01T10:00:00Z' }, { ...reply, at: '2026-07-01T10:00:00.002Z', model: 'constructor' }]) write(t);
  expect(call('fold', { conversation: id })).toMatchObject({ value: { days: 1, turns: 4 } });
  const days = call('days', { conversation: id });
  if (days.ok) {
    const day = (days.value as { outcomes: Record<string, unknown>; median_latency_ms: number }[])[0];
    expect(day.median_latency_ms).toBe(2);
    expect(Object.keys(day.outcomes).sort()).toEqual(['__proto__', 'constructor']);
    expect(day.outcomes.__proto__).toEqual({ answered: 1 });
  }
});
it('caps findings by the turn UTC day, preserves them after fold, and keeps stable retry receipts', async () => {
  const { call, write, clock } = await setup();
  write(base); write(reply); write({ ...reply, at: '2026-07-02T00:00:00Z' });
  const finding = { conversation: id, seq: 2, measure: 'graded', score: 3, text: '  Asked twice before answering.  ' };
  expect(findingId('cv-b28ed6ba6479', '2026-07-01')).toBe('fd-23eeeb15ddcb');
  expect(call('writeFinding', { ...finding, seq: 1 })).toMatchObject({ code: 'conflict' });
  const saved = call('writeFinding', finding, alice, 'finding');
  expect(saved).toMatchObject({ value: { id: findingId(id, '2026-07-01'), day: '2026-07-01', text: 'Asked twice before answering.', score: 3 } });
  expect(call('writeFinding', finding, alice, 'finding')).toEqual(saved);
  expect(call('writeFinding', finding)).toMatchObject({ code: 'conflict' });
  expect(call('writeFinding', { ...finding, seq: 99 })).toMatchObject({ code: 'not-found' });
  const since = new Date(clock.now()).toISOString(); clock.advance(1);
  expect(call('writeFinding', { ...finding, seq: 3, score: null })).toMatchObject({ ok: true });
  expect(call('findings', { since })).toMatchObject({ value: [{ day: '2026-07-02', score: null }] });
  expect(call('fold', { conversation: id })).toMatchObject({ value: { days: 2 } });
  expect(call('writeFinding', finding, alice, 'finding')).toEqual(saved);
  expect(call('writeFinding', { ...finding, seq: 3 })).toMatchObject({ code: 'not-found' });
  const list = call('findings', { conversation: id }); if (list.ok) expect(list.value).toHaveLength(2);
});
it('validates findings and bounds before SQL or retry storage', async () => {
  const { call, app, write } = await setup(); write(reply);
  const finding = { conversation: id, seq: 1, measure: 'graded', score: 3, text: 'Good' };
  const before = app.db.prepare('SELECT count(*) AS n FROM core_operations').get();
  for (const invalid of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(201) }, { text: 'two\nlines' }, { text: 'bad\x7f' }, { seq: 0 }, { seq: 1.5 }, { measure: '' }, { score: 0 }, { score: 6 }, { extra: 'words' }]) expect(call('writeFinding', { ...finding, ...invalid })).toMatchObject({ code: 'invalid' });
  for (const limit of [0, 501, 1.5]) expect(call('findings', { limit })).toMatchObject({ code: 'invalid' });
  expect(call('findings', { since: 'invalid' })).toMatchObject({ code: 'invalid' });
  expect(app.db.prepare('SELECT * FROM attention_findings').all()).toEqual([]);
  expect(app.db.prepare('SELECT count(*) AS n FROM core_operations').get()).toEqual(before);
});
it('applies inherited private and project scope to folds, stats, findings and live records', async () => {
  const { call, write, types } = await setup();
  write(reply, { member: 'alice' });
  const finding = { conversation: id, seq: 1, measure: 'graded', score: null, text: 'Private finding' };
  expect(call('writeFinding', finding)).toMatchObject({ ok: true });
  for (const viewer of [art, { kind: 'member', id: 'bob' }, { kind: 'member', id: 'carol' }, { kind: 'service', id: 'worker' }] as Viewer[]) {
    for (const op of ['fold', 'days', 'stats']) expect(call(op, { conversation: id }, viewer)).toMatchObject({ code: 'denied' });
    expect(call('writeFinding', finding, viewer)).toMatchObject({ code: 'denied' });
    expect(call('findings', {}, viewer)).toEqual({ ok: true, value: [] });
    expect(types.get('attention.finding')!.read(findingId(id, '2026-07-01'), viewer)).toBeUndefined();
  }
  call('fold', { conversation: id });
  expect(types.get('attention.day')!.read(`${id}:2026-07-01`, art)).toBeUndefined();
  expect(types.get('attention.day')!.read(`${id}:2026-07-01`, alice)).toMatchObject({ member: 'alice' });
  expect(types.get('attention.day')!.inScope({ id: 'day', conversation: id }, 'other', 0)).toBe(false);
  // Project visibility alone cannot create an agent's finding (central mayCreate).
  const projectId = conversationId('art', 'relay', 'project'); write({ ...reply, place: 'project' }, { project: 'shared' });
  expect(call('writeFinding', { ...finding, conversation: projectId }, { kind: 'member', id: 'carol' })).toMatchObject({ code: 'denied' });
  expect(call('writeFinding', { ...finding, conversation: projectId }, art)).toMatchObject({ ok: true });
  expect(call('fold', { conversation: projectId }, art)).toMatchObject({ ok: true });
  expect(call('stats', { conversation: projectId }, { kind: 'member', id: 'carol' })).toMatchObject({ value: { counts: { reply: 1 } } });
});
it('requires service operation grants for collections and writes, and both stats source types', async () => {
  const { call, write } = await setup(); write(reply);
  const reader: Viewer = { kind: 'service', id: 'reader' }, worker: Viewer = { kind: 'service', id: 'worker' };
  expect(call('days', { conversation: id }, reader)).toMatchObject({ ok: true });
  expect(call('stats', { conversation: id }, reader)).toMatchObject({ ok: true });
  expect(call('stats', { conversation: id }, { kind: 'service', id: 'dayOnly' })).toMatchObject({ code: 'denied' });
  for (const op of ['fold', 'retain', 'findings']) expect(call(op, op === 'fold' ? { conversation: id } : {}, reader)).toMatchObject({ code: 'denied' });
  expect(call('writeFinding', { conversation: id, seq: 1, measure: 'graded', score: 4, text: 'Checked' }, worker)).toMatchObject({ code: 'denied' });
  expect(call('writeFinding', { conversation: id, seq: 1, measure: 'graded', score: 4, text: 'Checked' })).toMatchObject({ ok: true });
  expect(call('findings', {}, worker)).toMatchObject({ value: [{ text: 'Checked' }] });
  expect(call('retain', {}, worker)).toMatchObject({ value: { days: 1, turns: 1 } });
});
it('rolls back nested folding and findings with receipts and notifications on outer failure', async () => {
  const { app, call, write } = await setup(); write(reply);
  const changed = vi.spyOn(app.live, 'changed');
  app.operations.register(operation({ name: 'test.retention', write: true, input: z.boolean(), output: z.unknown(), may: () => true,
    run(_ctx, abort) {
      expect(call('writeFinding', { conversation: id, seq: 1, measure: 'graded', score: 4, text: 'Checked' })).toMatchObject({ ok: true });
      expect(call('retain', {})).toMatchObject({ value: { days: 1 } });
      expect(changed).not.toHaveBeenCalled(); return abort ? failure('conflict', 'abort') : null;
    },
  }));
  const before = app.db.prepare('SELECT * FROM core_operations').all();
  expect(app.operations.call('direct', alice, 'test.retention', true, 'abort')).toMatchObject({ code: 'conflict' });
  for (const table of ['attention_days', 'attention_findings']) expect(app.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(1);
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  expect(changed).not.toHaveBeenCalled();
  changed.mockImplementation(() => { expect(app.db.inTransaction).toBe(false); });
  expect(app.operations.call('direct', alice, 'test.retention', false, 'commit')).toMatchObject({ ok: true });
  expect(changed).toHaveBeenCalledOnce();
});
it('runs retention only by explicit daemon composition, covers more than the desk limit and stops on close', async () => {
  const { app, clock, write, call } = await setup();
  for (let i = 0; i < 101; i++) write({ ...base, place: `place-${i}` });
  const report = vi.fn(), stop = startAttentionRetention(app.operations, alice, report);
  expect(app.db.prepare('SELECT * FROM attention_days').all()).toEqual([]);
  clock.advance(0);
  expect(report).toHaveBeenLastCalledWith({ ok: true, value: { days: 101, turns: 101 } });
  clock.advance(86400000);
  expect(report).toHaveBeenLastCalledWith({ ok: true, value: { days: 0, turns: 0 } });
  stop(); clock.advance(86400000); expect(report).toHaveBeenCalledTimes(2);
  expect(call('retain', {})).toMatchObject({ value: { days: 0, turns: 0 } });
});
it('ports held-turn due-to-progress grouping and median behavior', () => {
  const t = (seq: number, s: number, kind: 'wake' | 'note' | 'action' | 'reply', run?: string, outcome?: 'none' | 'progressed' | 'answered' | 'deferred') => ({ seq, at: new Date(Date.parse(base.at) + s * 1000).toISOString(), kind, run, outcome });
  expect(median([])).toBeNull(); expect(median([4, 1, 2])).toBe(2); expect(median([1, 2])).toBe(1.5);
  expect(dueToProgressSeconds([t(1, 0, 'wake'), t(2, 10, 'note', 'a', 'none'), t(3, 20, 'action', 'b', 'progressed'), t(4, 60, 'action', 'a', 'progressed'), t(5, 100, 'wake'), t(6, 130, 'reply', 'c', 'deferred'), t(7, 220, 'reply', 'c', 'answered')])).toBe(60);
  expect(dueToProgressSeconds([t(1, 0, 'note', 'a', 'progressed')])).toBeNull();
});
it('orders, filters and limits findings after visibility filtering across conversations and agents', async () => {
  const { call, write, clock } = await setup();
  const add = (agent: string, place: string, text: string, member?: string) => {
    write({ ...reply, place, from: { kind: 'agent', id: agent } }, { agent, ...(member ? { member } : {}) });
    const conversation = conversationId(agent, 'relay', place);
    expect(call('writeFinding', { conversation, seq: 1, measure: 'graded', score: 5, text })).toMatchObject({ ok: true });
    return conversation;
  };
  const first = add('art', 'first', 'First'); clock.advance(1);
  const other = add('other', 'other', 'Other'); clock.advance(1);
  add('art', 'third', 'Third'); clock.advance(1);
  add('art', 'private', 'Private newest', 'alice');
  const texts = (input: unknown, viewer: Viewer = alice) => {
    const result = call('findings', input, viewer); expect(result.ok).toBe(true);
    return result.ok ? (result.value as { text: string }[]).map(f => f.text) : [];
  };
  expect(texts({})).toEqual(['Private newest', 'Third', 'Other', 'First']);
  expect(texts({ limit: 2 })).toEqual(['Private newest', 'Third']);
  expect(texts({ agent: 'art' })).toEqual(['Private newest', 'Third', 'First']);
  expect(texts({ agent: 'other', conversation: first })).toEqual([]);
  expect(texts({ conversation: other })).toEqual(['Other']);
  expect(texts({ agent: 'art', limit: 1 }, { kind: 'member', id: 'bob' })).toEqual(['Third']);
});
it('rejects a second finding on a different own turn of the same day', async () => {
  const { call, write } = await setup(); write(reply); write({ ...reply, at: '2026-07-01T10:00:00Z' });
  const input = { conversation: id, seq: 1, measure: 'graded', score: null, text: 'First' };
  expect(call('writeFinding', input)).toMatchObject({ ok: true });
  expect(call('writeFinding', { ...input, seq: 2, text: 'Second' })).toMatchObject({ code: 'conflict' });
});
it('rolls the whole sweep back when a later nested fold fails', async () => {
  const { app, write, call } = await setup(); write(base); write({ ...base, place: 'second' });
  const original = app.operations.call.bind(app.operations); let folds = 0;
  vi.spyOn(app.operations, 'call').mockImplementation((door, viewer, name, input, op) => {
    if (name === 'attention.fold' && ++folds === 2) return failure('denied', 'injected nested refusal');
    return original(door, viewer, name, input, op);
  });
  const before = app.db.prepare('SELECT * FROM core_operations').all(), changed = vi.spyOn(app.live, 'changed');
  expect(call('retain', {})).toMatchObject({ code: 'denied' });
  expect(folds).toBe(2);
  expect(app.db.prepare('SELECT * FROM attention_days').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(2);
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  expect(changed).not.toHaveBeenCalled();
});
it('sweeps authorized conversations while leaving private and other-agent turns held', async () => {
  const { call, write, app, types } = await setup();
  write(base);
  write({ ...base, place: 'private' }, { member: 'alice' });
  write({ ...base, place: 'other' }, { agent: 'other' });
  const privateId = conversationId('art', 'relay', 'private'), otherId = conversationId('other', 'relay', 'other');
  expect(call('retain', {}, art)).toEqual({ ok: true, value: { days: 1, turns: 1 } });
  expect(call('turns', { conversation: id })).toEqual({ ok: true, value: [] });
  expect(call('turns', { conversation: privateId })).toMatchObject({ value: [{ seq: 1 }] });
  expect(call('turns', { conversation: otherId })).toMatchObject({ value: [{ seq: 1 }] });
  expect(app.db.prepare('SELECT conversation FROM attention_days').all()).toEqual([{ conversation: id }]);
  expect(types.get('attention.day')!.read(`${privateId}:2026-07-01`, art)).toBeUndefined();
  expect(call('retain', {}, { kind: 'service', id: 'dayOnly' })).toEqual({ ok: true, value: { days: 0, turns: 0 } });
  expect(app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(2);
  expect(call('retain', {}, { kind: 'service', id: 'worker' })).toEqual({ ok: true, value: { days: 1, turns: 1 } });
  expect(call('turns', { conversation: privateId })).toMatchObject({ value: [{ seq: 1 }] });
});
