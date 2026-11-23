import {readDeadline,readRetained} from '../data/read-lease.js';
import { DataLive } from '../data/live.js';
import {sealHandoff} from './handoff-words.js';
import Database from 'better-sqlite3';
import { eq, sql, type SQL } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { createDataSchema } from '../data/database.js';
import { actionResults, agents, bridgeConnections, bridgeIncoming, bridgeSends, conversations, household, inbox, inboxReads, memberAgents, members, messages, secrets, threads } from '../data/schema.js';
import { talkVisibility } from '../data/conversation-visibility.js';
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
  // One rule (policy.ts, ownNotice) for this read and for marking a notice read: an agent working for alice is not alice,
  // and a member who has been removed reads nothing.
  expect(f.service.results({ kind: 'agent', id: 'art', workingFor: 'alice' })).toEqual([]);
  f.db.update(members).set({ removedAt: '2026-11-14T18:02:00.000Z' }).where(eq(members.id, 'bob')).run();
  expect(f.service.results({ kind: 'member', id: 'bob' })).toEqual([]);
  f.db.update(members).set({ removedAt: null }).where(eq(members.id, 'bob')).run();
  expect(() => f.service.results(alice, 51)).toThrow('Invalid action result limit');
  const encoded=await sealHandoff(f.key,'A brief','2026-11-14T18:00:00.000Z',14);
  const agentMail = f.comms.threads.conversations.send({ toKind: 'agent', to: 'art', source: 'handoff', fromKind: 'agent', words: encoded });
  const agentReads = new InboxQueries(f.db, f.key, () => sql`true`);
  expect(agentReads.list({ kind: 'agent', id: 'art' }).map(i => i.id)).toEqual([agentMail.id]);
  expect(await agentReads.body({kind:'agent',id:'art'},agentMail.id)).toBeNull();
  expect(await agentReads.search({kind:'agent',id:'art'},{search:'loom:handoff:v1'})).toEqual([]);
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
it('expires a page whose offset depends on a retained private match',async()=>{
  const f=await fixture();
  f.time('2026-11-14T17:00:00.000Z');
  const notice=f.comms.threads.conversations.send({toKind:'person',to:'alice',source:'notice',fromKind:'agent',member:'alice',words:'Private reason in a plain notice'});
  f.time('2026-11-14T19:00:00.000Z');
  const context={viewer:alice};
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:inboxQueryFields(f.service)})});
  const query='{ inboxItems(search:"private reason",offset:1,limit:1){id} }';
  const first=await graphql({schema,source:query,contextValue:context});
  expect(first.data?.inboxItems).toEqual([{id:notice.id}]);
  const until=Date.parse('2026-11-28T18:00:00.000Z');
  expect(readDeadline(context)).toBe(until);
  expect(readRetained(context,until)).toBe(false);
  f.time(new Date(until).toISOString());
  const next=await graphql({schema,source:query,contextValue:{viewer:alice}});
  expect(next.data?.inboxItems).toEqual([]);
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
  const literal = f.comms.threads.conversations.send({ toKind: 'person', to: 'alice', source: 'notice', fromKind: 'agent', member: 'alice', words: 'Contains %_ literally' });
  expect((await f.service.search(alice, { search: '%_' })).map(i => i.id)).toEqual([literal.id]);
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

