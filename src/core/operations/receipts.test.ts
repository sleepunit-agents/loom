import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDataSchema } from '../data/database.js';
import { OperationResults, type ReceiptPersistence } from '../data/operation-results.js';
import { FakeClock } from '../clock.js';
import { Operations, RecoveredWrite } from './index.js';
import type { Viewer } from '../../policy.js';

const owner: Viewer = { kind: 'member', id: 'owner' };
const other: Viewer = { kind: 'member', id: 'other' };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function setup(transform: (store: ReceiptPersistence) => ReceiptPersistence = store => store) {
  const client = new Database(':memory:');
  const clock = new FakeClock();
  const shared = createDataSchema(client, () => new Date(clock.now()).toISOString());
  const store = new OperationResults(shared);
  const publicationTransactions: boolean[] = [];
  const committed = vi.fn(() => { publicationTransactions.push(client.inTransaction); });
  const options = { receipts: transform(store) };
  const operations = new Operations(client, clock, committed, options);
  cleanup.push(() => client.close(), () => operations.close());
  const run = vi.fn((ctx: { changed(type: string, id: string): void }, input: { name: string }) => {
    client.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run(input.name, input.name);
    ctx.changed('project', input.name);
    return { saved: input.name };
  });
  const register = (target = operations) => target.register({ name: 'example.save', input: z.object({ name: z.string() }),
    output: z.object({ saved: z.string() }), write: true, may: () => true, run });
  register();
  return { client, clock, store, operations, committed, run, register, options, publicationTransactions };
}

it('uses shared receipts across registries and doors without bootstrapping any legacy table', () => {
  const s = setup();
  const result = s.operations.call('http', owner, 'example.save', { name: 'pond' }, 'retry');
  expect(result).toEqual({ ok: true, value: { saved: 'pond' } });
  s.operations.close();
  const reopened = new Operations(s.client, s.clock, s.committed, s.options);
  cleanup.push(() => reopened.close()); s.register(reopened);
  expect(reopened.call('socket', owner, 'example.save', { name: 'pond' }, 'retry')).toEqual(result);
  expect(reopened.call('direct', owner, 'example.save', { name: 'changed' }, 'retry')).toMatchObject({ code: 'conflict' });
  expect(reopened.call('http', other, 'example.save', { name: 'another' }, 'retry').ok).toBe(true);
  expect(s.run).toHaveBeenCalledTimes(2);
  expect(s.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 2 });
  expect(s.client.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'core_%'").all()).toEqual([]);
  expect(s.publicationTransactions).toEqual([false, false]);
});

