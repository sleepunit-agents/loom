import Database from 'better-sqlite3';
import { eq, sql, type SQL } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { createDataSchema } from '../data/database.js';
import { actionResults, agents, household, inbox, members, messages, threads } from '../data/schema.js';
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
  const ask = await comms.ask(thread.id, 'art', 'ask-1', { words: 'Order the private pump?', answers: 'yes-no', why: 'Private reason', ifYes: 'Order it', ifNo: 'Skip it', link: 'https://example.test/private-question' });
  return { db, comms, service, thread, ask, key, opens: () => opens, revoke: () => { allowed = false; }, onOpen: (fn: () => void) => { onOpen = fn; }, time: (at: string) => { now = at; } };
}
const alice = { kind: 'member' as const, id: 'alice' };
it('queries all sources from the recipient mailbox, with bounded SQL filters, refs and member read marks', async () => {
  const f = await fixture();
  const send = f.comms.threads.conversations;
  const notice = send.send({ toKind: 'person', to: 'alice', source: 'notice', sourceId: 'notice-1', fromKind: 'agent', fromId: 'art', words: 'Finished', member: 'alice', agent: 'art', refs: ['t-1'] });
  const other = send.send({ toKind: 'person', to: 'bob', source: 'notice', fromKind: 'agent', words: 'Bob only', member: 'alice', refs: ['t-2'] });
  expect(f.service.item(alice, other.id)?.to).toBe('bob');
  expect(f.service.refs(alice, other.id)).toEqual(['t-2']);
  expect(await f.service.body(alice, other.id)).toMatchObject({ words: 'Bob only' });
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
  const result = await graphql({ schema, source: '{ inboxItems { body { words why ifYes ifNo link } } }', contextValue });
  expect(result.errors).toBeUndefined();
  expect(JSON.parse(JSON.stringify(result.data))).toEqual({ inboxItems: [{ body: { words: 'Order the private pump?', why: 'Private reason', ifYes: 'Order it', ifNo: 'Skip it', link: 'https://example.test/private-question' } }] });
  expect(f.opens()).toBe(1);
  expect(JSON.stringify(f.db.select().from(inbox).all())).not.toContain('private pump');
});
it('withholds private bodies after changes to policy, item, ciphertext, deadline, household retention or thread', async () => {
  for (const change of ['policy', 'item', 'ciphertext', 'deadline', 'household', 'timestamp', 'kind', 'delete'] as const) {
    const f = await fixture();
    f.onOpen(() => {
      if (change === 'timestamp') f.db.update(messages).set({ at: '2026-11-14T18:01:00.000Z' }).run();
      if (change === 'kind') f.db.update(messages).set({ kind: 'reply' }).run();
      if (change === 'policy') f.revoke();
      if (change === 'item') f.db.update(inbox).set({ words: 'Changed' }).where(eq(inbox.id, f.ask.inboxItem!)).run();
      if (change === 'ciphertext') f.db.update(messages).set({ words: Buffer.from('Changed') }).run();
      if (change === 'linkage') f.db.update(threads).set({ conversation: f.comms.threads.conversations.open({ agent: 'art', venue: 'loom', place: 'other', member: 'alice', label: 'Other' }).id }).where(eq(threads.id, f.thread.id)).run();
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
it('applies the current household keep duration and earlier stored deadline independently', async () => {
  for (const expiry of ['household', 'deadline'] as const) {
    const f = await fixture();
    if (expiry === 'household') {
      f.db.insert(household).values({ commsDays: 1 }).run();
      f.time('2026-11-15T18:00:00.000Z');
    } else f.db.update(messages).set({ keepUntil: '2026-11-14T18:00:00.000Z' }).run();
    expect(await f.service.body(alice, f.ask.inboxItem!), expiry).toBeNull();
    expect(f.opens()).toBe(0);
  }
});
it('bounds and pages actual results and applies each mailbox filter independently', async () => {
  const f = await fixture(), cvs = f.comms.threads.conversations;
  f.db.insert(agents).values({ id: 'mark', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const first = cvs.send({ toKind: 'person', to: 'alice', source: 'notice', fromKind: 'agent', words: 'Art update', agent: 'art', member: 'alice' });
  const second = cvs.send({ toKind: 'person', to: 'alice', source: 'notice', fromKind: 'agent', words: 'Mark update', agent: 'mark', member: 'alice' });
  f.db.update(inbox).set({ state: 'done' }).where(eq(inbox.id, second.id)).run();
  const all = f.service.list(alice);
  expect(all).toHaveLength(3);
  expect(f.service.list(alice, { limit: 1 }).map(i => i.id)).toEqual([all[0].id]);
  expect(f.service.list(alice, { limit: 1, offset: 1 }).map(i => i.id)).toEqual([all[1].id]);
  expect(f.service.list(alice, { state: 'done' }).map(i => i.id)).toEqual([second.id]);
  expect(f.service.list(alice, { state: 'waiting' }).map(i => i.id).sort()).toEqual([first.id, f.ask.inboxItem!].sort());
  expect(f.service.list(alice, { agent: 'mark' }).map(i => i.id)).toEqual([second.id]);
  expect(f.service.list(alice, { agent: 'art' }).map(i => i.id).sort()).toEqual([first.id, f.ask.inboxItem!].sort());
  expect(f.service.list(alice, { source: 'thread' }).map(i => i.id)).toEqual([f.ask.inboxItem]);
});
it('caps returned action outcomes and denies nonmembers even when their IDs match a member', async () => {
  const f = await fixture();
  f.db.insert(actionResults).values([
    { id: 'older', member: 'alice', at: '2026-11-14T18:00:00.000Z', ok: true, text: 'Saved', page: '/inbox' },
    { id: 'newer', member: 'alice', at: '2026-11-14T18:01:00.000Z', ok: false, text: 'Not saved', page: '/inbox' },
  ]).run();
  expect(f.service.results(alice, 1).map(r => r.id)).toEqual(['newer']);
  for (const kind of ['agent', 'service', 'runner'] as const) expect(f.service.results({ kind, id: 'alice' })).toEqual([]);
});
it('returns every named public question detail without decrypting', async () => {
  const f = await fixture();
  const details = { words: 'Proceed?', why: 'Ready now', ifYes: 'Proceed', ifNo: 'Wait', link: 'https://example.test/question' };
  const question = f.comms.threads.conversations.send({ toKind: 'person', to: 'alice', source: 'task', fromKind: 'agent', member: 'alice', answers: 'yes-no', ...details });
  expect(await f.service.body(alice, question.id)).toEqual(details);
  expect(f.opens()).toBe(0);
});
it('withholds words if time passes their unchanged stored or household deadline during decryption', async () => {
  for (const expiry of ['deadline', 'household'] as const) {
    const f = await fixture();
    if (expiry === 'deadline') {
      f.db.update(messages).set({ keepUntil: '2026-11-14T18:01:00.000Z' }).run();
      f.onOpen(() => f.time('2026-11-14T18:01:00.000Z'));
    } else {
      f.db.insert(household).values({ commsDays: 1 }).run();
      f.onOpen(() => f.time('2026-11-15T18:00:00.000Z'));
    }
    expect(await f.service.body(alice, f.ask.inboxItem!), expiry).toBeNull();
    expect(f.opens()).toBe(1);
  }
});

it('searches the whole mailbox before paging, across sources and references, through GraphQL', async () => {
  const f = await fixture(), cvs = f.comms.threads.conversations;
  const wanted = cvs.send({ toKind: 'person', to: 'alice', source: 'task', member: 'alice', fromKind: 'agent', words: 'Needle older question', refs: ['t-987'] });
  f.time('2026-11-14T19:00:00.000Z');
  for (let i = 0; i < 105; i++) cvs.send({ toKind: 'person', to: 'alice', source: 'notice', member: 'alice', fromKind: 'agent', words: `Unrelated ${i}` });
  expect(f.service.list(alice).map(i => i.id)).not.toContain(wanted.id);
  expect((await f.service.search(alice, { search: '  NEEDLE  ', limit: 1 })).map(i => i.id)).toEqual([wanted.id]);
  expect(await f.service.search(alice, { search: 'Needle', offset: 1 })).toEqual([]);
  expect((await f.service.search(alice, { search: 't-987' })).map(i => i.id)).toEqual([wanted.id]);
  expect(await f.service.search(alice, { search: 'Needle', source: 'notice' })).toEqual([]);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: inboxQueryFields(f.service) }) });
  const result = await graphql({ schema, source: '{ inboxItems(search: "needle", limit: 1) { id } }', contextValue: { viewer: alice } });
  expect(result.errors).toBeUndefined();
  expect(JSON.parse(JSON.stringify(result.data))).toEqual({ inboxItems: [{ id: wanted.id }] });
});
it('searches retained private wording without persisting it and never searches another recipient', async () => {
  const f = await fixture();
  expect((await f.service.search(alice, { search: 'PRIVATE REASON' })).map(i => i.id)).toEqual([f.ask.inboxItem]);
  expect(JSON.stringify(f.db.select().from(inbox).all())).not.toContain('Private reason');
  expect(await f.service.search({ kind: 'member', id: 'bob' }, { search: 'private' })).toEqual([]);
  f.time('2026-11-29T18:00:00.000Z');
  const opened = f.opens();
  expect(await f.service.search(alice, { search: 'private' })).toEqual([]);
  expect(f.opens()).toBe(opened);
});
it('withdraws earlier matches when later decrypts revoke access or let private matches expire', async () => {
  for (const change of ['policy', 'expiry', 'ciphertext', 'linkage', 'household', 'deadline'] as const) {
    const f = await fixture();
    await f.comms.ask(f.thread.id, 'art', 'ask-2', { words: 'Another private question', answers: 'yes-no' });
    let count = 0;
    f.onOpen(() => {
      if (++count !== 2) return;
      if (change === 'policy') f.revoke();
      if (change === 'expiry') f.time('2026-11-29T18:00:00.000Z');
      if (change === 'household') f.db.insert(household).values({ commsDays: 1 }).run();
      if (change === 'deadline') f.db.update(messages).set({ keepUntil: '2026-11-14T18:00:00.000Z' }).run();
      if (change === 'ciphertext') f.db.update(messages).set({ words: Buffer.from('Changed') }).run();
      if (change === 'linkage') f.db.update(threads).set({ conversation: f.comms.threads.conversations.open({ agent: 'art', venue: 'loom', place: 'other', member: 'alice', label: 'Other' }).id }).where(eq(threads.id, f.thread.id)).run();
    });
    expect(await f.service.search(alice, { search: 'private' }), change).toEqual([]);
  }
});
it('validates search and paging bounds and treats metacharacters literally', async () => {
  const f = await fixture();
  expect(await f.service.search(alice, { search: 'x'.repeat(501) })).toEqual([]);
  await expect(f.service.search(alice, { search: 'private', limit: 101 })).rejects.toThrow('Invalid Inbox page');
  await expect(f.service.search(alice, { search: 'private', offset: -1 })).rejects.toThrow('Invalid Inbox page');
  expect(await f.service.search(alice, { search: '%_' })).toEqual([]);
  expect(await f.service.search(alice, { search: '  ' })).toEqual(f.service.list(alice));
});

it('searches answered items and individual metadata fields, without crossing field boundaries or recipients', async () => {
  const f = await fixture(), cvs = f.comms.threads.conversations;
  const first = cvs.send({ toKind: 'person', to: 'alice', source: 'task', sourceId: 'unique-source', fromKind: 'agent', fromId: 'author', member: 'alice', agent: 'art', words: 'Matched question', answers: 'yes-no', refs: ['alpha', 'beta'] });
  // Linked task answers arrive from the task's own operation.
  f.db.update(inbox).set({ state: 'answered', answer: 'yes', answeredBy: 'alice', answeredAt: '2026-11-14T18:00:00.000Z' }).where(eq(inbox.id, first.id)).run();
  const second = cvs.send({ toKind: 'person', to: 'alice', source: 'notice', fromKind: 'agent', member: 'alice', words: 'Matched notice' });
  cvs.send({ toKind: 'person', to: 'bob', source: 'notice', fromKind: 'agent', member: 'alice', words: 'Matched other mailbox' });
  const all = await f.service.search(alice, { search: 'matched' });
  expect(all.map(i => i.id).sort()).toEqual([first.id, second.id].sort());
  expect((await f.service.search(alice, { search: 'matched', limit: 1 })).map(i => i.id)).toEqual([all[0].id]);
  expect((await f.service.search(alice, { search: 'matched', limit: 1, offset: 1 })).map(i => i.id)).toEqual([all[1].id]);
  expect((await f.service.search(alice, { search: 'matched', state: 'answered' })).map(i => i.id)).toEqual([first.id]);
  for (const search of [first.id, 'task', 'unique-source', 'author']) expect((await f.service.search(alice, { search })).map(i => i.id)).toContain(first.id);
  expect(await f.service.search(alice, { search: 'alpha beta' })).toEqual([]);
});

it('searches each remaining question body field and a long literal passage', async () => {
  const f = await fixture();
  for (const search of ['Order it', 'Skip it', 'https://example.test/private-question']) {
    expect((await f.service.search(alice, { search })).map(i => i.id)).toEqual([f.ask.inboxItem]);
  }
  const passage = 'a'.repeat(501);
  const item = f.comms.threads.conversations.send({ toKind: 'person', to: 'alice', source: 'notice', fromKind: 'agent', member: 'alice', words: passage });
  expect((await f.service.search(alice, { search: passage })).map(i => i.id)).toEqual([item.id]);
});