it('orders mailbox pages and action notices by actual time across timestamp precision', async () => {
  const f = await fixture(), cvs = f.comms.threads.conversations;
  const older = cvs.send({ toKind: 'person', to: 'alice', source: 'notice', fromKind: 'agent', words: 'Older', member: 'alice' });
  const newer = cvs.send({ toKind: 'person', to: 'alice', source: 'notice', fromKind: 'agent', words: 'Newer', member: 'alice' });
  f.db.update(inbox).set({ at: '2026-11-14T18:00:00Z' }).where(eq(inbox.id, older.id)).run();
  f.db.update(inbox).set({ at: '2026-11-14T18:00:00.500Z' }).where(eq(inbox.id, newer.id)).run();
  expect(f.service.list(alice, { source: 'notice', limit: 1 }).map(row => row.id)).toEqual([newer.id]);
  expect(f.service.list(alice, { source: 'notice', limit: 1, offset: 1 }).map(row => row.id)).toEqual([older.id]);
  f.db.insert(actionResults).values([
    { id: 'older', member: 'alice', at: '2026-11-14T18:00:00Z', ok: true, text: 'Older', page: '/inbox' },
    { id: 'newer', member: 'alice', at: '2026-11-14T18:00:00.500Z', ok: true, text: 'Newer', page: '/inbox' },
  ]).run();
  expect(f.service.results(alice, 1).map(row => row.id)).toEqual(['newer']);
});
it('shows retained private answer words lazily in Answered without storing plaintext in Inbox', async () => {
  const f = await fixture();
  await f.comms.answer(f.ask.inboxItem!, 'alice', 'words', 'Please order the smaller model');
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: inboxQueryFields(f.service) }) });
  const contextValue = { viewer: alice };
  const meta = await graphql({ schema, source: '{ inboxItems(state:"answered") { answer answeredBy answeredAt } }', contextValue });
  expect(meta.errors).toBeUndefined(); expect(f.opens()).toBe(0);
  expect(JSON.parse(JSON.stringify(meta.data))).toEqual({ inboxItems: [{ answer: 'words', answeredBy: 'alice', answeredAt: '2026-11-14T18:00:00.000Z' }] });
  const result = await graphql({ schema, source: '{ inboxItems(state:"answered") { answerText } }' , contextValue });
  expect(result.errors).toBeUndefined();
  expect(JSON.parse(JSON.stringify(result.data))).toEqual({ inboxItems: [{ answerText: 'Please order the smaller model' }] });
  expect(f.opens()).toBe(1);
  expect(f.db.select().from(inbox).all().every(row => row.words === null && row.answerText === null)).toBe(true);
  f.time('2026-11-29T18:00:00.000Z');
  expect(await f.service.answerText(alice, f.ask.inboxItem!)).toBeNull(); expect(f.opens()).toBe(1);
});
it('withholds private answer words after current question, linkage, policy, retention or ciphertext changes', async () => {
  for (const change of ['policy', 'question', 'message-link', 'answerer', 'message-sender', 'message-kind', 'mail-source', 'mail-sender', 'ciphertext', 'deadline', 'household', 'expiry', 'delete'] as const) {
    const f = await fixture();
    await f.comms.answer(f.ask.inboxItem!, 'alice', 'words', 'Private answer words');
    f.onOpen(() => {
      if (change === 'policy') f.revoke();
      if (change === 'question') f.db.update(inbox).set({ state: 'resolved' }).where(eq(inbox.id, f.ask.inboxItem!)).run();
      if (change === 'answerer') f.db.update(inbox).set({ answeredBy: 'bob' }).where(eq(inbox.id, f.ask.inboxItem!)).run();
      if (change === 'message-link') f.db.update(messages).set({ inboxItem: null }).where(eq(messages.kind, 'answer')).run();
      if (change === 'message-sender') f.db.update(messages).set({ sender: 'bob' }).where(eq(messages.kind, 'answer')).run();
      if (change === 'message-kind') f.db.update(messages).set({ kind: 'reply' }).where(eq(messages.kind, 'answer')).run();
      if (change === 'mail-source') f.db.update(inbox).set({ sourceId: 'another-question' }).where(eq(inbox.source, 'answer')).run();
      if (change === 'mail-sender') f.db.update(inbox).set({ fromId: 'bob' }).where(eq(inbox.source, 'answer')).run();
      if (change === 'ciphertext') f.db.update(messages).set({ words: Buffer.from('Replacement') }).where(eq(messages.kind, 'answer')).run();
      if (change === 'deadline') f.db.update(messages).set({ keepUntil: '2026-11-14T18:00:00.000Z' }).where(eq(messages.kind, 'answer')).run();
      if (change === 'household') f.db.insert(household).values({ commsDays: 1 }).run();
      if (change === 'expiry') f.time('2026-11-29T18:00:00.000Z');
      if (change === 'delete') f.comms.delete(f.thread.id);
    });
    expect(await f.service.answerText(alice, f.ask.inboxItem!), change).toBeNull();
  }
});
it('keeps ordinary answer text, leaves unanswered/private yes-no text empty, and never caches previous reads', async () => {
  const f = await fixture(), cvs = f.comms.threads.conversations;
  expect(await f.service.answerText(alice, f.ask.inboxItem!)).toBeNull();
  const plain = cvs.send({ toKind: 'person', to: 'alice', source: 'notice', fromKind: 'agent', words: 'Question', answers: 'words', member: 'alice' });
  cvs.answer(plain.id, 'alice', 'words', 'An ordinary answer');
  expect(await f.service.answerText(alice, plain.id)).toBe('An ordinary answer');
  await f.comms.answer(f.ask.inboxItem!, 'alice', 'words', 'First answer');
  expect(await f.service.answerText(alice, f.ask.inboxItem!)).toBe('First answer');
  f.db.update(messages).set({ words: Buffer.from('Current answer') }).where(eq(messages.kind, 'answer')).run();
  expect(await f.service.answerText(alice, f.ask.inboxItem!)).toBe('Current answer');
  f.revoke(); expect(await f.service.answerText(alice, plain.id)).toBeNull();
  expect(await f.service.answerText(alice, f.ask.inboxItem!)).toBeNull();
});

