import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { createDataSchema } from '../data/database.js';
import { agents, members, memberAgents, projectMembers, projectAgents, projects, conversations, messages, household } from '../data/schema.js';
import { CommsMessages } from './messages.js';
import { ConversationSummaries, conversationSummaryFields } from './summaries.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function setup() {
  const client = new Database(':memory:'); clients.push(client);
  let now = '2026-11-14T18:00:00.000Z', opens = 0;
  let onOpen = () => {};
  const db = createDataSchema(client, () => now);
  for (const [id, role] of [['owner', 'owner'], ['alice', 'member'], ['bob', 'member']] as const) db.insert(members).values({ id, role, joinedAt: now }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond', summary: '' }).run();
  db.insert(projectMembers).values({ project: 'pond', member: 'bob' }).run();
  const key = { seal: async (s: string) => Buffer.from(s), open: async (b: Uint8Array) => { opens++; onOpen(); return Buffer.from(b).toString(); }, hash: (s: string) => s };
  const comms = new CommsMessages(db, key, () => now), service = new ConversationSummaries(db, key, () => now);
  const thread = comms.threads.open({ id: 'th:private', member: 'alice', agent: 'art', project: 'pond', title: 'Private pump' });
  return { db, comms, service, thread, opens: () => opens, onOpen: (f: () => void) => { onOpen = f; }, setTime: (s: string) => { now = s; } };
}
it('bounds and sorts recent conversations, with private member taking precedence over project and agent', () => {
  const { service, comms, thread, db } = setup();
  comms.threads.conversations.open({ agent: 'mark', venue: 'discord', place: 'pond', project: 'pond', label: 'Another agent' });
  const shared = comms.threads.conversations.open({ agent: 'art', venue: 'discord', place: 'pond', project: 'pond', label: 'Shared pump' });
  db.update(conversations).set({ lastAt: '2026-11-14T19:00:00.000Z' }).where(eq(conversations.id, shared.id)).run();
  expect(service.recent({ kind: 'member', id: 'bob' }, 'art').map(r => r.id)).toEqual([shared.id]);
  expect(service.recent({ kind: 'member', id: 'alice' }, 'art').map(r => r.id)).toEqual([shared.id, thread.conversation]);
  expect(service.recent({ kind: 'member', id: 'owner' }, 'art', 1).map(r => r.id)).toEqual([shared.id]);
  expect(service.recent({ kind: 'agent', id: 'art' }, 'art').map(r => r.id)).toEqual([shared.id]);
  db.insert(projectAgents).values({ project: 'pond', agent: 'mark' }).run();
  expect(service.recent({ kind: 'agent', id: 'mark' }, 'art').map(r => r.id)).toEqual([shared.id]);
  db.delete(projectAgents).run();
  expect(service.recent({ kind: 'agent', id: 'mark' }, 'art')).toEqual([]);
  db.delete(projectMembers).run();
  expect(service.recent({ kind: 'member', id: 'bob' }, 'art')).toEqual([]);
  db.delete(memberAgents).run();
  expect(service.recent({ kind: 'member', id: 'alice' }, 'art').map(r => r.id)).toEqual([thread.conversation]);
  expect(service.recent({ kind: 'runner', id: 'r' }, 'art')).toEqual([]);
  expect(service.recent({ kind: 'service', id: 's' }, 'art')).toEqual([]);
  expect(() => service.recent({ kind: 'member', id: 'owner' }, 'art', 26)).toThrow('1–25');
});
async function commsPersonAnswer(f: ReturnType<typeof setup>) {
  const question = await f.comms.ask(f.thread.id, 'art', 'ask-1', { words: 'Allow the change?', answers: 'yes-no' });
  await f.comms.answer(question.inboxItem!, 'alice', 'yes');
}
it('returns only the latest agent reply, selected lazily through the shared query field group', async () => {
  const f = setup();
  await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'reply', words: 'First answer' });
  await f.comms.send({ thread: f.thread.id, sender: 'alice', kind: 'message', words: 'Latest person message' });
  await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'card', words: 'Progress' });
  await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'reply', words: 'Latest agent answer' });
  await commsPersonAnswer(f);
  await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'card', words: 'Later progress' });
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: conversationSummaryFields(f.service) }) });
  const contextValue = { viewer: { kind: 'member', id: 'owner' } };
  const metadata = await graphql({ schema, source: '{ recentConversations(agent:"art") { label } }', contextValue });
  expect(metadata.errors).toBeUndefined(); expect(f.opens()).toBe(0);
  const result = await graphql({ schema, source: '{ recentConversations(agent:"art",limit:1) { lastAnswer { words } } }', contextValue });
  expect(result.errors).toBeUndefined();
  expect(JSON.parse(JSON.stringify(result.data))).toEqual({ recentConversations: [{ lastAnswer: { words: 'Latest agent answer' } }] });
  expect(await f.service.lastAnswer({ kind: 'member', id: 'bob' }, f.thread.conversation)).toBeNull();
  expect(f.opens()).toBe(1);
});
it('withholds words when sharing, exact ciphertext, retention or the thread changes during decryption', async () => {
  for (const change of ['sharing', 'ciphertext', 'expiry', 'deadline', 'household', 'scope', 'delete'] as const) {
    const f = setup();
    await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'reply', words: 'Private answer' });
    f.onOpen(() => {
      if (change === 'scope') f.db.update(conversations).set({ member: 'bob' }).where(eq(conversations.id, f.thread.conversation)).run();
      if (change === 'sharing') f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'owner')).run();
      if (change === 'ciphertext') f.db.update(messages).set({ words: Buffer.from('Replacement') }).run();
      if (change === 'household') f.db.insert(household).values({ commsDays: 1 }).run();
      if (change === 'deadline') f.db.update(messages).set({ keepUntil: '2026-11-16T18:00:00.000Z' }).run();
      if (change === 'expiry') f.setTime('2026-11-29T18:00:00.000Z');
      if (change === 'delete') f.comms.delete(f.thread.id);
    });
    expect(await f.service.lastAnswer({ kind: 'member', id: 'owner' }, f.thread.conversation), change).toBeNull();
  }
});

