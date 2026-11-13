import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, operation, type Context, type Viewer } from '../../core/index.js';
import { installAttention } from './index.js';
import type { Ask, HouseholdAskSource } from './role.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'pond-bot' };
async function setup(hook: (ctx: Context, ask: Ask) => void = () => {}, supplied?: string, registered = true) {
  const home = supplied ?? mkdtempSync(join(tmpdir(), 'loom-source-')); if (!supplied) homes.push(home);
  let source: HouseholdAskSource | undefined;
  const app = await startLoom({ home, clock: new FakeClock(), sharing: fixtureSharing, install: a => {
    const sources = installAttention(a.db, a.operations, a.live, fixtureSharing);
    if (!registered) return;
    source = sources.register('fixture', hook);
    const other = sources.register('other', () => {});
    a.operations.register(operation({ name: 'fixture.raise', write: true, input: z.object({ id: z.string(), agent: z.string().optional() }), output: z.null(), may: () => true,
      run(ctx, input) { source!.raise(ctx, { ...input, ask: 'Allow this?', answers: 'yes-no' }); return null; } }));
    a.operations.register(operation({ name: 'fixture.other', write: true, input: z.object({ id: z.string() }), output: z.null(), may: () => true,
      run(ctx, input) { other.resolve(ctx, input.id, 'Cross source'); return null; } }));
  } }); closes.push(app.close);
  let seq = 0; const session = randomUUID();
  const call = (name: string, input: unknown, viewer = owner) => app.operations.call('direct', viewer, name, input, `op-${session}-${++seq}`);
  return { home, app, call, source: source! };
}
it('bounds a source to household scope, its own records and the enclosing database transaction', async () => {
  const hook = vi.fn(); const { app, call, source } = await setup(hook);
  expect(() => source.raise({ db: app.db, viewer: agent, now: 1, changed() {} }, { id: 'outside', ask: 'Invalid?' })).toThrow('transaction');
  expect(call('fixture.raise', { id: 'scoped', agent: agent.id }, agent)).toMatchObject({ ok: false, code: 'invalid' });
  expect(call('fixture.raise', { id: 'one' }, agent).ok).toBe(true);
  expect(call('fixture.other', { id: 'one' })).toMatchObject({ ok: false, code: 'conflict' });
  expect(call('attention.raise', { id: 'one', ask: 'Override?', source: { kind: 'piece', id: 'other' } })).toMatchObject({ ok: false, code: 'denied' });
  expect(call('attention.answer', { id: 'one', answer: { kind: 'yes' } }).ok).toBe(true);
  expect(hook).toHaveBeenCalledTimes(1); expect(hook.mock.calls[0][0].viewer).toEqual(owner);
  expect(call('fixture.raise', { id: 'one' }, agent).ok).toBe(true);
  expect(call('attention.answer', { id: 'one', answer: { kind: 'yes' } })).toMatchObject({ ok: false, code: 'conflict' });
  expect(hook).toHaveBeenCalledTimes(1);
});
it('refuses an asynchronous source answer and rolls back its synchronous writes', async () => {
  const hook = (async (ctx: Context) => { ctx.db.prepare('DELETE FROM attention_statuses').run(); throw Error('fixture'); }) as unknown as (ctx: Context, ask: Ask) => void;
  const { app, call } = await setup(hook);
  app.db.prepare('INSERT INTO attention_statuses VALUES (?,?)').run('keep', '{}');
  expect(call('fixture.raise', { id: 'one' }, agent).ok).toBe(true);
  expect(call('attention.answer', { id: 'one', answer: { kind: 'yes' } })).toMatchObject({ ok: false, code: 'unavailable' });
  expect(app.db.prepare('SELECT id FROM attention_statuses').all()).toEqual([{ id: 'keep' }]);
  expect(call('attention.get', { id: 'one' })).toMatchObject({ ok: true, value: { state: 'open' } });
});
it('fails closed after restart when a persisted source ask has no installed handler', async () => {
  const first = await setup(); expect(first.call('fixture.raise', { id: 'one' }, agent).ok).toBe(true);
  await first.app.close(); closes.pop();
  const { call } = await setup(undefined, first.home, false);
  expect(call('attention.answer', { id: 'one', answer: { kind: 'yes' } })).toMatchObject({ ok: false, code: 'unavailable' });
  expect(call('attention.resolve', { id: 'one', reason: 'Detach' })).toMatchObject({ ok: false, code: 'denied' });
  expect(call('attention.get', { id: 'one' })).toMatchObject({ ok: true, value: { state: 'open' } });
});
it('never promotes a public source label into a capability when the source is installed later', async () => {
  const first = await setup(undefined, undefined, false);
  expect(first.call('attention.raise', { id: 'forged', agent: agent.id, ask: 'Forged scope?', answers: 'yes-no', source: { kind: 'piece', id: 'fixture' } }, agent).ok).toBe(true);
  await first.app.close(); closes.pop();
  const hook = vi.fn(); const second = await setup(hook, first.home);
  expect(second.call('attention.raise', { id: 'forged', agent: agent.id, ask: 'Changed?', answers: 'yes-no', source: { kind: 'piece', id: 'fixture' } }, agent)).toMatchObject({ ok: true, value: { ask: 'Forged scope?', agent: agent.id, state: 'open' } });
  expect(second.call('fixture.raise', { id: 'forged' }, agent)).toMatchObject({ ok: false, code: 'conflict' });
  expect(second.call('fixture.other', { id: 'forged' })).toMatchObject({ ok: false, code: 'conflict' });
  expect(second.call('attention.get', { id: 'forged' })).toMatchObject({ ok: true, value: { state: 'open', agent: agent.id } });
  // The old public record retains only its original policy; it never calls a trusted handler.
  expect(second.call('attention.answer', { id: 'forged', answer: { kind: 'yes' } }).ok).toBe(true);
  expect(hook).not.toHaveBeenCalled();
  const record = second.app.db.prepare('SELECT record FROM attention_asks WHERE id=?').get('forged') as {record: string};
  expect(JSON.parse(record.record)).not.toHaveProperty('sourceManaged');
});