it('reads replied answers even when append and question timestamps differ under a moving clock', async () => {
  const f = await fixture();
  let tick = Date.parse('2026-11-14T18:00:00.000Z');
  const moving = new CommsMessages(f.db, f.key, () => new Date(tick++).toISOString());
  await moving.answer(f.ask.inboxItem!, 'alice', 'replied', 'My reply in words');
  const question = f.service.item(alice, f.ask.inboxItem!)!;
  const answerMessage = f.db.select().from(messages).where(eq(messages.kind, 'answer')).get()!;
  expect(answerMessage.at).not.toBe(question.answeredAt);
  expect(await f.service.answerText(alice, f.ask.inboxItem!)).toBe('My reply in words');
});
it('rechecks answer-only access and retention at the final await boundary', async () => {
  for (const change of ['answer-policy', 'household', 'expiry', 'thread-link'] as const) {
    const f = await fixture();
    await f.comms.answer(f.ask.inboxItem!, 'alice', 'words', 'Answer');
    let answerAllowed = true;
    const service = new InboxQueries(f.db, f.key, (v, fields) => sql`${fields.member} = ${v.id} and (${fields.source} != 'answer' or ${Number(answerAllowed)})`, () => currentTime);
    let currentTime = '2026-11-14T18:00:00.000Z';
    f.onOpen(() => queueMicrotask(() => queueMicrotask(() => {
      if (change === 'answer-policy') answerAllowed = false;
      if (change === 'thread-link') {
        const other = f.comms.threads.conversations.open({ agent: 'art', member: 'alice', venue: 'loom', place: 'th:other', label: 'Other' });
        f.db.update(threads).set({ conversation: other.id }).where(eq(threads.id, f.thread.id)).run();
      }
      if (change === 'household') f.db.insert(household).values({ commsDays: 1 }).run();
      if (change === 'expiry') currentTime = '2026-11-29T18:00:00.000Z';
    })));
    expect(await service.answerText(alice, f.ask.inboxItem!), change).toBeNull();
    expect(f.opens()).toBe(1);
  }
});

it('erases expired private answer ciphertext while preserving question and answer metadata', async () => {
  const f = await fixture();
  await f.comms.answer(f.ask.inboxItem!, 'alice', 'words', 'Private retained reply');
  f.time('2026-11-28T18:00:00.000Z');
  expect(f.comms.expire()).toBe(2);
  expect(f.db.select().from(messages).all().every(row => row.words === null)).toBe(true);
  expect(f.service.item(alice, f.ask.inboxItem!)).toMatchObject({ state: 'answered', answer: 'words', answeredBy: 'alice', answeredAt: '2026-11-14T18:00:00.000Z' });
  expect(await f.service.answerText(alice, f.ask.inboxItem!)).toBeNull(); expect(f.opens()).toBe(0);
});
it('rejects initially mismatched answer bindings rather than returning another question answer', async () => {
  for (const mismatch of ['source', 'sender', 'kind', 'link'] as const) {
    const f = await fixture();
    await f.comms.answer(f.ask.inboxItem!, 'alice', 'words', 'First answer');
    const other = await f.comms.ask(f.thread.id, 'art', 'ask-other', { words: 'Other?', answers: 'words' });
    await f.comms.answer(other.inboxItem!, 'alice', 'words', 'Other answer');
    const mail = f.db.select().from(inbox).where(eq(inbox.sourceId, f.ask.inboxItem!)).get()!;
    if (mismatch === 'source') f.db.update(inbox).set({ sourceId: 'unrelated' }).where(eq(inbox.id, mail.id)).run();
    if (mismatch === 'sender') f.db.update(messages).set({ sender: 'bob' }).where(eq(messages.seq, mail.messageSeq!)).run();
    if (mismatch === 'kind') f.db.update(messages).set({ kind: 'reply' }).where(eq(messages.seq, mail.messageSeq!)).run();
    if (mismatch === 'link') f.db.update(messages).set({ inboxItem: null }).where(eq(messages.seq, mail.messageSeq!)).run();
    expect(await f.service.answerText(alice, f.ask.inboxItem!), mismatch).toBeNull(); expect(f.opens()).toBe(0);
    expect(await f.service.answerText(alice, other.inboxItem!)).toBe('Other answer');
  }
});

