import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FakeClock } from '../core/clock.js';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { changes, changeSync, projects, projectRepositories } from '../core/data/schema.js';
import { changeService } from './changes.js';
import { pollChanges } from './changes-polling.js';
import type { Change } from '../pieces/changes/model.js';

let client: Database.Database, db: DataDatabase, clock: FakeClock;
let service: ReturnType<typeof changeService>, poller: ReturnType<typeof pollChanges> | undefined;
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
beforeEach(() => {
  client = new Database(':memory:'); clock = new FakeClock();
  db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(projects).values({ id: 'loom', name: 'Loom' }).run();
  db.insert(projectRepositories).values({ project: 'loom', repository: 'house/loom' }).run();
  service = changeService(db, () => undefined, () => new Date(clock.now()).toISOString());
});
afterEach(async () => { await poller?.stop(); poller = undefined; client.close(); });

it('reads on startup, coalesces manual refresh with scheduled IO, and waits for the next deadline', async () => {
  let calls = 0, finish!: (rows: Change[]) => void;
  poller = pollChanges(service, async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, clock, 1000);
  clock.advance(0); await tick();
  expect(calls).toBe(1);
  const first = poller.refresh(); expect(poller.refresh()).toBe(first);
  clock.advance(5000); expect(calls).toBe(1);
  finish([]); await first;
  expect(service.syncStatus()).toMatchObject({ failed: false });
  clock.advance(999); await tick(); expect(calls).toBe(1);
  clock.advance(1); await tick(); expect(calls).toBe(2);
  const second = poller.refresh(); finish([]); await second;
});

it('resumes the persisted deadline on restart and does not read after stop', async () => {
  const due = clock.now() + 5000;
  db.insert(changeSync).values({ failed: false, nextAt: new Date(due).toISOString() }).run();
  let calls = 0;
  const read = async () => { calls++; return []; };
  poller = pollChanges(service, read, clock, 1000);
  clock.advance(4999); await tick(); expect(calls).toBe(0);
  await poller.stop(); clock.advance(1); await tick(); expect(calls).toBe(0);
  poller = pollChanges(service, read, clock, 1000);
  clock.advance(0); await poller.refresh(); expect(calls).toBe(1);
  expect(service.syncStatus()?.nextAt).toBe(new Date(due + 1000).toISOString());
  await poller.stop(); clock.advance(10000); await tick(); expect(calls).toBe(1);
  await expect(poller.refresh()).rejects.toThrow('stopped');
});

it('records failure and retries without leaking a rejected timer promise', async () => {
  let calls = 0;
  poller = pollChanges(service, async () => { calls++; if (calls === 1) throw new Error('upstream'); return []; }, clock, 1000);
  clock.advance(0);
  await expect(poller.refresh()).rejects.toThrow('GitHub read unavailable');
  expect(service.syncStatus()).toMatchObject({ failed: true });
  expect(db.select().from(changes).all()).toEqual([]);
  clock.advance(999); await tick(); expect(calls).toBe(1);
  clock.advance(1); await poller.refresh(); expect(calls).toBe(2);
  expect(service.syncStatus()).toMatchObject({ failed: false });
});

it('drains an in-flight read at shutdown without scheduling another read', async () => {
  let finish!: (rows: Change[]) => void, calls = 0;
  poller = pollChanges(service, async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, clock, 1000);
  const read = poller.refresh(); await tick();
  let drained = false;
  const stop = poller.stop().then(() => { drained = true; });
  await tick(); expect(drained).toBe(false);
  finish([]); await read; await stop;
  expect(drained).toBe(true);
  clock.advance(10000); await tick(); expect(calls).toBe(1);
});

it('rejects invalid intervals before arming a timer', () => {
  for (const interval of [0, -1, 1.5, Infinity]) expect(() => pollChanges(service, async () => [], clock, interval)).toThrow('interval');
});
