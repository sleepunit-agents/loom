import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataSchema, type DataDatabase } from '../data/database.js';
import { agents, members, measuringSettings } from '../data/schema.js';
import { approvalService } from '../../apps/approvals.js';
import { readMeasuringChange } from './change.js';
import { DEFAULT_MEASURING } from './index.js';
import { MEASURING_SETTINGS_OPERATION, measuringSettingsService } from './settings.js';

let client: Database.Database, db: DataDatabase;
beforeEach(() => { client = new Database(':memory:'); db = createDataSchema(client); });
afterEach(() => client.close());

it('keeps never-configured Measuring off without writing a settings row', () => {
  expect(measuringSettingsService(db).read()).toEqual(DEFAULT_MEASURING);
  expect(db.select().from(measuringSettings).all()).toEqual([]);
});

it('prepares a durable before/after card and applies it using a recreated service', () => {
  const service = measuringSettingsService(db);
  const after = { ...DEFAULT_MEASURING, on: true, keep_days: 7 };
  const card = JSON.parse(JSON.stringify(service.prepare(after)));
  expect(readMeasuringChange(card)).toEqual({ before: DEFAULT_MEASURING, after });
  expect(service.read().on).toBe(false);
  expect(card.changeSummary).toContain('"on":false');
  expect(card.changeSummary).toContain('"on":true');
  db.transaction(() => measuringSettingsService(db).apply(card));
  expect(service.read()).toEqual(after);
  const off = service.prepare({ ...after, on: false });
  db.transaction(() => service.apply(off));
  expect(service.read()).toEqual({ ...after, on: false });
  expect(db.select().from(measuringSettings).all()).toHaveLength(1);
});

it('refuses stale proposals and rolls its edit back with the enclosing approval transaction', () => {
  const service = measuringSettingsService(db);
  const first = service.prepare({ ...DEFAULT_MEASURING, on: true });
  const stale = service.prepare({ ...DEFAULT_MEASURING, keep_days: 5 });
  expect(() => db.transaction(() => { service.apply(first); throw new Error('approval audit failed'); })).toThrow('approval audit');
  expect(service.read()).toEqual(DEFAULT_MEASURING);
  db.transaction(() => service.apply(first));
  expect(() => db.transaction(() => service.apply(stale))).toThrow('fresh card');
  expect(service.read()).toEqual({ ...DEFAULT_MEASURING, on: true });
});

it('validates every setting before a card is issued and binds application to the exact displayed change', () => {
  const service = measuringSettingsService(db);
  for (const patch of [{ keep_days: -1 }, { keep_days: 1.5 }, { keep_days: 3651 }, { send_outside: true },
    { outside_address: 'file:///tmp/traces' }, { outside_address: 'https://user:pass@example.com' },
    { outside_address: 'https://example.com/?token=hidden' }, { outside_address: 'https://example.com/#fragment' }]) {
    expect(() => service.prepare({ ...DEFAULT_MEASURING, ...patch })).toThrow();
  }
  expect(() => service.prepare({ ...DEFAULT_MEASURING })).toThrow('unchanged');
  const card = service.prepare({ ...DEFAULT_MEASURING, on: true, send_outside: true, outside_address: 'https://example.com/v1/traces' });
  expect(() => service.apply({ ...card, target: 'tempo' })).toThrow('Wrong');
  expect(() => service.apply({ ...card, changeSummary: 'Enable measuring' })).toThrow('card');
  const altered = JSON.parse(card.details); altered.after.keep_days = 3;
  expect(() => service.apply({ ...card, details: JSON.stringify(altered) })).toThrow('card');
  expect(service.read()).toEqual(DEFAULT_MEASURING);
});

function approvalFixture() {
  const at = '2026-11-14T20:00:00.000Z';
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
  const recreate = () => approvalService(db, new Map([
    [MEASURING_SETTINGS_OPERATION, measuringSettingsService(db).apply],
  ]), () => at);
  const service = recreate();
  const propose = (after: typeof DEFAULT_MEASURING) => service.request({
    ...measuringSettingsService(db).prepare(after), agent: 'art', askedFrom: 'house', actingFor: 'owner',
    what: 'Change Measuring settings', why: 'Find slow requests', ask: 'Change Measuring settings?',
    ifYes: 'Apply these settings', ifNo: 'Keep the current settings',
  });
  return { service, recreate, propose, at };
}

it('applies the persisted Measuring proposal through real Approvals after service recreation, only on Allow', () => {
  const { service, recreate, propose, at } = approvalFixture();
  const after = { ...DEFAULT_MEASURING, on: true, keep_days: 7 };
  const denied = propose(after);
  service.deny(denied.id, 'jonathan');
  expect(measuringSettingsService(db).read()).toEqual(DEFAULT_MEASURING);
  expect(db.select().from(measuringSettings).all()).toEqual([]);
  const pending = propose(after);
  expect(measuringSettingsService(db).read()).toEqual(DEFAULT_MEASURING);
  const restarted = recreate();
  expect(restarted.get(pending.id)).toMatchObject({ details: pending.details, changeSummary: pending.changeSummary });
  expect(restarted.allow(pending.id, 'jonathan')).toMatchObject({ state: 'used', decidedBy: 'jonathan', usedAt: at });
  expect(measuringSettingsService(db).read()).toEqual(after);
  expect(restarted.record(pending.id).map(row => row.event)).toEqual(['request', 'allow', 'use']);
  expect(() => restarted.allow(pending.id, 'jonathan')).toThrow('already answered');
});

it('rolls settings, the answer and audit back when the real approval use record fails after application', () => {
  const { service, propose } = approvalFixture();
  const pending = propose({ ...DEFAULT_MEASURING, on: true });
  client.exec("CREATE TRIGGER fail_measuring_use BEFORE INSERT ON approval_record WHEN NEW.event = 'use' BEGIN SELECT RAISE(ABORT, 'use audit failed'); END");
  expect(() => service.allow(pending.id, 'jonathan')).toThrow('use audit failed');
  expect(db.select().from(measuringSettings).all()).toEqual([]);
  expect(service.get(pending.id)).toMatchObject({ state: 'pending', decidedBy: null, decidedAt: null, usedAt: null });
  expect(service.record(pending.id).map(row => row.event)).toEqual(['request']);
  client.exec('DROP TRIGGER fail_measuring_use');
  expect(service.allow(pending.id, 'jonathan').state).toBe('used');
  expect(measuringSettingsService(db).read().on).toBe(true);
});

it('keeps a stale Measuring approval pending when another approved card has changed the settings', () => {
  const { service, propose } = approvalFixture();
  const first = propose({ ...DEFAULT_MEASURING, on: true });
  const stale = propose({ ...DEFAULT_MEASURING, keep_days: 5 });
  service.allow(first.id, 'jonathan');
  expect(() => service.allow(stale.id, 'jonathan')).toThrow('fresh card');
  expect(service.get(stale.id).state).toBe('pending');
  expect(service.record(stale.id).map(row => row.event)).toEqual(['request']);
  expect(measuringSettingsService(db).read()).toEqual({ ...DEFAULT_MEASURING, on: true });
});
