import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createDataSchema } from '../data/database.js';
import { members, tempoSettings } from '../data/schema.js';
import { FakeClock } from '../clock.js';
import { tempoSettingsService } from './settings.js';
import { defaultTimings } from './volume.js';

const opened: Database.Database[] = [];
afterEach(() => { for (const c of opened.splice(0)) c.close(); });
const who = { kind: 'person' as const, id: 'jonathan' };
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  const db = createDataSchema(client), clock = new FakeClock();
  db.insert(members).values({ id: who.id, role: 'owner', joinedAt: new Date(clock.now()).toISOString() }).run();
  return { db, clock, service: tempoSettingsService(db, clock) };
}
it('prepares a durable before/after card without writes and applies it after service restart', () => {
  const { db, clock, service } = fixture();
  expect(service.read(who)).toEqual(defaultTimings);
  const card = service.prepare(who, { settleSeconds: 60 });
  expect(card.changeSummary).toContain('settle 5 → 60 seconds');
  expect(db.select().from(tempoSettings).all()).toEqual([]);
  tempoSettingsService(db, clock).apply(JSON.parse(JSON.stringify(card)));
  expect(service.read(who)).toEqual({ ...defaultTimings, settleSeconds: 60 });
  expect(service.read({ kind: 'agent', id: who.id })).toEqual(defaultTimings);
  service.apply(service.prepare(who, defaultTimings));
  expect(db.select().from(tempoSettings).all()).toEqual([]);
});
it('rejects stale and mismatched cards without changing settings', () => {
  const { service } = fixture();
  const card = service.prepare(who, { muteDays: 2 });
  for (const bad of [
    { ...card, kind: 'merge' }, { ...card, operation: 'another' },
    { ...card, target: 'tempo:agent:jonathan' }, { ...card, changeSummary: 'another change' },
    { ...card, details: card.details.replace('"muteDays":2', '"muteDays":3') },
  ]) expect(() => service.apply(bad)).toThrow();
  expect(service.read(who)).toEqual(defaultTimings);
  service.apply(service.prepare(who, { dimDays: 3 }));
  expect(() => service.apply(card)).toThrow('fresh card');
  expect(service.read(who)).toEqual({ ...defaultTimings, dimDays: 3 });
});
it('rejects invalid proposals and rolls back with the enclosing approval transaction', () => {
  const { db, service } = fixture();
  for (const patch of [{ settleSeconds: -1 }, { dimDays: 0 }, { muteDays: Infinity }, { muteDays: Number.MAX_SAFE_INTEGER }, { settleSeconds: 0.5 }, { extra: 1 }])
    expect(() => service.prepare(who, patch)).toThrow();
  expect(() => service.prepare(who, {})).toThrow('unchanged');
  const card = service.prepare(who, { settleSeconds: 60 });
  expect(() => db.transaction(() => { service.apply(card); throw new Error('audit failed'); })).toThrow('audit failed');
  expect(service.read(who)).toEqual(defaultTimings);
  service.apply(card);
  expect(() => service.apply(card)).toThrow('fresh card');
});
