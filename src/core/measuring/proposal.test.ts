import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvalService } from '../../apps/approvals.js';
import { createDataSchema, type DataDatabase } from '../data/database.js';
import { agents, approvals, inbox, members, measuringSettings } from '../data/schema.js';
import { DEFAULT_MEASURING } from './index.js';
import { readMeasuringChange } from './change.js';
import { measuringSettingsProposals } from './proposal.js';

let client: Database.Database, db: DataDatabase;
const at = '2026-11-14T20:00:00.000Z';
const context = { agent: 'art', askedFrom: 'chat', actingFor: 'jonathan', why: 'Find slow requests', minutes: 15 };
const after = { ...DEFAULT_MEASURING, on: true, keep_days: 7 };
beforeEach(() => {
  client = new Database(':memory:'); db = createDataSchema(client);
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
});
afterEach(() => client.close());

it('composes with the injected shared service and files the exact before/after in the owner Inbox', () => {
  const proposals = measuringSettingsProposals(db);
  const shared = approvalService(db, new Map([proposals.operation]), () => at);
  const request = vi.spyOn(shared, 'request');
  const card = proposals.request(shared, after, context);
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...context, operation: 'measuring.settings' }));
  expect(card).toMatchObject({ ...context, state: 'pending', kind: 'setting', target: 'measuring', what: card.changeSummary });
  expect(readMeasuringChange(card)).toEqual({ before: DEFAULT_MEASURING, after });
  expect(db.select().from(measuringSettings).all()).toEqual([]);
  expect(db.select().from(inbox).where(eq(inbox.sourceId, card.id)).get()).toMatchObject({
    toKind: 'person', to: 'jonathan', words: card.ask, why: context.why, ifYes: card.ifYes, ifNo: card.ifNo, waitsOnId: card.id,
  });
  expect(shared.allow(card.id, 'jonathan').state).toBe('used');
  expect(db.select().from(measuringSettings).get()).toMatchObject({ on: true, keepDays: 7 });
});

it('keeps operation, before/after and card wording authoritative over untyped metadata', () => {
  const proposals = measuringSettingsProposals(db);
  const shared = approvalService(db, new Map([proposals.operation]), () => at);
  const metadata = { ...context, kind: 'dangerous', target: 'other', operation: 'other', details: '{}',
    changeSummary: 'fake', what: 'fake', ask: 'fake', ifYes: 'fake', ifNo: 'fake' };
  const card = proposals.request(shared, after, metadata);
  expect(card).toMatchObject({ kind: 'setting', target: 'measuring', operation: 'measuring.settings', what: card.changeSummary,
    ask: 'Change Measuring settings?', ifYes: 'Apply the Measuring settings shown on this card.', ifNo: 'Keep the current Measuring settings.' });
  expect(readMeasuringChange(card)).toEqual({ before: DEFAULT_MEASURING, after });
});

it('validates before asking the injected service and requires registration in that same service', () => {
  const proposals = measuringSettingsProposals(db);
  const shared = approvalService(db, new Map([proposals.operation]), () => at);
  const request = vi.spyOn(shared, 'request');
  for (const settings of [DEFAULT_MEASURING, { ...after, keep_days: 0 }])
    expect(() => proposals.request(shared, settings, context)).toThrow();
  expect(request).not.toHaveBeenCalled();
  expect(() => proposals.request(approvalService(db), after, context)).toThrow('Unknown approved operation');
  expect(db.select().from(approvals).all()).toEqual([]);
  expect(db.select().from(inbox).all()).toEqual([]);
});
