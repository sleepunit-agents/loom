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

it('writes settings whole, reads them back from a recreated service, and refuses an invalid set', () => {
  measuringSettingsService(db).write({ ...DEFAULT_MEASURING, on: true, keep_days: 30 });
  expect(measuringSettingsService(db).read()).toEqual({ ...DEFAULT_MEASURING, on: true, keep_days: 30 });
  expect(() => measuringSettingsService(db).write({ ...DEFAULT_MEASURING, on: true, keep_days: 0 })).toThrow();
  expect(() => measuringSettingsService(db).write({ ...DEFAULT_MEASURING, send_outside: true, outside_address: 'ftp://nope' })).toThrow();
  expect(measuringSettingsService(db).read()).toEqual({ ...DEFAULT_MEASURING, on: true, keep_days: 30 });
});
