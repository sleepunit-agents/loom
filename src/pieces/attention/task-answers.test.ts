import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock, failure, type Viewer } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { attentionWaits } from './wait-roles.js';
const success = (value: unknown) => ({ ok: true as const, value });
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const since = Date.parse('2026-11-13T12:00:00Z');
const ask = 'Can you check the backup restored?';
const comment = (text = `Yes, to: ${ask}`, actor = 'jonathan', at = new Date(since).toISOString()) => ({ text, actor, at });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
it.each(['Yes', 'No', 'Answer'])('matches only the first line of an attributed %s answer, ignoring Unicode/case/spacing', prefix => {
  const call = vi.fn(() => success({ result: { ok: true, task: { comments: [comment(`${prefix}, to: ＣＡＮ you  check the BACKUP restored?\nIf yes, you said: I check it.`)] } } }));
  const waits = attentionWaits({ check: () => undefined }, { call }, () => 'jonathan');
  expect(waits.taskAnswered!('t-1', ask, since, owner)).toBe(true);
  expect(call).toHaveBeenCalledExactlyOnceWith(owner, 'show', { id: 't-1' });
});
it('holds on unrelated, old, malformed or unattributed comments, including answer-shaped later lines', () => {
  const comments = [comment(undefined, 'mark'), comment('No, to: Buy a spare?'), comment(undefined, undefined, new Date(since - 1).toISOString()), comment(undefined, undefined, 'invalid'), comment(`Discussion\nYes, to: ${ask}`), comment(`yes, to: ${ask}`), null, {}, 'words'];
  const call = vi.fn(() => success({ result: { ok: true, task: { comments } } }));
  const waits = attentionWaits({ check: () => undefined }, { call }, () => 'jonathan');
  expect(waits.taskAnswered!('t-1', ask, since, owner)).toBe(false);
  expect(waits.taskAnswered!('t-1', '  ', since, owner)).toBe(false);
});
it('holds without a configured owner, on hidden/failed/malformed reads, and compares times chronologically', () => {
  const call = vi.fn(() => success({ result: { ok: true, task: { comments: [comment(undefined, undefined, '2026-11-13T12:00:00Z')] } } }));
  const waits = attentionWaits({ check: () => undefined }, { call }, () => 'jonathan');
  expect(waits.taskAnswered!('t-1', ask, since + 1, owner)).toBe(false);
  expect(waits.taskAnswered!('t-1', ask, since, owner)).toBe(true);
  expect(attentionWaits({ check: () => undefined }, { call }).taskAnswered!('t-1', ask, since, owner)).toBeUndefined();
  for (const response of [failure('denied', 'PRIVATE'), success({ result: { ok: false } }), success({ result: { ok: true, task: { comments: {} } } })]) {
    expect(attentionWaits({ check: () => undefined }, { call: () => response }, () => 'jonathan').taskAnswered!('t-1', ask, since, owner)).toBeUndefined();
  }
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-task-answers-')); fixture(home);
  const clock = new FakeClock(since);
  const app = await startLoom({ home, next: true, clock, stdout: () => {} });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const household = new HouseholdDatabase(app.db);
  household.change(home, raw => { raw.owner = 'jonathan'; });
  let seq = 0;
  const call = (name: string, input: unknown, viewer = owner, id = `task-answer-${++seq}`) => app.operations.call('direct', viewer, name, input, id);
  const raise = (id: string, task = 't-1', extra = {}) => call('attention.raise', { id, agent: 'art', ask, source: { kind: 'conversation', id: 'cv-test' }, waits_on: { task }, ...extra });
  const add = (task: string, c = comment()) => call('tasks.comment', { id: task, ...c });
  return { app, clock, call, raise, add, household, home };
}
it('next mode resolves an open task wait from the owner comment without storing reply words or a human answer', async () => {
  const { app, call, raise, add } = await setup();
  expect(raise('answer')).toMatchObject({ ok: true });
  const pending = call('attention.checkWait', { id: 'answer' }, owner, 'pending');
  expect(pending).toMatchObject({ value: { state: 'open' } });
  expect(add('t-1', comment(`Answer, to: ${ask}\nPRIVATE REPLY WORDS`))).toMatchObject({ value: { result: { ok: true } } });
  expect(call('attention.checkWait', { id: 'answer' }, owner, 'pending')).toEqual(pending);
  const changed = vi.spyOn(app.live, 'changed');
  const resolved = call('attention.checkWait', { id: 'answer' }, owner, 'fresh');
  expect(resolved).toMatchObject({ ok: true, value: { state: 'resolved', resolution: 'you answered it on t-1' } });
  if (resolved.ok) expect(resolved.value).not.toHaveProperty('answer');
  expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'attention.ask', id: 'answer' }]);
  expect(call('attention.checkWait', { id: 'answer' }, owner, 'fresh')).toEqual(resolved);
  expect(JSON.stringify(app.db.prepare('SELECT * FROM attention_asks').all())).not.toContain('PRIVATE REPLY WORDS');
  expect(JSON.stringify(app.db.prepare("SELECT * FROM core_operations WHERE name LIKE 'attention.%'").all())).not.toContain('PRIVATE REPLY WORDS');
});
it('uses the live configured owner and original viewer, holding hidden tasks and preserving a central human answer', async () => {
  const { call, raise, add, household, home } = await setup();
  raise('hidden', 't-2', { project: 'pond' }); add('t-2');
  expect(call('attention.checkWait', { id: 'hidden' }, { kind: 'member', id: 'pollock' })).toMatchObject({ value: { state: 'open' } });
  raise('changed-owner'); add('t-1');
  household.change(home, raw => { delete raw.owner; });
  expect(call('attention.checkWait', { id: 'changed-owner' })).toMatchObject({ value: { state: 'open' } });
  household.change(home, raw => { raw.owner = 'jonathan'; });
  expect(call('attention.checkWait', { id: 'changed-owner' })).toMatchObject({ value: { state: 'resolved' } });
  raise('answered'); call('attention.answer', { id: 'answered', answer: { kind: 'no' } });
  expect(call('attention.checkWait', { id: 'answered' })).toMatchObject({ value: { state: 'answered', answer: { kind: 'no' } } });
});
it('rolls back comment-driven resolution on nested refusal, then permits a fresh retry', async () => {
  const { app, call, raise, add } = await setup();
  raise('rollback'); add('t-1');
  const original = app.operations.call.bind(app.operations);
  const before = app.db.prepare('SELECT * FROM core_operations ORDER BY rowid').all();
  const changes = vi.spyOn(app.live, 'changed');
  vi.spyOn(app.operations, 'call').mockImplementation((door, viewer, name, input, id) => name === 'attention.resolve' ? failure('denied', 'PRIVATE') : original(door, viewer, name, input, id));
  expect(call('attention.checkWait', { id: 'rollback' }, owner, 'retry')).toMatchObject({ code: 'denied' });
  expect(app.db.prepare('SELECT * FROM core_operations ORDER BY rowid').all()).toEqual(before);
  expect(changes).not.toHaveBeenCalled();
  expect(call('attention.get', { id: 'rollback' })).toMatchObject({ value: { state: 'open' } });
  vi.restoreAllMocks();
  expect(call('attention.checkWait', { id: 'rollback' }, owner, 'retry')).toMatchObject({ value: { state: 'resolved' } });
});
