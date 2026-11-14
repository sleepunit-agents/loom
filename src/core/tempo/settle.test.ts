import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { inbox, members } from '../data/schema.js';
import { FakeClock } from '../clock.js';
import { SettledInbox, type AdmitInbox } from './settle.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
function fixture(admit?: AdmitInbox) {
  const client = new Database(':memory:'); cleanup.push(() => client.close());
  const db = createDataSchema(client), clock = new FakeClock();
  const batches: string[][] = [];
  const service = new SettledInbox(db, clock, admit ?? ((who, items) => { batches.push([who.id, ...items.map(i => i.id)]); return true; }));
  cleanup.push(() => service.close());
  const who = { kind: 'person' as const, id: 'jonathan' };
  for (const id of ['jonathan', 'other']) db.insert(members).values({ id, role: 'owner', joinedAt: new Date(clock.now()).toISOString() }).run();
  const add = (id: string, to = 'jonathan') => {
    const at = new Date(clock.now()).toISOString();
    db.insert(inbox).values({ id, toKind: 'person', to, source: 'notice', fromKind: 'unknown', words: id, at, changedAt: at, state: 'waiting' }).run();
    service.changed();
  };
  return { db, clock, service, batches, add, who };
}
it('waits until arrivals settle and admits all waiting items once per recipient', () => {
  const { service, clock, batches, add } = fixture();
  service.changed(); clock.advance(20_000); expect(batches).toEqual([]);
  add('a'); clock.advance(4_000); add('b'); add('c', 'other');
  clock.advance(4_999); expect(batches).toEqual([]);
  clock.advance(1); expect(batches).toEqual([['jonathan', 'a', 'b'], ['other', 'c']]);
  service.changed(); clock.advance(60_000); expect(batches).toHaveLength(2);
});
it('does not admit an inbox emptied during settling and closes outstanding timers', () => {
  const { db, service, clock, batches, add } = fixture();
  add('a'); db.update(inbox).set({ state: 'done' }).run(); service.changed();
  clock.advance(5_000); expect(batches).toEqual([]);
  add('b'); service.close(); clock.advance(10_000); expect(batches).toEqual([]);
});
it('automatically restores a muted item at its deadline then settles it', () => {
  const { service, clock, batches, add, who } = fixture();
  add('a'); service.volume.set(who, 'a', 'mute', new Date(clock.now() + 10_000).toISOString()); service.changed();
  clock.advance(14_999); expect(batches).toEqual([]);
  clock.advance(1); expect(batches).toEqual([['jonathan', 'a']]);
});
it('retries refused admission only on a change, preserving the settled batch', () => {
  let available = false, calls = 0;
  const { service, clock, add } = fixture(() => { calls++; return available; });
  add('a'); clock.advance(5_000); expect(calls).toBe(1);
  clock.advance(60_000); expect(calls).toBe(1);
  available = true; service.changed(); expect(calls).toBe(2);
  service.changed(); expect(calls).toBe(2);
});
it('recovers a waiting inbox after restart and tolerates synchronous claim notification', () => {
  const { db, service, clock, batches, add } = fixture();
  add('a'); service.close();
  const replacement = new SettledInbox(db, clock, (_, items) => {
    batches.push(items.map(i => i.id));
    db.update(inbox).set({ state: 'taken' }).where(eq(inbox.id, 'a')).run();
    replacement.changed(); return true;
  });
  cleanup.push(() => replacement.close());
  replacement.changed(); clock.advance(5_000);
  expect(batches).toEqual([['a']]);
});
it('uses recipient settings, resets settling on content changes, and avoids reentrant refusal loops', () => {
  let calls = 0;
  const { db, service, clock, add, who } = fixture(() => { calls++; service.changed(); return false; });
  service.volume.setTimings(who, { settleSeconds: 2 });
  add('a'); clock.advance(1_000);
  db.update(inbox).set({ words: 'Changed without a new timestamp' }).where(eq(inbox.id, 'a')).run(); service.changed();
  clock.advance(1_999); expect(calls).toBe(0);
  clock.advance(1); expect(calls).toBe(1);
});
