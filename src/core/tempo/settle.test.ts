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
  return { client, db, clock, service, batches, add, who };
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

it.each(['mute', 'content', 'done'] as const)('refreshes later recipients after admission commits a %s change', change => {
  const admitted: { who: string; words: (string | null)[] }[] = [];
  const { db, service, clock, add } = fixture((who, items) => {
    admitted.push({ who: who.id, words: items.map(item => item.words) });
    if (who.id === 'jonathan') {
      db.transaction(() => {
        if (change === 'mute') service.volume.set({ kind: 'person', id: 'other' }, 'b', 'mute', new Date(clock.now() + 20_000).toISOString());
        else db.update(inbox).set(change === 'content' ? { words: 'Revised' } : { state: 'done' }).where(eq(inbox.id, 'b')).run();
      });
      service.changed();
    }
    return true;
  });
  add('a'); add('b', 'other');
  clock.advance(5_000);
  expect(admitted).toEqual([{ who: 'jonathan', words: ['a'] }]);
  if (change === 'content') {
    clock.advance(4_999); expect(admitted).toHaveLength(1);
    clock.advance(1); expect(admitted).toEqual([{ who: 'jonathan', words: ['a'] }, { who: 'other', words: ['Revised'] }]);
  } else if (change === 'mute') {
    clock.advance(24_999); expect(admitted).toHaveLength(1);
    clock.advance(1); expect(admitted).toEqual([{ who: 'jonathan', words: ['a'] }, { who: 'other', words: ['b'] }]);
  } else {
    clock.advance(60_000); expect(admitted).toHaveLength(1);
  }
});

it.each(['refuse', 'throw'] as const)('keeps later recipients moving when the first reentrant admission will %s', outcome => {
  const attempts: string[] = [];
  const { service, clock, add } = fixture(who => {
    attempts.push(who.id);
    if (who.id === 'jonathan') {
      service.changed();
      if (outcome === 'throw') throw new Error('Unavailable');
      return false;
    }
    return true;
  });
  add('a'); add('b', 'other'); clock.advance(5_000);
  expect(attempts).toEqual(['jonathan', 'other']);
  clock.advance(60_000); expect(attempts).toEqual(['jonathan', 'other']);
});

it.each(['accepted', 'refused', 'throws'] as const)('stops the current scan when %s admission closes the inbox', outcome => {
  const offered: string[] = [];
  const { client, service, clock, add } = fixture(who => {
    offered.push(who.id);
    service.close();
    client.close();
    service.changed();
    if (outcome === 'throws') throw new Error('Shutdown');
    return outcome === 'accepted';
  });
  add('a'); add('b', 'other');
  expect(() => clock.advance(5_000)).not.toThrow();
  expect(offered).toEqual(['jonathan']);
  service.changed(); clock.advance(60_000);
  expect(offered).toEqual(['jonathan']);
});

it('stops before reading inbox groups when an expiry notification closes the inbox', () => {
  const { client, db, service, clock, add, who } = fixture();
  add('a');
  service.volume.set(who, 'a', 'mute', new Date(clock.now() + 1_000).toISOString());
  service.close();
  const replacement = new SettledInbox(db, clock, () => { throw new Error('Closed inbox admitted'); }, () => {
    replacement.close();
    // Root shutdown may close the shared connection in this callback.
    clientClosed = true;
    client.close();
  });
  let clientClosed = false;
  // The fixture owns the original connection cleanup; closing it twice is safe.
  cleanup.push(() => replacement.close());
  replacement.changed();
  expect(() => clock.advance(1_000)).not.toThrow();
  expect(clientClosed).toBe(true);
});
