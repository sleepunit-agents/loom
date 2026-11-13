import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { createFoundation, type Foundation } from '../app.js';
import { FakeClock, OperationError, RecoveredWrite, type Context, type Viewer } from '../index.js';

const owner: Viewer = { kind: 'member', id: 'owner' };
const homes: string[] = [], apps: Foundation[] = [];
afterEach(() => { for (const a of apps.splice(0)) a.close(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
function setup(home = mkdtempSync(join(tmpdir(), 'loom-preparation-')), clock = new FakeClock()) {
  if (!homes.includes(home)) homes.push(home);
  const app = createFoundation({ home, clock }); apps.push(app);
  return { app, home, clock };
}
function install(app: Foundation, options: { prepare?: () => Promise<unknown>; recover?: (ctx: Context) => RecoveredWrite | undefined; allowed?: () => boolean; run?: () => unknown; recheckPolicy?: boolean } = {}) {
  const prepare = vi.fn(options.prepare ?? (async () => null));
  const run = vi.fn(options.run ?? (() => ({ saved: true })));
  app.operations.register({ name: 'example.save', input: z.object({ words: z.string() }).strict(), output: z.object({ saved: z.literal(true) }), write: true,
    inputHash: text => createHmac('sha256', Buffer.alloc(32, 9)).update(text).digest('hex'),
    may: options.allowed ?? (() => true), prepare, run, recover: options.recover, recheckPolicy: options.recheckPolicy });
  app.operations.register({ name: 'example.other', input: z.object({ words: z.string() }).strict(), output: z.null(), write: true, may: () => true, run: () => null });
  return { prepare, run };
}
const input = { words: 'private-preparation-sentinel' };

it('checks committed receipts before preparation across restart, doors, changed inputs and operation names', async () => {
  const s = setup(); const first = install(s.app);
  const result = await s.app.operations.callAsync('http', owner, 'example.save', input, 'retry');
  expect(result).toEqual({ ok: true, value: { saved: true } });
  expect(first.prepare).toHaveBeenCalledTimes(1); expect(first.run).toHaveBeenCalledTimes(1);
  s.app.close();
  const { app } = setup(s.home, s.clock), next = install(app, { prepare: async () => { throw Error('must not prepare'); } });
  expect(await app.operations.callAsync('socket', owner, 'example.save', input, 'retry')).toEqual(result);
  expect(await app.operations.callAsync('http', owner, 'example.save', { words: 'different' }, 'retry')).toMatchObject({ code: 'conflict' });
  expect(app.operations.call('direct', owner, 'example.other', input, 'retry')).toMatchObject({ code: 'conflict' });
  expect(next.prepare).not.toHaveBeenCalled(); expect(next.run).not.toHaveBeenCalled();
  expect(JSON.stringify(app.db.prepare('SELECT * FROM core_operations').all())).not.toContain(input.words);
  expect(await app.operations.callAsync('direct', { kind: 'member', id: 'other' }, 'example.save', input, 'retry')).toMatchObject({ code: 'unavailable' });
  expect(next.prepare).toHaveBeenCalledTimes(1);
});

it('rejects another operation receipt before its prepare and checks expiry before new work', async () => {
  const { app, clock } = setup(); const spies = install(app);
  expect(app.operations.call('direct', owner, 'example.other', input, 'shared').ok).toBe(true);
  expect(await app.operations.callAsync('http', owner, 'example.save', input, 'shared')).toMatchObject({ code: 'conflict' });
  expect(spies.prepare).not.toHaveBeenCalled();
  clock.advance(30 * 86400_000);
  expect(await app.operations.callAsync('http', owner, 'example.save', input, 'shared')).toEqual({ ok: true, value: { saved: true } });
  expect(spies.prepare).toHaveBeenCalledTimes(1); expect(spies.run).toHaveBeenCalledTimes(1);
});

it('recovers committed external metadata before preparation and keeps the original retry deadline', async () => {
  const { app, clock } = setup(); const expires = clock.now() + 1000;
  app.db.exec('CREATE TABLE example_recovered(id TEXT)');
  const recover = vi.fn((ctx: Context) => {
    if (ctx.receipt?.id !== 'external') return;
    if (ctx.receipt.name !== 'example.save') throw new OperationError('conflict', 'External receipt mismatch');
    ctx.db.prepare('INSERT INTO example_recovered VALUES (?)').run('saved');
    ctx.changed('example.saved', 'saved');
    return new RecoveredWrite({ saved: true }, expires);
  });
  const spies = install(app, { recover });
  const publicationTransactions: boolean[] = [];
  const changed = app.live.changed.bind(app.live);
  const publish = vi.spyOn(app.live, 'changed').mockImplementation(changes => { publicationTransactions.push(app.db.inTransaction); changed(changes); });
  expect(await app.operations.callAsync('http', owner, 'example.save', input, 'external')).toEqual({ ok: true, value: { saved: true } });
  expect(spies.prepare).not.toHaveBeenCalled(); expect(spies.run).not.toHaveBeenCalled();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(app.db.prepare('SELECT * FROM example_recovered').all()).toEqual([{ id: 'saved' }]);
  expect(app.db.prepare('SELECT expires FROM core_operations').get()).toEqual({ expires });
  expect(publish).toHaveBeenCalledExactlyOnceWith([{ type: 'example.saved', id: 'saved' }]);
  expect(publicationTransactions).toEqual([false]);
  expect(app.operations.call('direct', owner, 'example.other', input, 'external')).toMatchObject({ code: 'conflict' });
});

it('rolls failed recovery back without preparing, recording a result or publishing changes', async () => {
  const { app } = setup(); app.db.exec('CREATE TABLE example_recovered(id TEXT)');
  const spies = install(app, { recover(ctx) {
    ctx.db.prepare('INSERT INTO example_recovered VALUES (?)').run('failed'); ctx.changed('example.saved', 'failed');
    throw new OperationError('conflict', 'External receipt mismatch');
  } });
  const publish = vi.spyOn(app.live, 'changed');
  expect(await app.operations.callAsync('http', owner, 'example.save', input, 'external')).toMatchObject({ code: 'conflict' });
  expect(spies.prepare).not.toHaveBeenCalled(); expect(spies.run).not.toHaveBeenCalled();
  expect(app.db.prepare('SELECT * FROM example_recovered').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual([]); expect(publish).not.toHaveBeenCalled();
});

it('still checks conflicting receipts after concurrent preparation completes', async () => {
  const { app } = setup(); let release!: () => void;
  const spies = install(app, { prepare: () => new Promise<void>(resolve => { release = resolve; }) });
  const pending = app.operations.callAsync('http', owner, 'example.save', input, 'race');
  expect(spies.prepare).toHaveBeenCalledTimes(1);
  expect(app.operations.call('direct', owner, 'example.other', input, 'race').ok).toBe(true);
  release();
  expect(await pending).toMatchObject({ code: 'conflict' }); expect(spies.run).not.toHaveBeenCalled();
});

it.each([['permission', false], ['permission', true], ['authentication', false], ['authentication', true]] as const)('rechecks %s after preparation without committing a receipt (recheckPolicy=%s)', async (ended, recheckPolicy) => {
  const { app } = setup(); let allowed = true, valid = true, release!: () => void;
  const spies = install(app, { allowed: () => allowed, recheckPolicy, prepare: () => new Promise<void>(resolve => { release = resolve; }) });
  const pending = app.operations.callAsync('http', owner, 'example.save', input, 'gate', false, () => valid);
  if (ended === 'permission') allowed = false; else valid = false;
  release(); expect(await pending).toMatchObject({ code: 'denied' }); expect(spies.run).not.toHaveBeenCalled();
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual([]);
});


it.each([false, true])('uses current policy before replay only when explicitly required (recheckPolicy=%s)', async recheckPolicy => {
  const { app } = setup(); let allowed = true;
  const spies = install(app, { allowed: () => allowed, recheckPolicy });
  const result = await app.operations.callAsync('http', owner, 'example.save', input, 'permission-retry');
  expect(result.ok).toBe(true); allowed = false;
  expect(await app.operations.callAsync('http', owner, 'example.save', input, 'permission-retry'))
    .toEqual(recheckPolicy ? expect.objectContaining({ code: 'denied' }) : result);
  expect(await app.operations.callAsync('http', owner, 'example.save', { words: 'changed' }, 'permission-retry'))
    .toMatchObject({ code: recheckPolicy ? 'denied' : 'conflict' });
  expect(await app.operations.callAsync('http', owner, 'example.save', input, 'fresh')).toMatchObject({ code: 'denied' });
  expect(spies.prepare).toHaveBeenCalledTimes(1); expect(spies.run).toHaveBeenCalledTimes(1);
});

it('checks recovery again after preparation when an external receipt becomes available during the await', async () => {
  const { app, clock } = setup(); let available = false, release!: () => void;
  const expires = clock.now() + 1000;
  app.db.exec('CREATE TABLE example_recovered(id TEXT)');
  const recover = vi.fn((ctx: Context) => {
    if (!available) return;
    ctx.db.prepare('INSERT INTO example_recovered VALUES (?)').run('after-prepare');
    ctx.changed('example.saved', 'after-prepare');
    return new RecoveredWrite({ saved: true }, expires);
  });
  const spies = install(app, { recover, prepare: () => new Promise<void>(resolve => { release = resolve; }) });
  const publicationTransactions: boolean[] = [];
  const changed = app.live.changed.bind(app.live);
  const publish = vi.spyOn(app.live, 'changed').mockImplementation(changes => { publicationTransactions.push(app.db.inTransaction); changed(changes); });
  const pending = app.operations.callAsync('http', owner, 'example.save', input, 'late-recovery');
  expect(recover).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled();
  available = true; release();
  expect(await pending).toEqual({ ok: true, value: { saved: true } });
  expect(recover).toHaveBeenCalledTimes(2); expect(spies.prepare).toHaveBeenCalledTimes(1); expect(spies.run).not.toHaveBeenCalled();
  expect(app.db.prepare('SELECT * FROM example_recovered').all()).toEqual([{ id: 'after-prepare' }]);
  expect(app.db.prepare('SELECT expires FROM core_operations').get()).toEqual({ expires });
  expect(publish).toHaveBeenCalledExactlyOnceWith([{ type: 'example.saved', id: 'after-prepare' }]);
  expect(publicationTransactions).toEqual([false]);
});
