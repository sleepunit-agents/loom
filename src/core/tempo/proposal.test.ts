import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvalService } from '../../apps/approvals.js';
import { createDataSchema } from '../data/database.js';
import { agents, approvals, inbox, members, tempoSettings } from '../data/schema.js';
import { FakeClock } from '../clock.js';
import { tempoSettingsProposals } from './proposal.js';
import { defaultTimings } from './volume.js';
import { tempoSettingsService } from './settings.js';

let client: Database.Database;
function fixture() {
  client = new Database(':memory:');
  const db = createDataSchema(client), clock = new FakeClock();
  const at = new Date(clock.now()).toISOString();
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const recreate = () => {
    const proposals = tempoSettingsProposals(db, clock);
    const service = approvalService(db, new Map([proposals.operation]), () => at);
    return { proposals, service };
  };
  return { db, clock, recreate, ...recreate() };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => client.close());
const who = { kind: 'person' as const, id: 'owner' };
const context = { agent: 'art', askedFrom: 'chat', actingFor: 'owner', why: 'Give Inbox more time to settle' };
const request = () => f.proposals.request(f.service, who, { settleSeconds: 60 }, context);
const read = () => tempoSettingsService(f.db, f.clock).read(who);

it('files an exact shared approval and owner Inbox question without applying settings; Allow survives recreation', () => {
  const pending = request();
  expect(pending).toMatchObject({ state: 'pending', kind: 'setting', operation: 'tempo.settings', target: 'tempo:person:owner', ...context });
  expect(JSON.parse(pending.details)).toEqual({ who, before: defaultTimings, after: { ...defaultTimings, settleSeconds: 60 } });
  expect(read()).toEqual(defaultTimings);
  expect(f.db.select().from(tempoSettings).all()).toEqual([]);
  const question = f.db.select().from(inbox).where(eq(inbox.sourceId, pending.id)).get()!;
  expect(question).toMatchObject({ toKind: 'person', to: 'owner', words: pending.ask, ifYes: pending.ifYes, ifNo: pending.ifNo, waitsOnId: pending.id });
  const restarted = f.recreate();
  expect(restarted.service.allow(pending.id, 'owner').state).toBe('used');
  expect(read()).toEqual({ ...defaultTimings, settleSeconds: 60 });
  expect(restarted.service.record(pending.id).map(r => r.event)).toEqual(['request', 'allow', 'use']);
  expect(() => restarted.service.allow(pending.id, 'owner')).toThrow('already answered');
});

it('Deny and withdrawal keep timings unchanged and resolve the owner question', () => {
  const denied = request();
  f.service.deny(denied.id, 'owner');
  const withdrawn = request();
  f.service.withdraw(withdrawn.id, 'art');
  expect(read()).toEqual(defaultTimings);
  expect(f.db.select().from(inbox).where(eq(inbox.toKind, 'person')).all().every(row => row.state === 'resolved')).toBe(true);
});

it('rolls back settings, approval answer and question resolution when the use audit fails, then permits retry', () => {
  const pending = request();
  client.exec("CREATE TRIGGER fail_tempo_use BEFORE INSERT ON approval_record WHEN NEW.event = 'use' BEGIN SELECT RAISE(ABORT, 'use failed'); END");
  expect(() => f.service.allow(pending.id, 'owner')).toThrow('use failed');
  expect(read()).toEqual(defaultTimings);
  expect(f.service.get(pending.id)).toMatchObject({ state: 'pending', decidedBy: null, usedAt: null });
  expect(f.service.record(pending.id).map(r => r.event)).toEqual(['request']);
  expect(f.db.select().from(inbox).where(eq(inbox.sourceId, pending.id)).get()!.state).toBe('waiting');
  client.exec('DROP TRIGGER fail_tempo_use');
  expect(f.service.allow(pending.id, 'owner').state).toBe('used');
});

it('refuses a stale proposal while leaving it pending and retaining the newer approved timings', () => {
  const first = request();
  const stale = f.proposals.request(f.service, who, { dimDays: 3 }, context);
  f.service.allow(first.id, 'owner');
  expect(() => f.service.allow(stale.id, 'owner')).toThrow('fresh card');
  expect(f.service.get(stale.id).state).toBe('pending');
  expect(read()).toEqual({ ...defaultTimings, settleSeconds: 60 });
});

it('rolls a filed card and owner question back with the enclosing root transaction', () => {
  expect(() => f.db.transaction(() => { request(); throw new Error('receipt failed'); })).toThrow('receipt failed');
  expect(f.db.select().from(approvals).all()).toEqual([]);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  expect(read()).toEqual(defaultTimings);
});

it('refuses invalid or unchanged patches before filing any card, and refuses an unregistered operation', () => {
  for (const patch of [{}, { dimDays: 0 }, { settleSeconds: -1 }])
    expect(() => f.proposals.request(f.service, who, patch, context)).toThrow();
  const unregistered = approvalService(f.db);
  expect(() => f.proposals.request(unregistered, who, { dimDays: 2 }, context)).toThrow('Unknown approved operation');
  expect(f.db.select().from(approvals).all()).toEqual([]);
  expect(f.db.select().from(inbox).all()).toEqual([]);
});

it('keeps prepared fields authoritative over unexpected metadata from an untyped caller', () => {
  const metadata = { ...context, kind: 'dangerous', target: 'other', operation: 'other', details: '{}', changeSummary: 'fake', ask: 'fake', what: 'fake' };
  const card = f.proposals.request(f.service, who, { settleSeconds: 60 }, metadata);
  expect(card).toMatchObject({ kind: 'setting', target: 'tempo:person:owner', operation: 'tempo.settings' });
  expect(card.what).toBe(card.changeSummary);
  expect(card.ask).toBe('Change Tempo timings for person owner?');
  expect(JSON.parse(card.details).who).toEqual(who);
});
