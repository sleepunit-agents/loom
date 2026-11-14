import Database from 'better-sqlite3';
import { afterEach, it, expect } from 'vitest';
import { createDataSchema } from '../core/data/database.js';
import { members, modelAccounts } from '../core/data/schema.js';
import { recordAccountWindows, readAccountWindows, currentAccountCapacity, refreshAccountWindows } from './account-windows.js';
const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
const now = '2026-11-14T20:00:00.000Z';
const identity = { account: 'shared', owner: 'owner', provider: 'provider' };
const window = { name: 'week', usage: 0.2, readAt: now, resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 };
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  const db = createDataSchema(client);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now }).run();
  db.insert(modelAccounts).values({ id: 'shared', owner: 'owner', provider: 'provider', label: 'Subscription', hasRoom: false }).run();
  return db;
}
it('stores all shared limits atomically and replaces the provider complete set', () => {
  const db = fixture();
  expect(recordAccountWindows(db, identity, [window, { ...window, name: 'hours', usage: 1 }], now)).toBe(true);
  expect(readAccountWindows(db, 'shared')).toHaveLength(2);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(false);
  recordAccountWindows(db, identity, [window], now);
  expect(readAccountWindows(db, 'shared')).toHaveLength(1);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(true);
  expect(currentAccountCapacity(db, 'shared', window.resetsAt).hasRoom).toBe(false);
});
it('rejects duplicates and invalid persisted usage without changing prior readings', () => {
  const db = fixture(); recordAccountWindows(db, identity, [window], now);
  const before = readAccountWindows(db, 'shared');
  expect(() => recordAccountWindows(db, identity, [window, window], now)).toThrow('Duplicate');
  expect(() => recordAccountWindows(db, identity, [{ ...window, usage: 2 }], now)).toThrow();
  expect(readAccountWindows(db, 'shared')).toEqual(before);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(true);
});
it('retains newer individual windows even when the summary oldest timestamp matches', () => {
  const db = fixture();
  recordAccountWindows(db, identity, [window, { ...window, name: 'hours', readAt: '2026-11-14T20:10:00.000Z' }], '2026-11-14T20:15:00.000Z');
  expect(recordAccountWindows(db, identity, [window, { ...window, name: 'hours', usage: 0.9 }], '2026-11-14T20:15:00.000Z')).toBe(false);
  expect(readAccountWindows(db, 'shared').find(row => row.name === 'hours')?.usage).toBe(0.2);
});
it('unknown reset and full reserve close admission without inventing an allowance', () => {
  const db = fixture();
  recordAccountWindows(db, identity, [{ ...window, resetsAt: null }], now);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(false);
  recordAccountWindows(db, identity, [{ ...window, reserve: 1, durationMs: 2 * 3600_000 }], now);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(false);
});
it('calls a provider outside the transaction and latches failure until successful refresh', async () => {
  const db = fixture();
  await refreshAccountWindows(db, 'shared', async input => { expect(input).toEqual(identity); return [window]; }, () => now);
  await refreshAccountWindows(db, 'shared', async () => { throw Error('provider unavailable'); }, () => now);
  expect(readAccountWindows(db, 'shared')[0]?.usage).toBe(0.2);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(false);
  await refreshAccountWindows(db, 'shared', async () => [window], () => now);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(true);
});
it('a late provider failure cannot close newer successful capacity', async () => {
  const db = fixture();
  let reject!: (error: Error) => void;
  const old = refreshAccountWindows(db, 'shared', () => new Promise((_, fail) => { reject = fail; }), () => now);
  await refreshAccountWindows(db, 'shared', async () => [window], () => now);
  reject(Error('late failure')); await old;
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(true);
});

it('malformed provider response closes admission while keeping last observations', async () => {
  const db = fixture(); recordAccountWindows(db, identity, [window], now);
  expect(await refreshAccountWindows(db, 'shared', async () => [{ ...window, usage: 2 }], () => now)).toEqual({ refreshed: false });
  expect(readAccountWindows(db, 'shared')[0]?.usage).toBe(0.2);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(false);
});
it('late successful refresh cannot replace a completed refresh from the same starting state', async () => {
  const db = fixture();
  let resolve!: (rows: typeof window[]) => void;
  const old = refreshAccountWindows(db, 'shared', () => new Promise(done => { resolve = done; }), () => now);
  await refreshAccountWindows(db, 'shared', async () => [window], () => now);
  resolve([{ ...window, usage: 0.9 }]);
  expect(await old).toEqual({ refreshed: false });
  expect(readAccountWindows(db, 'shared')[0]?.usage).toBe(0.2);
});

it('a future window observation cannot fence out the next valid provider reading', () => {
  const db = fixture();
  recordAccountWindows(db, identity, [{ ...window, readAt: '2026-11-14T20:30:00.000Z' }], now);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(false);
  expect(recordAccountWindows(db, identity, [window], now)).toBe(true);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(true);
});