it('rolls back effects and notifications when receipt storage fails, then permits a safe retry', () => {
  let fail = true;
  const s = setup(store => ({ get: store.get.bind(store), expire: store.expire.bind(store), nextExpiry: store.nextExpiry.bind(store),
    recover: store.recover.bind(store), insert(receipt) { store.insert(receipt); if (fail) throw Error('receipt failure'); } }));
  expect(s.operations.call('http', owner, 'example.save', { name: 'pond' }, 'retry')).toMatchObject({ code: 'unavailable' });
  expect(s.client.prepare('SELECT * FROM projects').all()).toEqual([]);
  expect(s.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  expect(s.committed).not.toHaveBeenCalled();
  fail = false;
  expect(s.operations.call('http', owner, 'example.save', { name: 'pond' }, 'retry').ok).toBe(true);
  expect(s.committed).toHaveBeenCalledExactlyOnceWith([{ type: 'project', id: 'pond' }]);
});

it('schedules expiry, expires before replay even without timer delivery, and cancels on close', () => {
  const s = setup();
  const timers = new Map<number, () => void>();
  const cancel = vi.fn();
  const heldClock = { now: () => s.clock.now(), at(time: number, fn: () => void) { timers.set(time, fn); return () => { cancel(); timers.delete(time); }; } };
  s.operations.close();
  const ops = new Operations(s.client, heldClock, () => {}, s.options); cleanup.push(() => ops.close()); s.register(ops);
  expect(ops.call('http', owner, 'example.save', { name: 'first' }, 'retry').ok).toBe(true);
  const deadline = s.clock.now() + 30 * 86400_000;
  expect([...timers.keys()]).toEqual([deadline]);
  expect(ops.retryDeadline(owner, 'retry', 'example.save')).toBe(deadline);
  s.clock.advance(30 * 86400_000);
  expect(ops.retryDeadline(owner, 'retry', 'example.save')).toBeUndefined();
  expect(s.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  expect(ops.call('http', owner, 'example.save', { name: 'second' }, 'retry').ok).toBe(true);
  expect(s.run).toHaveBeenCalledTimes(2);
  expect([...timers.keys()]).toEqual([deadline + 30 * 86400_000]);
  const expiry = [...timers.values()][0];
  s.clock.advance(30 * 86400_000); expiry();
  expect(s.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  expect(timers.size).toBe(0);
  expect(ops.call('http', owner, 'example.save', { name: 'third' }, 'next').ok).toBe(true);
  ops.close(); expect(timers.size).toBe(0); expect(cancel).toHaveBeenCalled();
});

it('recovers into shared receipts with the original deadline and preserves current replay authorization', async () => {
  const s = setup(); let allowed = true;
  const run = vi.fn(); const prepare = vi.fn(async () => null);
  const expires = s.clock.now() + 1234;
  s.operations.register({ name: 'example.recover', input: z.object({}), output: z.string(), write: true,
    may: () => allowed, recheckPolicy: true, prepare, run,
    recover: ctx => ctx.receipt?.id === 'external' ? new RecoveredWrite('recovered', expires) : undefined });
  expect(await s.operations.callAsync('http', owner, 'example.recover', {}, 'external')).toEqual({ ok: true, value: 'recovered' });
  expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  expect(s.operations.retryDeadline(owner, 'external', 'example.recover')).toBe(expires);
  const caller = JSON.stringify({ id: 'owner', kind: 'member' });
  const receipt = s.store.get(caller, 'external')!;
  expect(s.operations.recoverWrite(owner, { viewer: caller, id: 'external', name: receipt.operation,
    inputHash: receipt.inputHash, expires })).toEqual({ ok: true, value: 'recovered' });
  expect(s.operations.recoverWrite(owner, { viewer: caller, id: 'external', name: receipt.operation,
    inputHash: 'different', expires })).toMatchObject({ code: 'conflict' });
  allowed = false;
  expect(await s.operations.callAsync('socket', owner, 'example.recover', {}, 'external')).toMatchObject({ code: 'denied' });
  s.clock.advance(1234);
  expect(s.store.get(caller, 'external')).toBeUndefined();
});

it('expires conflicting stored receipts before trusted recovery and keeps installed retry identities separate', () => {
  const s = setup();
  const internal = s.operations.internal('installed');
  s.operations.register({ name: 'example.private', input: z.object({}), output: z.string(), write: true,
    may: () => false, run: () => 'internal' });
  expect(internal.call('example.private', {}, 'same')).toEqual({ ok: true, value: 'internal' });
  expect(s.operations.call('http', { kind: 'service', id: 'installed' }, 'example.private', {}, 'same')).toMatchObject({ code: 'denied' });
  expect(s.operations.call('http', internal.viewer, 'example.private', {}, 'same')).toMatchObject({ code: 'denied' });
  const caller = JSON.stringify({ id: 'owner', kind: 'member' });
  s.store.insert({ caller, id: 'expired', operation: 'example.old', inputHash: 'old', result: { ok: true, value: null }, expires: s.clock.now() });
  const expires = s.clock.now() + 1000;
  s.operations.register({ name: 'example.recovered', input: z.object({}), output: z.string(), write: true,
    may: () => false, run: () => null, recover: () => new RecoveredWrite('saved', expires) });
  expect(s.operations.recoverWrite(owner, { viewer: caller, id: 'expired', name: 'example.recovered', inputHash: 'new', expires }))
    .toEqual({ ok: true, value: 'saved' });
  expect(s.store.get(caller, 'expired')?.operation).toBe('example.recovered');
  s.operations.close();
  expect(internal.call('example.private', {}, 'same')).toMatchObject({ code: 'denied' });
});

it('keeps committed effects and receipts successful when publication throws, without repeating the effect', () => {
  const s = setup();
  s.committed.mockImplementation(() => { throw Error('subscriber unavailable'); });
  const result = s.operations.call('http', owner, 'example.save', { name: 'pond' }, 'retry');
  expect(result).toEqual({ ok: true, value: { saved: 'pond' } });
  expect(s.client.prepare('SELECT * FROM projects').all()).toEqual([{ id: 'pond', name: 'pond', removed_at: null }]);
  expect(s.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 1 });
  expect(s.operations.call('socket', owner, 'example.save', { name: 'pond' }, 'retry')).toEqual(result);
  expect(s.run).toHaveBeenCalledTimes(1);
  expect(s.committed).toHaveBeenCalledTimes(1);
});

it('expires before command replay when the store gained an expired receipt without a timer', () => {
  const s = setup();
  s.store.insert({ caller: JSON.stringify({ id: 'owner', kind: 'member' }), id: 'retry', operation: 'example.save',
    inputHash: 'old', result: { ok: true, value: { saved: 'old' } }, expires: s.clock.now() });
  expect(s.operations.call('http', owner, 'example.save', { name: 'fresh' }, 'retry'))
    .toEqual({ ok: true, value: { saved: 'fresh' } });
  expect(s.run).toHaveBeenCalledTimes(1);
});
it('asks may again before answering any write\'s retry from its receipt or from a recovered commit, with no flag needed', () => {
  const s = setup();
  let allowed = true, committedOutside = false;
  const output = z.object({ saved: z.string() }), input = z.object({ name: z.string() });
  const secret = vi.fn(() => ({ saved: 'for the owner only' }));
  s.operations.register({ name: 'example.plain', input, output, write: true, may: () => allowed, run: secret });
  s.operations.register({ name: 'example.recovered', input, output, write: true, may: () => allowed, run: secret,
    recover: ctx => committedOutside && ctx.receipt?.name === 'example.recovered' ? new RecoveredWrite({ saved: 'committed outside' }, ctx.now + 1000) : undefined });
  // may reads what the write changes, so it opts out: the honest retry of a finished write is still answered.
  let waiting = true;
  s.operations.register({ name: 'example.once', input, output, write: true, recheckPolicy: false, may: () => waiting, run: () => { waiting = false; return { saved: 'answered' }; } });
  expect(s.operations.call('http', owner, 'example.plain', { name: 'a' }, 'plain')).toEqual({ ok: true, value: { saved: 'for the owner only' } });
  expect(s.operations.call('http', owner, 'example.plain', { name: 'a' }, 'plain')).toEqual({ ok: true, value: { saved: 'for the owner only' } });
  expect(s.operations.call('http', owner, 'example.once', { name: 'a' }, 'once')).toEqual({ ok: true, value: { saved: 'answered' } });
  allowed = false; committedOutside = true;
  // The same caller, id and input after losing the right: no stored result, no recovered one.
  expect(s.operations.call('http', owner, 'example.plain', { name: 'a' }, 'plain')).toEqual({ ok: false, code: 'denied', message: 'Permission denied' });
  expect(s.operations.call('http', owner, 'example.recovered', { name: 'a' }, 'recovered')).toEqual({ ok: false, code: 'denied', message: 'Permission denied' });
  expect(secret).toHaveBeenCalledTimes(1);
  expect(s.operations.call('http', owner, 'example.once', { name: 'a' }, 'once')).toEqual({ ok: true, value: { saved: 'answered' } });
  expect(s.operations.call('http', owner, 'example.once', { name: 'a' }, 'new')).toEqual({ ok: false, code: 'denied', message: 'Permission denied' });
});