it('never falls back to an older answer when the latest reply words are unavailable', async () => {
  const f = setup();
  await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'reply', words: 'Older' });
  const latest = await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'reply', words: 'Latest' });
  f.db.update(messages).set({ words: null }).where(eq(messages.seq, latest.seq)).run();
  expect(await f.service.lastAnswer({ kind: 'member', id: 'owner' }, f.thread.conversation)).toBeNull();
  expect(f.opens()).toBe(0);
});
it('applies a shortened household keep time to existing replies before decrypting', async () => {
  const f = setup();
  await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'reply', words: 'Old answer' });
  f.db.insert(household).values({ commsDays: 1 }).run();
  f.setTime('2026-11-15T18:00:00.000Z');
  expect(await f.service.lastAnswer({ kind: 'member', id: 'owner' }, f.thread.conversation)).toBeNull();
  expect(f.opens()).toBe(0);
});

it('withholds words after an earlier stored deadline even when message age is still within household retention', async () => {
  const f = setup();
  await f.comms.send({ thread: f.thread.id, sender: 'art', kind: 'reply', words: 'Answer' });
  f.db.update(messages).set({ keepUntil: '2026-11-14T18:00:00.000Z' }).run();
  expect(await f.service.lastAnswer({ kind: 'member', id: 'owner' }, f.thread.conversation)).toBeNull();
  expect(f.opens()).toBe(0);
});
it('enforces the fourteen-day household keep maximum at the database boundary', () => {
  const f = setup();
  expect(() => f.db.insert(household).values({ commsDays: 15 }).run()).toThrow();
});
