import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, conversations, deletedThreads, jobs, members, messages, threads } from '../data/schema.js';
import { eq } from 'drizzle-orm';
import { CommsMessages } from './messages.js';
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

it('stamps a thread and its conversation from one clock read', async () => {
  const client = new Database(':memory:'); clients.push(client);
  // A clock that never gives the same answer twice, as a real one does not.
  let tick = Date.parse('2026-11-14T18:00:00.000Z');
  const now = () => new Date(tick++).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'member', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const comms = new CommsMessages(db, { seal: async (words: string) => Buffer.from(words), open: async (bytes: Uint8Array) => Buffer.from(bytes).toString(), hash: (words: string) => words }, now);
  const same = () => {
    const thread = db.select().from(threads).get()!, cv = db.select().from(conversations).get()!;
    expect(thread.lastAt).toBe(cv.lastAt);
    return thread;
  };
  const opened = comms.threads.open({ id: 'th:clock', member: 'jonathan', agent: 'art', title: 'Pond pump' });
  expect(same().openedAt).toBe(db.select().from(conversations).get()!.startedAt);
  const message = await comms.send({ thread: opened.id, sender: 'jonathan', kind: 'message', words: 'Is it running?' });
  expect(same().lastAt).toBe(message.at);
});

it('carries a rename to the thread, its conversation and its unfinished job together', () => {
  const { db, service, open } = fixture();
  const thread = open('th:rename');
  const job = (id: string, state: typeof jobs.$inferInsert.state) => db.insert(jobs).values({ id, agent: 'art', conversation: thread.conversation, member: 'jonathan', title: 'Pond pump', brief: '', model: 'm', state,
    startedByKind: 'agent', startedBy: 'art', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: service.now() }).run();
  job('finished', 'done'); job('running', 'running');
  service.rename(thread.id, 'Pump order', 'member');
  const title = (id: string) => db.select({ title: jobs.title }).from(jobs).where(eq(jobs.id, id)).get()!.title;
  expect(db.select().from(conversations).get()!.label).toBe('Pump order');
  // A job still to run or running shows what its thread is called now; a finished one keeps its record.
  expect([title('running'), title('finished')]).toEqual(['Pump order', 'Pond pump']);
});
