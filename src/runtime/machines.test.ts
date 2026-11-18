import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { boxes, boxFacts, inbox, members } from '../core/data/schema.js';
import { Machines, readMachineReport } from './machines.js';

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

it.each(['dim','mute'] as const)('deduplicates outages, resolves recovery with %s, and alerts for a later outage', volume => {
  const { db, service, add, advance, now } = fixture();
  add('worker'); advance(120_001);
  const first = service.sweep()[0];
  const restarted = new Machines(db, now);
  expect(restarted.sweep()[0].id).toBe(first.id);
  expect(db.select().from(inbox).all()).toHaveLength(1);
  db.update(inbox).set({volume,quietUntil:'2026-11-15T18:00:00.000Z'}).where(eq(inbox.id,first.id)).run();
  expect(restarted.heartbeat('worker').lastSeenAt).toBe(now());
  expect(db.select().from(inbox).where(eq(inbox.id, first.id)).get()).toMatchObject({ state: 'resolved', resolution: 'Machine is reporting again', changedAt: now(), volume:volume==='dim'?'full':'mute', quietUntil:volume==='dim'?null:'2026-11-15T18:00:00.000Z' });
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

it('replaces only machine-reported facts, preserving owner labels and other machines', () => {
  const f = fixture(); f.add('worker'); f.add('other');
  f.db.insert(boxFacts).values([{ box: 'worker', fact: 'gpu:old', fromOwner: false }, { box: 'worker', fact: 'rack:attic', fromOwner: true }, { box: 'other', fact: 'gpu:other', fromOwner: false }]).run();
  f.service.heartbeat('worker', ['gpu:5090', 'rack:attic']);
  expect(f.db.select().from(boxFacts).where(eq(boxFacts.box, 'worker')).all().sort((a,b) => a.fact.localeCompare(b.fact))).toEqual([{ box: 'worker', fact: 'gpu:5090', fromOwner: false }, { box: 'worker', fact: 'rack:attic', fromOwner: true }]);
  f.service.heartbeat('worker'); expect(f.db.select().from(boxFacts).all()).toHaveLength(3);
  f.service.heartbeat('worker', []);
  expect(f.db.select().from(boxFacts).all().sort((a,b) => a.box.localeCompare(b.box))).toEqual([{ box: 'other', fact: 'gpu:other', fromOwner: false }, { box: 'worker', fact: 'rack:attic', fromOwner: true }]);
});

it('accepts a worker report over a legacy reserved owner label until the worker withdraws it', () => {
  const { db, service, add } = fixture();
  add('worker');
  db.insert(boxFacts).values({ box: 'worker', fact: 'loom:test', fromOwner: true }).run();
  service.heartbeat('worker');
  expect(db.select().from(boxFacts).get()?.fromOwner).toBe(true);
  service.heartbeat('worker', ['loom:test']);
  expect(db.select().from(boxFacts).get()).toEqual({ box: 'worker', fact: 'loom:test', fromOwner: false });
  service.heartbeat('worker', []);
  expect(db.select().from(boxFacts).all()).toEqual([]);
});

for (const facts of [[''], ['duplicate', 'duplicate'], ['bad\rfact'], ['bad\nline'], ['bad\0fact'], ['x'.repeat(257)], Array.from({ length: 129 }, (_, i) => 'fact'+i)]) it('validates trusted reports before changing facts, health or outage recovery', () => {
  const f = fixture(); f.add('worker'); f.advance(120001); f.service.sweep();
  f.db.insert(boxFacts).values({ box: 'worker', fact: 'before', fromOwner: false }).run();
  const before = { boxes: f.db.select().from(boxes).all(), facts: f.db.select().from(boxFacts).all(), notices: f.db.select().from(inbox).all() };
  expect(() => f.service.heartbeat('worker', facts)).toThrow();
  expect({ boxes: f.db.select().from(boxes).all(), facts: f.db.select().from(boxFacts).all(), notices: f.db.select().from(inbox).all() }).toEqual(before);
});

it('keeps taking reports after the server clock is set back, stamped with the present time', () => {
  const { db, service, add, advance, now } = fixture();
  add('worker'); advance(60_000); service.heartbeat('worker');
  advance(-3_600_000);
  expect(service.heartbeat('worker').lastSeenAt).toBe(now());
  expect(db.select().from(boxes).where(eq(boxes.id, 'worker')).get()?.lastSeenAt).toBe(now());
  // Silence is then measured on the same clock again: quiet for the interval, and only then an alert.
  advance(120_000); expect(service.sweep()).toEqual([]);
  advance(1); expect(service.sweep()).toHaveLength(1);
});

it('counts a machine stamped later than now from now, so a clock set back does not hide a silent machine', () => {
  const { db, service, add, advance, now } = fixture();
  add('worker'); service.heartbeat('worker'); advance(-3_600_000);
  expect(service.sweep()).toEqual([]);
  expect(db.select().from(boxes).get()?.lastSeenAt).toBe(now());
  advance(120_001);
  expect(service.sweep().map(row => row.words)).toEqual(['Machine worker has stopped reporting.']);
});

it('retains a staged worker report across health updates, and withdraws it on the next legacy poll', () => {
  const { db, service, add } = fixture();
  add('worker'); add('other');
  const report = { version: 1 as const, enabled: false as const, user: 'art', cwd: '/home/art', agents: ['art'] };
  service.poll('worker', ['gpu'], report);
  expect(readMachineReport(db, 'worker')).toEqual(report);
  expect(readMachineReport(db, 'other')).toBeUndefined();
  service.heartbeat('worker', ['fast']);
  expect(readMachineReport(db, 'worker')).toEqual(report);
  service.poll('worker');
  expect(readMachineReport(db, 'worker')).toBeUndefined();
  expect(db.select().from(boxFacts).all().map(row => row.fact)).toEqual(['fast']);
});
it('rejects reserved machine metadata as generic worker facts and ignores an owner copy of a report', () => {
  const { db, service, add } = fixture(); add('worker');
  const report = { version: 1 as const, enabled: false as const, user: 'art', cwd: '/home/art', agents: ['art'] };
  service.poll('worker', undefined, report);
  const saved = db.select().from(boxFacts).get()!;
  for (const fact of [saved.fact, 'loom:machine-bodies', 'loom:MACHINE-USER:art']) {
    expect(() => service.heartbeat('worker', [fact])).toThrow();
  }
  db.update(boxFacts).set({ fromOwner: true }).run();
  expect(readMachineReport(db, 'worker')).toBeUndefined();
});