it('withholds question, answer and search wording at a whole-second stored deadline', async () => {
  const f = await fixture();
  await f.comms.answer(f.ask.inboxItem!, 'alice', 'words', 'Expired answer');
  f.db.update(messages).set({ keepUntil: '2026-11-14T18:00:00Z' }).run();
  expect(await f.service.body(alice, f.ask.inboxItem!)).toBeNull();
  expect(await f.service.answerText(alice, f.ask.inboxItem!)).toBeNull();
  expect(await f.service.search(alice, { search: 'private pump' })).toEqual([]);
  expect(f.opens()).toBe(0);
});

it('filters folders and muted items before paging and counts the whole recipient mailbox', async () => {
  const f = await fixture(), cvs = f.comms.threads.conversations;
  for (let n = 0; n < 120; n++) cvs.send({ toKind: 'person', to: 'alice', member: 'alice', agent: 'art', source: 'notice', fromKind: 'agent', words: `Notice body ${n}` });
  f.db.update(inbox).set({ at: '2026-11-15T18:00:00.000Z' }).where(eq(inbox.source, 'notice')).run();
  f.db.insert(agents).values({ id: 'mark', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const mark = cvs.send({ toKind: 'person', to: 'alice', member: 'alice', agent: 'mark', source: 'notice', fromKind: 'agent', words: 'Older question', answers: 'yes-no' });
  f.db.update(inbox).set({ at: '2026-11-14T17:00:00.000Z' }).where(eq(inbox.id, mark.id)).run();
  const answered = cvs.send({ toKind: 'person', to: 'alice', member: 'alice', agent: 'art', source: 'notice', fromKind: 'agent', words: 'Answered question', answers: 'yes-no' });
  cvs.answer(answered.id, 'alice', 'yes');
  const muted = cvs.send({ toKind: 'person', to: 'alice', member: 'alice', agent: 'art', source: 'notice', fromKind: 'agent', words: 'Muted question', answers: 'yes-no' });
  f.db.update(inbox).set({ volume: 'mute', at: '2026-11-16T18:00:00.000Z' }).where(eq(inbox.id, muted.id)).run();
  cvs.send({ toKind: 'person', to: 'bob', member: 'alice', source: 'notice', fromKind: 'agent', words: 'Other recipient' });
  expect(f.service.list(alice, { folder: 'needs', limit: 1 }).map(row => row.id)).toEqual([f.ask.inboxItem]);
  expect(f.service.list(alice, { folder: 'needs', limit: 1, offset: 1 }).map(row => row.id)).toEqual([mark.id]);
  expect(f.service.list(alice, { folder: 'answered' }).map(row => row.id)).toEqual([answered.id]);
  expect(await f.service.search(alice, { folder: 'needs', search: 'Notice body' })).toEqual([]);
  expect(await f.service.search(alice, { folder: 'fyi', search: 'Notice body', limit: 2, offset: 118 })).toHaveLength(2);
  expect(f.service.list(alice, { folder: 'alerts', limit: 1 })).toMatchObject([{ source: 'notice', answers: null, state: 'waiting' }]);
  expect(f.service.folders(alice)).toEqual({ needs: 2, alerts: 120, answered: 1, fyi: 120, all: 123, agents: [{ id: 'art', count: 122, needs: 1 }, { id: 'mark', count: 1, needs: 1 }] });
  expect(() => f.service.list(alice, { folder: 'unknown' as 'all' })).toThrow('Invalid Inbox folder');
  f.revoke(); expect(f.service.folders(alice)).toEqual({ needs: 0, alerts: 0, answered: 0, fyi: 0, all: 0, agents: [] });
});
it('projects independent private wording deadlines without decryption and keeps answers until their own deadline', async () => {
  const f = await fixture(), id = f.ask.inboxItem!;
  f.time('2026-11-14T18:01:00.000Z');
  await f.comms.answer(id, 'alice', 'words', 'Private retained answer');
  f.db.insert(household).values({ commsDays: 1 }).run();
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: inboxQueryFields(f.service) }) });
  const result = await graphql({ schema, source: `query { inboxItem(id:"${id}") { bodyKeepUntil answerKeepUntil } }`, contextValue: { viewer: alice } });
  expect(result.errors).toBeUndefined(); expect(f.opens()).toBe(0);
  expect(JSON.parse(JSON.stringify(result.data))).toEqual({ inboxItem: { bodyKeepUntil: '2026-11-15T18:00:00.000Z', answerKeepUntil: '2026-11-15T18:01:00.000Z' } });
  f.time('2026-11-15T18:00:00.000Z');
  expect(await f.service.body(alice, id)).toBeNull();
  expect(await f.service.answerText(alice, id)).toBe('Private retained answer');
  f.time('2026-11-15T18:01:00.000Z');
  expect(await f.service.answerText(alice, id)).toBeNull();
  expect(f.service.bodyKeepUntil({ kind: 'member', id: 'bob' }, id)).toBeNull();
  expect(f.service.answerKeepUntil({ kind: 'member', id: 'bob' }, id)).toBeNull();
});
it('executes the shipped Inbox selection on actual shared rows, including server folders and pagination', async () => {
  const { inboxSelection, inboxItemSelection } = await import('../../../web/src/pieces/attention/inbox-query.js');
  const f = await fixture();
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: inboxQueryFields(f.service) }) });
  const selection = inboxSelection('needs', 'private pump', 0);
  const result = await graphql({ schema, source: selection.query, variableValues: selection.variables, contextValue: { viewer: alice } });
  expect(result.errors).toBeUndefined();
  const detail = inboxItemSelection(f.ask.inboxItem!);
  const opened = await graphql({ schema, source: detail.query, variableValues: detail.variables, contextValue: { viewer: alice } });
  expect(opened.errors).toBeUndefined();
  const picked = detail.decode(opened.data as Record<string, unknown>);
  const value = selection.decode(result.data as Record<string, unknown>);
  expect(value.items.map(row => row.id)).toEqual([f.ask.inboxItem]);
  expect(picked?.body?.words).toBe('Order the private pump?');
  expect(value.folders).toEqual({ needs: 1, alerts: 0, answered: 0, fyi: 0, all: 1, agents: [{ id: 'art', count: 1 }] });
  expect(picked?.bodyKeepUntil).toBe('2026-11-28T18:00:00.000Z');
  const errors = inboxSelection('errors', '', 0);
  const errorResult = await graphql({ schema, source: errors.query, variableValues: errors.variables, contextValue: { viewer: alice } });
  expect(errorResult.errors).toBeUndefined(); expect(errors.decode(errorResult.data as Record<string, unknown>).items).toEqual([]);
});

