import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDataSchema } from '../data/database.js';
import { OperationResults, type ReceiptPersistence } from '../data/operation-results.js';
import { DataWrites } from '../data/writes.js';
import { members, tasks } from '../data/schema.js';
import { taskService } from '../../apps/tasks.js';
import { FakeClock } from '../clock.js';
import { Operations } from './index.js';

const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).reverse().forEach(close => close()));
function fixture(transform: (store: ReceiptPersistence) => ReceiptPersistence = store => store, failNotifications = false, failCommitted = false) {
  const client = new Database(':memory:');
  const clock = new FakeClock();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'member', joinedAt: new Date(clock.now()).toISOString() }).run();
  const receipts = new OperationResults(db);
  const notifications: string[] = [];
  const writes = new DataWrites(db, {
    refreshAccess() {
      expect(client.inTransaction).toBe(false);
      expect(db.select().from(tasks).all()).toHaveLength(1);
      expect(client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 1 });
      notifications.push('access');
      if (failNotifications) throw new Error('publication failed');
    },
    changed() { expect(client.inTransaction).toBe(false); notifications.push('data'); },
  });
  const reportError = vi.fn();
  const operations = new Operations(client, clock, () => { if (failCommitted) throw new Error('committed publication failed'); }, { receipts: transform(receipts), writes, reportError });
  closes.push(() => client.close(), () => operations.close());
  const service = taskService(db, () => new Date(clock.now()).toISOString());
  const run = vi.fn((ctx: { changed(type: string, id: string): void }) => { ctx.changed('task', 't-1'); return service.create({ title: 'Pump', goal: 'Water moves', why: 'Pond needs it', owner: { kind: 'member', id: 'sam' } }, { kind: 'member', id: 'sam' }).id; });
  operations.register({ name: 'tasks.create', input: z.object({}), output: z.string(), write: true, may: () => true, run });
  const call = () => operations.call('http', { kind: 'member', id: 'sam' }, 'tasks.create', {}, 'same');
  return { client, db, clock, operations, writes, notifications, reportError, run, call };
}

it('commits actual shared service effects and receipts through one write boundary before publication', () => {
  const s = fixture();
  expect(s.call()).toEqual({ ok: true, value: 't-1' });
  expect(s.notifications).toEqual(['access', 'data']);
  expect(s.call()).toEqual({ ok: true, value: 't-1' });
  expect(s.run).toHaveBeenCalledOnce();
  expect(s.client.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'core_*'").all()).toEqual([]);
});

it('rolls back service effects and receipt when receipt persistence fails without publishing', () => {
  let fail = true;
  const s = fixture(store => ({ get: store.get.bind(store), expire: store.expire.bind(store), nextExpiry: store.nextExpiry.bind(store), recover: store.recover.bind(store), insert(receipt) { store.insert(receipt); if (fail) throw new Error('receipt failure'); } }));
  expect(s.call()).toMatchObject({ ok: false, code: 'unavailable' });
  expect(s.db.select().from(tasks).all()).toEqual([]);
  expect(s.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  expect(s.notifications).toEqual([]);
  fail = false;
  expect(s.call()).toEqual({ ok: true, value: 't-1' });
  expect(s.notifications).toEqual(['access', 'data']);
});

it('reports notification failures while preserving committed success and safe replay', () => {
  const s = fixture(store => store, true);
  s.reportError.mockImplementation(() => { throw new Error('reporter failed'); });
  expect(s.call()).toEqual({ ok: true, value: 't-1' });
  expect(s.notifications).toEqual(['access', 'data']);
  expect(s.reportError).toHaveBeenCalledOnce();
  s.call();
  expect(s.run).toHaveBeenCalledOnce();
});

it('keeps refusal of unrelated outer transactions', () => {
  const s = fixture();
  expect(s.client.transaction(() => s.call())()).toMatchObject({ code: 'unavailable' });
  expect(s.run).not.toHaveBeenCalled();
});

it('requires a reporter for shared writes and reports committed callback failures without retrying', () => {
  const s = fixture(store => store, false, true);
  const receipts = new OperationResults(s.db);
  expect(() => new Operations(s.client, s.clock, () => {}, { writes: s.writes, receipts })).toThrow('Shared writes require an error reporter');
  expect(s.call()).toEqual({ ok: true, value: 't-1' });
  expect(s.reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'committed publication failed' }));
  expect(s.call()).toEqual({ ok: true, value: 't-1' });
  expect(s.run).toHaveBeenCalledOnce();
});

it('wakes nobody at once for a write that says it moved only a stamp, and does not believe one that also announces a change', () => {
  const client = new Database(':memory:'), clock = new FakeClock();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'member', joinedAt: new Date(clock.now()).toISOString() }).run();
  const told: string[] = [], committed = vi.fn();
  const writes = new DataWrites(db, { refreshAccess() { told.push('access'); }, changed() { told.push('data'); }, stamped() { expect(client.inTransaction).toBe(false); told.push('stamp'); } });
  const operations = new Operations(client, clock, committed, { receipts: new OperationResults(db), writes, reportError: vi.fn() });
  closes.push(() => client.close(), () => operations.close());
  const input = z.object({ announce: z.boolean().optional(), nested: z.boolean().optional(), fail: z.boolean().optional() });
  operations.register({ name: 'boxes.seen', input, output: z.null(), write: true, may: () => true, run(ctx, asked) {
    ctx.stampOnly?.();
    if (asked.announce) ctx.changed('box', 'one');
    if (asked.nested) operations.call('direct', ctx.viewer, 'boxes.renamed', {}, `inner-${ctx.receipt!.id}`);
    if (asked.fail) throw new Error('storage');
    return null;
  } });
  operations.register({ name: 'boxes.renamed', input: z.object({}), output: z.null(), write: true, may: () => true, run: () => null });
  const call = (id: string, asked: z.infer<typeof input> = {}) => operations.call('http', { kind: 'member', id: 'sam' }, 'boxes.seen', asked, id);
  expect(call('one')).toEqual({ ok: true, value: null });
  expect(told).toEqual(['stamp']); expect(committed).not.toHaveBeenCalled();
  // A retry is answered from its receipt and writes nothing: nobody is told.
  expect(call('one')).toEqual({ ok: true, value: null });
  expect(told).toEqual(['stamp']);
  expect(call('two', { announce: true })).toEqual({ ok: true, value: null });
  expect(told).toEqual(['stamp', 'access', 'data']); expect(committed).toHaveBeenCalledOnce();
  // An operation run inside it that did not say so makes the whole commit an ordinary one.
  expect(call('three', { nested: true })).toEqual({ ok: true, value: null });
  expect(told).toEqual(['stamp', 'access', 'data', 'access', 'data']);
  expect(call('four', { fail: true })).toMatchObject({ ok: false });
  expect(told).toHaveLength(5);
});
