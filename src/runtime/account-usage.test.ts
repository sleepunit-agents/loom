import Database from 'better-sqlite3';
import { afterEach, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { members, modelAccounts } from '../core/data/schema.js';
import { accountUsageUnavailable } from './account-usage.js';
import { recordAccountWindows } from './account-windows.js';
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const now = '2026-11-14T20:00:00.000Z';
const identity = { account: 'shared', owner: 'jonathan', provider: 'provider' };
const window = (usage = 0.5) => ({ name: 'week', usage, readAt: now, resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 });
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  const db = createDataSchema(client);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now }).run();
  db.insert(modelAccounts).values({ id: 'shared', owner: 'jonathan', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
  return { db, read: () => db.select().from(modelAccounts).get()!, 
    // The summary is only ever written with its windows, so it is tested through that one writer.
    record: (windows = [window()], at = now) => ({ recorded: recordAccountWindows(db, identity, windows, at) }) };
}
it('records shared account capacity from every provider window', () => {
  const f = fixture();
  const result = f.record([window(0.5), { ...window(1), name: 'five-hour', durationMs: 5 * 3600_000 }]);
  expect(result.recorded).toBe(true);
  expect(f.read()).toMatchObject({ usage: 1, usageReadAt: now, resetsAt: '2026-11-14T21:00:00.000Z', hasRoom: false });
  expect(f.db.select().from(modelAccounts).all()).toHaveLength(1);
});
it('projects stale observations before persisting the admission summary', () => {
  const f = fixture();
  f.record([{ ...window(0.5), durationMs: 2 * 3600_000 }], '2026-11-14T20:59:00.000Z');
  expect(f.read().usage).toBeCloseTo(0.9916667);
  expect(f.read().hasRoom).toBe(false);
});
it('does not overwrite a newer complete reading with an older asynchronous result', () => {
  const f = fixture(); f.record();
  const result = f.record([{ ...window(1), readAt: '2026-11-14T19:00:00.000Z' }]);
  expect(result.recorded).toBe(false);
  expect(f.read()).toMatchObject({ usage: 0.5, usageReadAt: now, hasRoom: true });
});
it('unknown or expired usage cannot establish capacity or invent a reset', () => {
  const f = fixture();
  f.record([], now);
  expect(f.read()).toMatchObject({ usage: null, usageReadAt: null, resetsAt: null, hasRoom: false });
  f.record([window()], '2026-11-14T21:00:00.000Z');
  expect(f.read()).toMatchObject({ usage: null, usageReadAt: now, resetsAt: '2026-11-14T21:00:00.000Z', hasRoom: false });
});
it('a failed provider refresh closes admission and preserves the last known observation', () => {
  const f = fixture(); f.record(); const before = f.read();
  expect(accountUsageUnavailable(f.db, identity)).toBe(true);
  expect(f.read()).toEqual({ ...before, hasRoom: false });
});
it('late observations and failures cannot change another provider or owner', () => {
  const f = fixture(); f.record();
  f.db.update(modelAccounts).set({ provider: 'replacement' }).where(eq(modelAccounts.id, 'shared')).run();
  const before = f.read();
  expect(() => f.record()).toThrow('Account changed');
  expect(accountUsageUnavailable(f.db, identity)).toBe(false);
  expect(f.read()).toEqual(before);
});
it('a future reading closes admission without fencing out a subsequent valid reading', () => {
  const f = fixture();
  f.record([{ ...window(), readAt: '2026-11-14T20:30:00.000Z' }]);
  expect(f.read()).toMatchObject({ usage: null, usageReadAt: null, hasRoom: false });
  expect(f.record().recorded).toBe(true);
  expect(f.read()).toMatchObject({ usage: 0.5, usageReadAt: now, hasRoom: true });
});