it('projects per-agent Needs counts separately from all states without opening words', async () => {
  const f = await fixture(), cvs = f.comms.threads.conversations;
  cvs.send({ toKind: 'person', to: 'alice', member: 'alice', agent: 'art', source: 'notice', fromKind: 'agent', words: 'Second question', answers: 'words' });
  const answered = cvs.send({ toKind: 'person', to: 'alice', member: 'alice', agent: 'art', source: 'notice', fromKind: 'agent', words: 'Answered question', answers: 'yes-no' });
  cvs.answer(answered.id, 'alice', 'yes');
  cvs.send({ toKind: 'person', to: 'alice', member: 'alice', agent: 'art', source: 'notice', fromKind: 'agent', words: 'FYI' });
  // The fixture policy allows Alice-scoped rows, but recipient filtering must
  // still exclude Bob's pending item from both counters.
  cvs.send({ toKind: 'person', to: 'bob', member: 'alice', agent: 'art', source: 'notice', fromKind: 'agent', words: 'Other recipient', answers: 'words' });
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: inboxQueryFields(f.service) }) });
  const read = () => graphql({ schema, source: '{ inboxFolders { needs agents { id count needs } } }', contextValue: { viewer: alice } });
  const result = await read(); expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ inboxFolders: { needs: 2, agents: [{ id: 'art', count: 4, needs: 2 }] } });
  f.db.insert(agents).values({ id: 'mark', about: '', markBg: '#000', markFg: '#fff',
    faceShape: 'pebble', faceEyes: 'dot', removedAt: '2026-11-14T18:00:00.000Z' }).run();
  const previous = cvs.send({ toKind: 'person', to: 'alice', member: 'alice', agent: 'mark',
    source: 'notice', fromKind: 'agent', words: 'Question from Mark', answers: 'words' });
  expect((await read()).data).toEqual({ inboxFolders: { needs: 3, agents: [{ id: 'art', count: 4, needs: 2 }] } });
  expect(f.service.item(alice, previous.id)?.agent).toBe('mark');
  expect(f.opens()).toBe(0);
  f.revoke();
  expect((await read()).data).toEqual({ inboxFolders: { needs: 0, agents: [] } });
});
it('searches recorded public answers and resolution text in the same recipient mailbox',async()=>{
 const f=await fixture(),cvs=f.comms.threads.conversations;
 const answered=cvs.send({toKind:'person',to:'alice',source:'notice',sourceId:'public-question',member:'alice',fromKind:'agent',answers:'words',words:'Which fixture?'});cvs.answer(answered.id,'alice','words','Use the amber fixture');
 const resolved=cvs.send({toKind:'person',to:'alice',source:'task',sourceId:'task-question',member:'alice',fromKind:'agent',answers:'yes-no',words:'Continue?',waitsOnKind:'task',waitsOnId:'t-1'});cvs.resolve('task','t-1','Completed the turquoise fixture');
 expect((await f.service.search(alice,{search:'amber fixture',folder:'answered'})).map(row=>row.id)).toEqual([answered.id]);expect((await f.service.search(alice,{search:'turquoise fixture',folder:'answered'})).map(row=>row.id)).toEqual([resolved.id]);
 expect(await f.service.search({kind:'member',id:'bob'},{search:'amber fixture'})).toEqual([]);
 const verdict=cvs.send({toKind:'person',to:'alice',source:'notice',sourceId:'isolated-decision',member:'alice',fromKind:'agent',answers:'yes-no',words:'Proceed with this fixture?'});expect(await f.service.search(alice,{search:'yes',folder:'answered'})).toEqual([]);cvs.answer(verdict.id,'alice','yes');expect((await f.service.search(alice,{search:'yes',folder:'answered'})).map(row=>row.id)).toEqual([verdict.id]);
});
it('searches retained encrypted answer words before paging and binds only their own deadline',async()=>{
 const f=await fixture();await f.comms.answer(f.ask.inboxItem!,'alice','words','Use the violet answer fixture');f.time('2026-11-14T18:00:00.500Z');
 for(let n=0;n<55;n++){const row=f.comms.threads.conversations.send({toKind:'person',to:'alice',source:'notice',sourceId:'noise-'+n,member:'alice',fromKind:'agent',answers:'words',words:'Noise question'});f.comms.threads.conversations.answer(row.id,'alice','words','Noise answer');}
 expect(f.service.list(alice,{folder:'answered',limit:50}).map(row=>row.id)).not.toContain(f.ask.inboxItem);
 // The question expired; its separately retained answer can still be searched.
 f.db.update(messages).set({keepUntil:'2026-11-14T17:00:00Z'}).where(eq(messages.kind,'ask')).run();f.db.update(messages).set({keepUntil:'2026-11-15T18:00:00Z'}).where(eq(messages.kind,'answer')).run();
 const leases:number[]=[];expect((await f.service.search(alice,{search:'violet answer fixture',folder:'answered',limit:1},at=>leases.push(at))).map(row=>row.id)).toEqual([f.ask.inboxItem]);expect(leases).toEqual([Date.parse('2026-11-15T18:00:00Z')]);expect(f.db.select().from(inbox).where(eq(inbox.id,f.ask.inboxItem!)).get()?.answerText).toBeNull();
 f.time('2026-11-15T18:00:00Z');expect(await f.service.search(alice,{search:'violet answer fixture'})).toEqual([]);
});
it.each(['revoke','expiry','cipher','link'] as const)('rechecks earlier private answer search matches after later decrypt yields: %s',async change=>{
 const f=await fixture();await f.comms.answer(f.ask.inboxItem!,'alice','words','Earlier needle answer');
 const other=await f.comms.ask(f.thread.id,'art','later-ask',{words:'Other question',answers:'yes-no'});await f.comms.answer(other.inboxItem!,'alice','words','Other answer');
 f.db.update(inbox).set({at:'2026-11-14T18:01:00Z'}).where(eq(inbox.id,f.ask.inboxItem!)).run();const answer=f.db.select().from(messages).all().find(row=>row.kind==='answer')!;let opens=0;
 f.onOpen(()=>{if(++opens!==3)return;if(change==='revoke')f.revoke();if(change==='expiry')f.time('2026-11-29T18:00:00Z');if(change==='cipher')f.db.update(messages).set({words:Buffer.from('Replaced answer')}).where(eq(messages.seq,answer.seq)).run();if(change==='link')f.db.update(inbox).set({sourceId:'different-question'}).where(eq(inbox.sourceId,f.ask.inboxItem!)).run();});
 expect(await f.service.search(alice,{search:'needle',folder:'answered'})).toEqual([]);expect(opens).toBeGreaterThanOrEqual(3);
});
it('keeps one answer match when matching question words expire during a later decrypt, using the surviving answer deadline',async()=>{
 const f=await fixture();await f.comms.answer(f.ask.inboxItem!,'alice','words','Private answer remains');const originalAnswer=f.db.select().from(messages).all().find(row=>row.kind==='answer')!;
 const other=await f.comms.ask(f.thread.id,'art','other-ask',{words:'Different question',answers:'yes-no'});await f.comms.answer(other.inboxItem!,'alice','words','Different response');
 f.db.update(inbox).set({at:'2026-11-14T18:01:00Z'}).where(eq(inbox.id,f.ask.inboxItem!)).run();f.db.update(messages).set({keepUntil:'2026-11-14T18:00:01Z'}).where(eq(messages.seq,f.ask.seq)).run();f.db.update(messages).set({keepUntil:'2026-11-14T18:00:02Z'}).where(eq(messages.seq,originalAnswer.seq)).run();
 const firstLeases:number[]=[];expect((await f.service.search(alice,{search:'private',folder:'answered',limit:1},at=>firstLeases.push(at))).map(row=>row.id)).toEqual([f.ask.inboxItem]);expect(firstLeases).toEqual([Date.parse('2026-11-14T18:00:02Z')]);
 let opens=0;f.onOpen(()=>{if(++opens===3)f.time('2026-11-14T18:00:01Z');});const leases:number[]=[];
 expect((await f.service.search(alice,{search:'private',folder:'answered',limit:1},at=>leases.push(at))).map(row=>row.id)).toEqual([f.ask.inboxItem]);expect(leases).toEqual([Date.parse('2026-11-14T18:00:02Z')]);expect(opens).toBeGreaterThanOrEqual(3);
});

