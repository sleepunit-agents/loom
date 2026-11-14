import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { boxes, inbox, members } from '../core/data/schema.js';
import { Machines } from './machines.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let time = Date.parse('2026-11-14T18:00:00.000Z');
  const now = () => new Date(time).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'member', joinedAt: now() }).run();
  const add = (id: string, options: Partial<typeof boxes.$inferInsert> = {}) => db.insert(boxes).values({
    id, name: id, owner: 'owner', sameMachineAsLoom: false, hostsAny: false,
    reportOnly: false, alwaysOn: true, enrolledAt: now(), ...options,
  }).run();
  const service = new Machines(db, now);
  return { db, now, service, add, advance: (ms: number) => { time += ms; } };
}

it('alerts only silent live always-on machines, including same-machine and report-only workers', () => {
  const { db, service, add, advance, now } = fixture();
  add('normal'); add('local', { sameMachineAsLoom: true }); add('reporter', { reportOnly: true });
  add('optional', { alwaysOn: false }); add('revoked', { revokedAt: now() }); add('fresh');
  advance(120_000);
  expect(service.sweep()).toEqual([]);
  service.heartbeat('fresh'); advance(1);
  const alerts = service.sweep();
  expect(alerts.map(row => row.words).sort()).toEqual(['Machine local has stopped reporting.', 'Machine normal has stopped reporting.', 'Machine reporter has stopped reporting.']);
  expect(alerts.every(row => row.toKind === 'person' && row.to === 'owner' && row.member === 'owner' && row.conversation === null && row.answers === null)).toBe(true);
  expect(db.select().from(inbox).all()).toHaveLength(3);
});

it('deduplicates outages across restarts, resolves recovery, and alerts for a later outage', () => {
  const { db, service, add, advance, now } = fixture();
  add('worker'); advance(120_001);
  const first = service.sweep()[0];
  const restarted = new Machines(db, now);
  expect(restarted.sweep()[0].id).toBe(first.id);
  expect(db.select().from(inbox).all()).toHaveLength(1);
  expect(restarted.heartbeat('worker').lastSeenAt).toBe(now());
  expect(db.select().from(inbox).where(eq(inbox.id, first.id)).get()).toMatchObject({ state: 'resolved', resolution: 'Machine is reporting again', changedAt: now() });
  expect(restarted.sweep()).toEqual([]);
  advance(120_001);
  const second = restarted.sweep()[0];
  expect(second.id).not.toBe(first.id);
  expect(second.sourceId).not.toBe(first.sourceId);
  expect(db.select().from(inbox).all()).toHaveLength(2);
});

it('rejects revoked or missing heartbeats and invalid scan intervals without changing health', () => {
  const { db, service, add, now } = fixture();
  add('revoked', { revokedAt: now() });
  expect(() => service.heartbeat('revoked')).toThrow('Machine not available');
  expect(() => service.heartbeat('missing')).toThrow('Machine not available');
  for (const value of [0, -1, Infinity, NaN]) expect(() => service.sweep(value)).toThrow('Invalid silence interval');
  expect(db.select().from(boxes).get()?.lastSeenAt).toBeNull();
  expect(db.select().from(inbox).all()).toEqual([]);
});
