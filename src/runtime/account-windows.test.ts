import Database from 'better-sqlite3';
import { afterEach, it, expect } from 'vitest';
import { createDataSchema } from '../core/data/database.js';
import { accountWeekReadings, agents, jobs, jobUsage, members, modelAccounts, modelAccountWindows } from '../core/data/schema.js';
import { recordAccountWindows, readAccountWindows, currentAccountCapacity, refreshAccountWindows } from './account-windows.js';
import {accountWeeklyUsage} from './account-weekly-usage.js';
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

it('an identical successful refresh supersedes an older provider failure', async () => {
  const db = fixture(); recordAccountWindows(db, identity, [window], now);
  let reject!: (error: Error) => void;
  const old = refreshAccountWindows(db, 'shared', () => new Promise((_, fail) => { reject = fail; }), () => now);
  expect(await refreshAccountWindows(db, 'shared', async () => [window], () => now)).toEqual({ refreshed: true });
  reject(Error('late failure'));
  expect(await old).toEqual({ refreshed: false });
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(true);
});
it('an identical successful refresh supersedes an older changed response', async () => {
  const db = fixture(); recordAccountWindows(db, identity, [window], now);
  let resolve!: (rows: typeof window[]) => void;
  const old = refreshAccountWindows(db, 'shared', () => new Promise(done => { resolve = done; }), () => now);
  expect(await refreshAccountWindows(db, 'shared', async () => [window], () => now)).toEqual({ refreshed: true });
  resolve([{ ...window, usage: 1 }]);
  expect(await old).toEqual({ refreshed: false });
  expect(readAccountWindows(db, 'shared')[0]?.usage).toBe(0.2);
  expect(currentAccountCapacity(db, 'shared', now).hasRoom).toBe(true);
});
it('stores valid provider offset timestamps as the same UTC instants', () => {
  const db = fixture();
  expect(recordAccountWindows(db, identity, [{ ...window, readAt: '2026-11-14T22:00:00+02:00', resetsAt: '2026-11-15T00:00:00+03:00' }], now)).toBe(true);
  expect(readAccountWindows(db, 'shared')).toEqual([{ ...window, reserve: 0.05 }]);
  expect(db.select().from(modelAccounts).get()).toMatchObject({ usageReadAt: now, resetsAt: window.resetsAt });
});
it('does not freshen an older offset observation while normalizing storage', () => {
  const db = fixture(); recordAccountWindows(db, identity, [window], now);
  expect(recordAccountWindows(db, identity, [{ ...window, usage: 0.9, readAt: '2026-11-14T22:59:00+03:00' }], now)).toBe(false);
  expect(readAccountWindows(db, 'shared')).toEqual([{ ...window, reserve: 0.05 }]);
});


it('records accepted readings once per weekly window and retires them at reset', () => {
  const db = fixture();
  db.insert(modelAccountWindows).values({account:identity.account,window:'week',usage:0.2,usageReadAt:now,resetsAt:window.resetsAt,durationMs:window.durationMs}).run();
  const later = '2026-11-14T20:05:00.000Z';
  const reading = {...window,usage:0.25,readAt:later};
  const record = (usage: number) => recordAccountWindows(db,identity,[{...reading,usage},{...reading,name:'five-hour',durationMs:18_000_000}],later);
  expect(record(0.25)).toBe(true);
  expect(record(0.26)).toBe(true);
  expect(recordAccountWindows(db,identity,[window],later)).toBe(false);
  expect(db.select({at:accountWeekReadings.readAt,usage:accountWeekReadings.usage}).from(accountWeekReadings).orderBy(accountWeekReadings.readAt).all()).toEqual([{at:now,usage:0.2},{at:later,usage:0.26}]);
  recordAccountWindows(db,identity,[{...window,usage:0,readAt:window.resetsAt,resetsAt:'2026-11-21T21:00:00.000Z'}],window.resetsAt);
  expect(db.select().from(accountWeekReadings).all()).toMatchObject([{readAt:window.resetsAt,usage:0}]);
});

it('attributes only the measured rise to work placed on that account and expires the report at reset', () => {
  const db = fixture();
  const first = {...window,usage:.25};
  const end = '2026-11-14T20:10:00.000Z';
  const last = {...window,usage:.5,readAt:end};
  expect(accountWeeklyUsage(db,'shared',first,now)?.unattributed).toBe(.25);
  recordAccountWindows(db,identity,[first],now);
  recordAccountWindows(db,identity,[last],end);
  db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  for (const [id,account] of [['placed','shared'],['other',null]] as const) {
    db.insert(jobs).values({id,account,agent:'art',title:id,state:'done',brief:'',model:'m',
      startedByKind:'member',startedBy:'owner',houseRepository:'r',houseFile:'f',houseBranch:'b',
      queuedAt:now,claimedAt:now,endedAt:end}).run();
    db.insert(jobUsage).values({job:id,source:'report',tokensIn:20,tokensOut:10}).run();
  }
  db.insert(jobs).values({id:'just-started',account:'shared',agent:'art',title:'Next run',state:'running',
    brief:'',model:'m',startedByKind:'member',startedBy:'owner',houseRepository:'r',houseFile:'f',houseBranch:'b',
    queuedAt:end,claimedAt:end}).run();
  // SQLite rounds this open job to the exact upper bound. Its unknown tokens
  // must not take away the measured job's share of the preceding interval.
  db.insert(jobs).values({id:'fractional-start',account:'shared',agent:'art',title:'Fractional start',state:'running',
    brief:'',model:'m',startedByKind:'member',startedBy:'owner',houseRepository:'r',houseFile:'f',houseBranch:'b',
    queuedAt:now,claimedAt:'2026-11-14T20:09:59.9999Z'}).run();
  const report = accountWeeklyUsage(db,'shared',last,end);
  expect([...report!.shares]).toEqual([['placed',.25]]);
  expect(report!.unattributed).toBe(.25);
  expect(accountWeeklyUsage(db,'shared',last,last.resetsAt)).toBeNull();
});
