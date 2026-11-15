import { Conversations } from '../conversations/index.js';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { inbox, members, tempoSettings } from '../data/schema.js';
import { FakeClock } from '../clock.js';
import { InboxVolume, defaultTimings } from './volume.js';

const opened: Database.Database[] = [];
afterEach(() => { for (const c of opened.splice(0)) c.close(); });
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  const clock = new FakeClock();
  const db = createDataSchema(client);
  const at = new Date(clock.now()).toISOString();
  for (const id of ['jonathan', 'other']) db.insert(members).values({ id, role: 'owner', joinedAt: at }).run();
  for (const id of ['one', 'two']) db.insert(inbox).values({ id, toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'unknown', words: 'Question', at, changedAt: at, state: 'waiting' }).run();
  const volume = new InboxVolume(db, clock);
  const who = { kind: 'person' as const, id: 'jonathan' };
  const item = (id = 'one') => db.select().from(inbox).where(eq(inbox.id, id)).get()!;
  return { db, clock, volume, who, item };
}
it('dim breaks on a content change; mute survives it; being asked by name breaks both', () => {
  const { volume, who, item } = fixture();
  volume.set(who, 'one', 'dim');
  volume.changed(who, 'one');
  expect(item()).toMatchObject({ volume: 'full', quietUntil: null });
  volume.set(who, 'one', 'mute');
  const until = item().quietUntil;
  volume.changed(who, 'one');
  expect(item()).toMatchObject({ volume: 'mute', quietUntil: until });
  volume.changed(who, 'one', true);
  expect(item()).toMatchObject({ volume: 'full', quietUntil: null });
  volume.set(who, 'one', 'dim');
  volume.changed(who, 'one', true);
  expect(item().volume).toBe('full');
});
it('expires dim after a day and mute after a week, including across service restart', () => {
  const { db, clock, volume, who, item } = fixture();
  volume.set(who, 'one', 'dim'); volume.set(who, 'two', 'mute');
  const originalChanged = item().changedAt;
  expect(volume.expire()).toBe(clock.now() + 86_400_000);
  clock.advance(86_400_000);
  const restarted = new InboxVolume(db, clock);
  expect(restarted.expire()).toBe(clock.now() + 6 * 86_400_000);
  expect(item()).toMatchObject({ volume: 'full', changedAt: originalChanged });
  expect(item('two').volume).toBe('mute');
  clock.advance(6 * 86_400_000);
  expect(restarted.expire()).toBeUndefined();
  expect(item('two')).toMatchObject({ volume: 'full', quietUntil: null });
});
it('keeps overrides per recipient and removes a row restored to defaults', () => {
  const { db, clock, volume, who, item } = fixture();
  expect(volume.timings(who)).toEqual(defaultTimings);
  expect(db.select().from(tempoSettings).all()).toEqual([]);
  volume.setTimings(who, { settleSeconds: 60, dimDays: 2, muteDays: 3 });
  expect(volume.timings({ kind: 'person', id: 'other' })).toEqual(defaultTimings);
  volume.set(who, 'one', 'mute');
  expect(Date.parse(item().quietUntil!)).toBe(clock.now() + 3 * 86_400_000);
  volume.setTimings(who, defaultTimings);
  expect(db.select().from(tempoSettings).all()).toEqual([]);
});
it('rejects invalid quiet periods and another recipient without modifying the item', () => {
  const { clock, volume, who, item } = fixture();
  expect(() => volume.set({ kind: 'person', id: 'other' }, 'one', 'mute')).toThrow();
  expect(() => volume.set(who, 'one', 'mute', new Date(clock.now()).toISOString())).toThrow();
  expect(() => volume.set(who, 'one', 'mute', 'forever')).toThrow();
  for (const patch of [{ muteDays: 0 }, { dimDays: -1 }, { settleSeconds: -1 }, { muteDays: Infinity }]) expect(() => volume.setTimings(who, patch)).toThrow();
  expect(item()).toMatchObject({ volume: 'full', quietUntil: null });
});

it('expires quiet items by instant when persisted UTC precision differs', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock(Date.parse('2026-11-14T18:00:00.000Z'));
  const now = () => new Date(clock.now()).toISOString();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  const mail = new Conversations(db, now), volume = new InboxVolume(db, clock);
  const item = mail.send({ toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'unknown', words: 'Quiet' });
  try {
    // Whole-second timestamps are valid shared data, including older producers.
    db.update(inbox).set({ volume: 'mute', quietUntil: '2026-11-14T18:00:00Z' }).where(eq(inbox.id, item.id)).run();
    let notifications = 0;
    expect(volume.expire(() => { notifications++; })).toBeUndefined();
    expect(mail.item(item.id)).toMatchObject({ volume: 'full', quietUntil: null });
    expect(notifications).toBe(1);
    expect(volume.expire(() => { notifications++; })).toBeUndefined();
    expect(notifications).toBe(1);
  } finally { client.close(); }
});
