import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, agentStatus, conversationDays, findings, turns } from '../data/schema.js';
import { Conversations } from './index.js';
import { ConversationHistory } from './history.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let now = '2026-08-15T12:00:00.000Z';
  const db = createDataSchema(client, () => now);
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const service = new Conversations(db, () => now), history = new ConversationHistory(db, () => now);
  const cv = service.open({ agent: 'art', venue: 'wake', place: 'night', label: 'Night shift' });
  return { db, service, history, cv, at: (at: string) => { now = at; } };
}
it('rolls whole old days into counts and median waits without reusing turn sequences', () => {
  const { db, service, history, cv, at } = fixture();
  const turn = (kind: 'message' | 'reply' | 'action', latencyMs?: number) => service.turn({ conversation: cv.id, kind, fromKind: 'agent', fromId: 'art', latencyMs });
  turn('message'); turn('action');
  for (const latency of [900, 10, 30, 50]) turn('reply', latency);
  at('2026-08-16T00:00:00.000Z'); turn('message');
  at('2026-11-14T12:00:00.000Z');
  expect(history.rollup()).toBe(6);
  expect(db.select().from(conversationDays).all()).toEqual([{ conversation: cv.id, day: '2026-08-15', messages: 1, replies: 4, actions: 1, medianLatencyMs: 40 }]);
  expect(db.select().from(turns).all().map(t => t.seq)).toEqual([7]);
  expect(history.rollup()).toBe(0);
  expect(turn('reply', 100).seq).toBe(8);
  at('2026-11-15T12:00:00.000Z');
  expect(history.rollup()).toBe(1);
  expect(db.select().from(conversationDays).all()[1]).toMatchObject({ day: '2026-08-16', medianLatencyMs: 0 });
});
it('updates an agent status and a review score using their natural keys', () => {
  const { db, history, cv, at } = fixture();
  history.status('art', 'working', 'Comparing pumps');
  at('2026-11-14T12:00:00.000Z'); history.status('art', 'waiting', 'Need a price ceiling');
  expect(db.select().from(agentStatus).all()).toEqual([{ agent: 'art', state: 'waiting', work: 'Need a price ceiling', changedAt: '2026-11-14T12:00:00.000Z' }]);
  const finding = { conversation: cv.id, day: '2026-11-14', turnSeq: 1, measure: 'useful', score: 3, text: 'Useful comparison' };
  history.finding(finding); history.finding({ ...finding, score: 4 });
  expect(db.select().from(findings).all()).toEqual([{ ...finding, score: 4 }]);
  expect(() => history.finding({ ...finding, score: 6 })).toThrow();
});
it('partitions medians by conversation and excludes non-replies and missing latency', () => {
  const { db, service, history, cv, at } = fixture();
  const other = service.open({ agent: 'art', venue: 'wake', place: 'morning', label: 'Morning' });
  for (const latencyMs of [1, 3, 99]) service.turn({ conversation: cv.id, kind: 'reply', fromKind: 'agent', latencyMs });
  service.turn({ conversation: cv.id, kind: 'action', fromKind: 'agent', latencyMs: 1000 });
  service.turn({ conversation: cv.id, kind: 'reply', fromKind: 'agent' });
  service.turn({ conversation: other.id, kind: 'reply', fromKind: 'agent', latencyMs: 200 });
  at('2026-11-14T12:00:00.000Z');
  expect(history.rollup()).toBe(6);
  const days = db.select().from(conversationDays).all();
  expect(days.find(day => day.conversation === cv.id)).toMatchObject({ replies: 4, actions: 1, medianLatencyMs: 3 });
  expect(days.find(day => day.conversation === other.id)).toMatchObject({ replies: 1, actions: 0, medianLatencyMs: 200 });
});
