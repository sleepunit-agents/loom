import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, conversations, deletedThreads, members, messages } from '../data/schema.js';
import { Threads } from './threads.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let now = '2026-11-14T18:00:00.000Z';
  const db = createDataSchema(client, () => now);
  for (const id of ['jonathan', 'guest']) db.insert(members).values({ id, role: 'member', joinedAt: now }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const service = new Threads(db, () => now);
  const open = (id: string, member = 'jonathan', agent = 'art') => service.open({ id, member, agent, title: 'Pond pump', titledBy: 'agent' });
  return { db, service, open, at: (value: string) => { now = value; } };
}

it('creates exactly one private conversation per thread and rejects identity changes and deleted ids', () => {
  const { db, service, open } = fixture();
  const thread = open('th:one');
  expect(open('th:one')).toEqual(thread);
  expect(() => open('th:one', 'guest')).toThrow('identity differs');
  expect(() => open('th:one', 'jonathan', 'mark')).toThrow('identity differs');
  expect(db.select().from(conversations).all()).toMatchObject([{ id: thread.conversation, venue: 'loom', place: thread.id, member: 'jonathan', agent: 'art' }]);
  db.insert(deletedThreads).values({ id: 'th:gone', conversation: 'old-conversation', at: service.now() }).run();
  expect(() => open('th:gone')).toThrow('deleted');
  expect(() => service.open({ member: 'missing', agent: 'art', title: 'Bad' })).toThrow();
  expect(db.select().from(conversations).all()).toHaveLength(1);
});

it('keeps a member title, validates length, and changes the conversation label together', () => {
  const { service, open } = fixture();
  const thread = open('th:one');
  expect(service.rename(thread.id, 'Agent title', 'agent').title).toBe('Agent title');
  expect(service.rename(thread.id, ' My title ', 'member').title).toBe('My title');
  expect(service.rename(thread.id, 'Agent replacement', 'agent').title).toBe('My title');
  expect(service.conversations.conversation(thread.conversation).label).toBe('My title');
  expect(() => service.rename(thread.id, 'x'.repeat(61), 'member')).toThrow('1–60');
  expect(() => service.rename(thread.id, ' ', 'member')).toThrow('1–60');
  expect(service.rename(thread.id, '🧶'.repeat(60), 'member').title).toBe('🧶'.repeat(60));
});

it('limits pins to eight per member across agents, with idempotent pinning and separate members', () => {
  const { service, open, at } = fixture();
  for (let i = 0; i < 8; i++) service.pin(open(`th:${i}`, 'jonathan', i % 2 ? 'art' : 'mark').id, true);
  expect(service.pin('th:0', true).pinned).toBe(true);
  const ninth = open('th:nine');
  expect(() => service.pin(ninth.id, true)).toThrow('eight');
  expect(service.pin(open('th:guest', 'guest').id, true).pinned).toBe(true);
  service.pin('th:0', false);
  expect(service.pin(ninth.id, true).pinned).toBe(true);
  const archived = service.archive(ninth.id, true);
  at('2026-11-14T18:01:00.000Z');
  expect(service.archive(ninth.id, true).archivedAt).toBe(archived.archivedAt);
  expect(service.archive(ninth.id, false).archivedAt).toBeNull();
});

it('advances read position only through existing messages and keeps stop pending until the agent sees it', () => {
  const { db, service, open, at } = fixture();
  const thread = open('th:one');
  expect(service.read(thread.id, 100).readSeq).toBe(0);
  for (let seq = 1; seq <= 3; seq++) db.insert(messages).values({ thread: thread.id, seq, kind: 'message', sender: 'jonathan', at: service.now() }).run();
  expect(service.read(thread.id, 2).readSeq).toBe(2);
  expect(service.read(thread.id, 1).readSeq).toBe(2);
  expect(service.read(thread.id, 100).readSeq).toBe(3);
  expect(() => service.read(thread.id, -1)).toThrow('sequence');
  expect(service.requestStop(thread.id).stopRequested).toBe(false);
  const started = service.working(thread.id, true);
  at('2026-11-14T18:01:00.000Z');
  expect(service.working(thread.id, true)).toMatchObject({ working: true, workingSince: started.workingSince, workingBeat: service.now() });
  expect(service.requestStop(thread.id).stopRequested).toBe(true);
  expect(service.working(thread.id, false)).toMatchObject({ working: false, workingSince: null, workingBeat: null, stopRequested: true });
  expect(service.requestStop(thread.id).stopRequested).toBe(true);
  expect(service.takeStop(thread.id)).toBe(true);
  expect(service.takeStop(thread.id)).toBe(false);
});