it.each(['allowed','scope','cipher','expiry','policy'] as const)('opens retained handoff words through the existing member read policy: %s',async mode=>{
 const f=await fixture(),cvs=f.comms.threads.conversations,cv=cvs.open({agent:'art',venue:'handoff',place:'parent',label:'Compare',member:'alice'});
 const encoded=await sealHandoff(f.key,'Retained handoff words','2026-11-14T18:00:00.000Z',14),replacement=await sealHandoff(f.key,'Other words','2026-11-14T18:00:00.000Z',14);
 const item=cvs.send({conversation:cv.id,toKind:'agent',to:'art',source:'handoff',fromKind:'agent',words:encoded});
 f.onOpen(()=>{if(mode==='scope')f.revoke();if(mode==='cipher')f.db.update(inbox).set({words:replacement}).where(eq(inbox.id,item.id)).run();if(mode==='expiry')f.time('2026-11-28T18:00:00.000Z');if(mode==='policy')f.db.insert(household).values({commsDays:1}).run();});
 let until:number|undefined;expect(await f.service.body(alice,item.id,deadline=>{until=deadline;})).toEqual(mode==='allowed'?{words:'Retained handoff words'}:null);
 if(mode==='allowed'){expect(until).toBe(Date.parse('2026-11-28T18:00:00.000Z'));expect(await f.service.body({kind:'member',id:'bob'},item.id)).toBeNull();}
});

