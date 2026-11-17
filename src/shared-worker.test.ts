import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from './core/data/database.js';
import { boxes, members } from './core/data/schema.js';
import { liveWorker } from './shared-worker.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
it('takes a worker for its machine only on the door\'s proof for that machine, and only while the machine is not revoked', () => {
  const client = new Database(':memory:'); clients.push(client);
  const at = '2026-11-14T18:00:00.000Z', db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  for (const id of ['worker', 'other']) db.insert(boxes).values({ id, name: id, owner: 'owner', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
  const worker = { kind: 'runner' as const, id: 'worker' };
  expect(liveWorker(db, worker, { box: 'worker' })).toBe('worker');
  // A viewer that says it is a worker proves nothing; nor does proof for another machine or another kind of caller.
  expect(liveWorker(db, worker, undefined)).toBeUndefined();
  expect(liveWorker(db, worker, { box: 'other' })).toBeUndefined();
  expect(liveWorker(db, { kind: 'member', id: 'worker' }, { box: 'worker' })).toBeUndefined();
  expect(liveWorker(db, { kind: 'runner', id: 'gone' }, { box: 'gone' })).toBeUndefined();
  db.update(boxes).set({ revokedAt: at }).where(eq(boxes.id, 'worker')).run();
  expect(liveWorker(db, worker, { box: 'worker' })).toBeUndefined();
});
