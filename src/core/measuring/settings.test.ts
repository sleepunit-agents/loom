import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataSchema, type DataDatabase } from '../data/database.js';
import { measuringSettings } from '../data/schema.js';
import { DEFAULT_MEASURING } from './index.js';
import { measuringSettingsService } from './settings.js';

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
  for (const patch of [{ keep_days: 0 }, { keep_days: 1.5 }, { keep_days: 3651 }, { send_outside: true },
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