it('matches handoff metadata without decrypting wording even on a noncanonical personal row',async()=>{
 const f=await fixture(),encoded=await sealHandoff(f.key,'HANDOFF SEARCH WORDS','2026-11-14T18:00:00.000Z',14);
 // Shared readers also fail closed if an internal writer misaddresses agent mail.
 f.db.insert(inbox).values({id:'in-handoff-search',state:'waiting',volume:'full',toKind:'person',to:'alice',source:'handoff',sourceId:'parent-search-witness',fromKind:'agent',fromId:'art',words:encoded,member:'alice',agent:'art',at:'2026-11-14T18:00:00.000Z',changedAt:'2026-11-14T18:00:00.000Z'}).run();
 const opens=f.opens();expect(await f.service.search(alice,{source:'handoff',search:'HANDOFF SEARCH WORDS'})).toEqual([]);expect(f.opens()).toBe(opens);
 expect((await f.service.search(alice,{source:'handoff',search:'parent-search-witness'})).map(row=>row.id)).toEqual(['in-handoff-search']);expect(f.opens()).toBe(opens);
});


it('retries a private Inbox read when an overlapping read-marker write invalidates its batch',async()=>{
  const f=await fixture(),live=new DataLive();
  let changed=false;
  f.onOpen(()=>{if(!changed){changed=true;f.db.insert(inboxReads).values({item:f.ask.inboxItem!,member:'alice',readAt:'2026-11-14T18:00:00.000Z'}).run();live.changed();}});
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:inboxQueryFields(f.service)})});
  const stream=live.watch({schema,query:'{inboxItems{id read body{words}}}',contextValue:{viewer:alice},valid:()=>true});
  try {
    expect((await stream.next()).value).toMatchObject({revision:1,patches:[{path:[],value:{inboxItems:[{id:f.ask.inboxItem,read:true,body:{words:'Order the private pump?'}}]}}]});
    expect(f.opens()).toBe(2);
  } finally {await stream.return?.();live.close();}
});
it('gives a bridge direct message to the agent\'s owners and not to the agent\'s own token', async () => {
  const f = await fixture(), at = '2026-11-14T18:00:00.000Z', cvs = f.comms.threads.conversations;
  // The Inbox rule as production states it: an item in a conversation is read with that conversation.
  const service = new InboxQueries(f.db, f.key, (viewer, row) => talkVisibility(viewer).inbox(row), () => at);
  f.db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run(); f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const owner = { kind: 'member' as const, id: 'owner' };
  f.db.insert(secrets).values({ name: 'TOKEN', description: '', changedAt: at, changedBy: 'alice' }).run();
  f.db.insert(bridgeConnections).values({ id: 'c', platform: 'slack', agent: 'art', workspace: 'w', botUser: 'bot', tokenSecret: 'TOKEN', enabled: true, state: 'connected', stateAt: at }).run();
  const mail = (id: string, isDm: boolean) => {
    const cv = cvs.open({ agent: 'art', venue: 'slack', place: id, label: id });
    f.db.update(conversations).set({ direct: isDm }).where(eq(conversations.id, cv.id)).run();
    f.db.insert(bridgeIncoming).values({ id, connection: 'c', channel: id, isDm, user: 'stranger', text: id, postedAt: at, receivedAt: at, state: 'delivered', conversation: cv.id }).run();
    return cvs.send({ toKind: 'agent', to: 'art', conversation: cv.id, source: 'slack', sourceId: id, fromKind: 'unknown', words: `${id} words`, refs: [id] });
  };
  const dm = mail('dm', true), room = mail('room', false), art = { kind: 'agent' as const, id: 'art' };
  expect(await service.body(art, room.id)).toMatchObject({ words: 'room words' });
  // The agent's token reads its rooms. A direct message is not on its list at all: a body gets one as its mail.
  expect(service.item(art, dm.id)).toBeNull();
  expect(await service.body(art, dm.id)).toBeNull();
  expect(await service.body(alice, dm.id)).toMatchObject({ words: 'dm words' });
  // The owner role alone does not own the agent.
  expect(service.item(owner, dm.id)).toBeNull(); expect(service.item(owner, room.id)?.id).toBe(room.id);
});

