import Database from 'better-sqlite3';
import { eq, sql, type SQL } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { createDataSchema } from '../data/database.js';
import { actionResults, agents, household, inbox, members, messages } from '../data/schema.js';
import { CommsMessages } from './messages.js';
import { InboxQueries, inboxQueryFields } from './inbox-query.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
async function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let now = '2026-11-14T18:00:00.000Z', allowed = true, opens = 0, onOpen = () => {};
  const db = createDataSchema(client, () => now);
  for (const id of ['alice', 'bob']) db.insert(members).values({ id, role: 'member', joinedAt: now }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const key = { seal: async (s: string) => Buffer.from(s), hash: (s: string) => s, open: async (b: Uint8Array) => { opens++; onOpen(); return Buffer.from(b).toString(); } };
  const comms = new CommsMessages(db, key, () => now);
  // The composition owns production sharing rules. This fixture's injected SQL
  // policy deliberately tests current authority independently of recipient logic.
  const service = new InboxQueries(db, key, (viewer, f) => allowed && viewer.kind === 'member' ? eq(f.member, viewer.id) : sql`false`, () => now);
  const thread = comms.threads.open({ member: 'alice', agent: 'art', title: 'Private pump' });
  const ask = await comms.ask(thread.id, 'art', 'ask-1', { words: 'Order the private pump?', answers: 'yes-no', why: 'Private reason', ifYes: 'Order it', ifNo: 'Skip it' });
  return { db, comms, service, thread, ask, key, opens: () => opens, revoke: () => { allowed = false; }, onOpen: (fn: () => void) => { onOpen = fn; }, time: (at: string) => { now = at; } };
}
const alice = { kind: 'member' as const, id: 'alice' };
it('queries all sources from the recipient mailbox, with bounded SQL filters, refs and member read marks', async () => {
  const f = await fixture();
  const send = f.comms.threads.conversations;
  const notice = send.send({ toKind: 'person', to: 'alice', source: 'notice', sourceId: 'notice-1', fromKind: 'agent', fromId: 'art', words: 'Finished', member: 'alice', agent: 'art', refs: ['t-1'] });
  send.send({ toKind: 'person', to: 'bob', source: 'notice', fromKind: 'agent', words: 'Bob only', member: 'alice' });
  expect(f.service.list(alice)).toHaveLength(2);
  expect(f.service.list(alice, { state: 'waiting', source: 'notice', agent: 'art', limit: 1 }).map(i => i.id)).toEqual([notice.id]);
  expect(f.service.list(alice, { offset: 2 })).toEqual([]);
  expect(f.service.list({ kind: 'member', id: 'bob' })).toEqual([]);
  expect(f.service.list({ kind: 'service', id: 's' })).toEqual([]);
  expect(f.service.refs(alice, notice.id)).toEqual(['t-1']);
  expect(f.service.read(alice, notice.id)).toBe(false);
  send.read(notice.id, 'alice');
  expect(f.service.read(alice, notice.id)).toBe(true);
  expect(await f.service.body(alice, notice.id)).toMatchObject({ words: 'Finished' });
  expect(() => f.service.list(alice, { limit: 101 })).toThrow('Invalid Inbox page');
  f.revoke();
  expect(f.service.item(alice, notice.id)).toBeNull();
  expect(f.service.list(alice)).toEqual([]); expect(f.service.refs(alice, notice.id)).toEqual([]); expect(f.service.read(alice, notice.id)).toBe(false);
});
it('lazily selects private question bodies through the shared GraphQL field group, without durable plaintext', async () => {
  const f = await fixture();
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: inboxQueryFields(f.service) }) });
  const contextValue = { viewer: alice };
  const metadata = await graphql({ schema, source: '{ inboxItems { id source answers read refs } }', contextValue });
  expect(metadata.errors).toBeUndefined(); expect(f.opens()).toBe(0);
  const result = await graphql({ schema, source: '{ inboxItems { body { words why ifYes ifNo } } }', contextValue });
  expect(result.errors).toBeUndefined();
  expect(JSON.parse(JSON.stringify(result.data))).toEqual({ inboxItems: [{ body: { words: 'Order the private pump?', why: 'Private reason', ifYes: 'Order it', ifNo: 'Skip it' } }] });
  expect(f.opens()).toBe(1);
  expect(JSON.stringify(f.db.select().from(inbox).all())).not.toContain('private pump');
});
it('withholds private bodies after changes to policy, item, ciphertext, deadline, household retention or thread', async () => {
  for (const change of ['policy', 'item', 'ciphertext', 'deadline', 'household', 'delete'] as const) {
    const f = await fixture();
    f.onOpen(() => {
      if (change === 'policy') f.revoke();
      if (change === 'item') f.db.update(inbox).set({ words: 'Changed' }).where(eq(inbox.id, f.ask.inboxItem!)).run();
      if (change === 'ciphertext') f.db.update(messages).set({ words: Buffer.from('Changed') }).run();
      if (change === 'deadline') f.db.update(messages).set({ keepUntil: '2026-11-16T18:00:00.000Z' }).run();
      if (change === 'household') f.db.insert(household).values({ commsDays: 1 }).run();
      if (change === 'delete') f.comms.delete(f.thread.id);
    });
    expect(await f.service.body(alice, f.ask.inboxItem!), change).toBeNull();
  }
});
it('never opens expired private words or accepts a missing SQL policy predicate', async () => {
  const f = await fixture();
  f.time('2026-11-29T18:00:00.000Z');
  expect(await f.service.body(alice, f.ask.inboxItem!)).toBeNull(); expect(f.opens()).toBe(0);
  const broken = new InboxQueries(f.db, f.key, () => undefined as unknown as SQL);
  expect(() => broken.list(alice)).toThrow('SQL Inbox visibility required');
});

it('keeps recent action outcomes and agent mailbox reads addressed to the authenticated recipient', async () => {
  const f = await fixture();
  f.db.insert(actionResults).values([
    { id: 'r1', member: 'alice', at: '2026-11-14T18:00:00.000Z', ok: true, text: 'Answer: saved', page: '/inbox' },
    { id: 'r2', member: 'bob', at: '2026-11-14T18:01:00.000Z', ok: false, text: 'Bob private failure', page: '/tasks' },
  ]).run();
  expect(f.service.results(alice).map(r => r.id)).toEqual(['r1']);
  expect(f.service.results({ kind: 'agent', id: 'art' })).toEqual([]);
  expect(() => f.service.results(alice, 51)).toThrow('Invalid action result limit');
  const agentMail = f.comms.threads.conversations.send({ toKind: 'agent', to: 'art', source: 'handoff', fromKind: 'agent', words: 'A brief' });
  const agentReads = new InboxQueries(f.db, f.key, () => sql`true`);
  expect(agentReads.list({ kind: 'agent', id: 'art' }).map(i => i.id)).toEqual([agentMail.id]);
});