it('reports receipt and sent reply only for the latest visible bridge message from this viewer',async()=>{
 const f=await fixture(),cv=f.thread.conversation;
 f.db.insert(secrets).values({name:'TOKEN',description:'',changedAt:f.comms.now(),changedBy:'alice'}).run();
 f.db.insert(bridgeConnections).values({id:'discord',platform:'discord',workspace:'ws',botUser:'bot',agent:'art',tokenSecret:'TOKEN',enabled:true,state:'connected',stateAt:f.comms.now()}).run();
 const send=(id:string,fromId:string)=>{
  const at=f.comms.now();
  f.db.insert(bridgeIncoming).values({id,connection:'discord',channel:'room',isDm:false,user:fromId,text:'Fictional words',postedAt:at,receivedAt:at,state:'delivered',conversation:cv}).run();
  return f.comms.threads.conversations.send({conversation:cv,toKind:'agent',to:'art',source:'discord',sourceId:id,fromKind:'person',fromId,words:'Fictional words',refs:[id]});
 };
 const first=send('one','alice');
 const receipt=()=>f.service.latestBridgeReceipt(alice,cv);
 expect(receipt()).toMatchObject({id:first.id,acceptedAt:null,replied:false});
 const acceptedAt='2026-11-14T18:03:00.000Z';
 f.db.update(inbox).set({firstAcceptedAt:acceptedAt}).where(eq(inbox.id,first.id)).run();
 f.db.insert(bridgeSends).values({id:'reply',incoming:'one',connection:'discord',channel:'room',conversation:cv,text:'Fictional answer',state:'pending',createdAt:acceptedAt}).run();
 expect(receipt()).toMatchObject({acceptedAt,replied:false});
 f.db.update(bridgeSends).set({state:'sent'}).where(eq(bridgeSends.id,'reply')).run();
 expect(receipt()).toMatchObject({acceptedAt,replied:true});
 send('two','bob');
 expect(receipt()?.id).toBe(first.id);
 const latest=send('three','alice');
 expect(receipt()).toMatchObject({id:latest.id,acceptedAt:null,replied:false});
 f.revoke();expect(receipt()).toBeNull();
});
