import Database from 'better-sqlite3';
import { eq, sql, type SQL } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { withQueryFields } from '../data/query-fields.js';
import { conversationWorkFields } from '../../shared-conversation-work.js';
import { createDataSchema } from '../data/database.js';
import { agents, conversations, household, memberAgents, members, messages, threads } from '../data/schema.js';
import { CommsMessages } from './messages.js';
import { CommsQueries, commsQueryFields } from './comms-query.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
const alice = { kind: 'member' as const, id: 'alice' }, owner = { kind: 'member' as const, id: 'owner' };
async function fixture() {
  const statements: string[] = [], client = new Database(':memory:', { verbose: statement => statements.push(statement) }); clients.push(client);
  let now = '2026-11-14T18:00:00.000Z', allowed = true, opens = 0, onOpen = () => {};
  const db = createDataSchema(client, () => now);
  for (const [id, role] of [['alice', 'member'], ['bob', 'member'], ['owner', 'owner']] as const) db.insert(members).values({ id, role, joinedAt: now }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const key = { seal: async (s: string) => Buffer.from(s), hash: (s: string) => s, open: async (b: Uint8Array) => { opens++; onOpen(); return Buffer.from(b).toString(); } };
  const comms = new CommsMessages(db, key, () => now);
  const service = new CommsQueries(db, key, (viewer, f) => allowed && viewer.kind === 'member'
    ? sql`(${f.member} = ${viewer.id} or exists(select 1 from ${members} where ${members.id} = ${viewer.id} and ${members.role} = 'owner'))` : sql`false`, () => now);
  const thread = comms.threads.open({ id: 'th:alice', member: 'alice', agent: 'art', title: 'Pump' });
  for (const [kind, sender, words] of [['message', 'alice', 'Find t-1'], ['reply', 'art', 'Answer t-2'], ['card', 'art', 'Search done']] as const) await comms.send({ thread: thread.id, kind, sender, words });
  return { db, service, comms, thread, key, statements, opens: () => opens, onOpen: (fn: () => void) => { onOpen = fn; }, revoke: () => { allowed = false; }, time: (at: string) => { now = at; } };
}
it('filters/paginates real thread rows and separately authorizes direct owner reads', async () => {
  const f = await fixture();
  const pinned = f.comms.threads.open({ id: 'th:pinned', member: 'alice', agent: 'art', title: 'Pinned' }); f.comms.threads.pin(pinned.id, true);
  const archived = f.comms.threads.open({ member: 'alice', agent: 'art', title: 'Archived' }); f.comms.threads.archive(archived.id, true);
  const mark = f.comms.threads.open({ member: 'alice', agent: 'mark', title: 'Mark' });
  const other = f.comms.threads.open({ member: 'bob', agent: 'art', title: 'Bob' });
  expect(f.service.list(alice, { agent: 'art' }).map(row => row.id)).toEqual([pinned.id, f.thread.id]);
  expect(f.service.list(alice, { agent: 'art', limit: 1, offset: 1 }).map(row => row.id)).toEqual([f.thread.id]);
  expect(f.service.list(alice, { agent: 'mark' }).map(row => row.id)).toEqual([mark.id]);
  expect(f.service.list(alice, { archived: true }).map(row => row.id)).toEqual([archived.id]);
  expect(f.service.list(alice, { member: 'bob' })).toEqual([]);
  expect(f.service.list(owner, { member: 'bob' }).map(row => row.id)).toEqual([other.id]);
  const own = f.comms.threads.open({ member: 'owner', agent: 'art', title: 'Owner private' });
  expect(f.service.list(owner).map(row => row.id)).toEqual([own.id]);
  expect(f.service.thread(alice, '')).toBeNull(); expect(f.service.thread(alice, other.id)).toBeNull(); expect(f.service.thread(owner, other.id)?.id).toBe(other.id);
});
it('loads latest message metadata without ciphertext, pages older sequences and decrypts only selected words', async () => {
  const f = await fixture();
  f.statements.splice(0);
  const recent = f.service.messages(alice, f.thread.id, undefined, 2);
  expect(recent.map(row => row.seq)).toEqual([2, 3]); expect(recent[0]).not.toHaveProperty('words');
  expect(f.statements.join('\n')).not.toContain('"words"');
  expect(f.service.messages(alice, f.thread.id, 3, 2).map(row => row.seq)).toEqual([1, 2]);
  expect(f.service.refs(alice, f.thread.id, 1)).toEqual([{ ref: 't-2', messageSeq: 2 }]);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: commsQueryFields(f.service) }) });
  const contextValue = { viewer: alice };
  const meta = await graphql({ schema, source: '{ commsMessages(thread:"th:alice",limit:1) { seq kind } }', contextValue });
  expect(meta.errors).toBeUndefined(); expect(f.opens()).toBe(0);
  const result = await graphql({ schema, source: '{ commsMessages(thread:"th:alice",limit:1) { words } }', contextValue });
  expect(result.errors).toBeUndefined(); expect(JSON.parse(JSON.stringify(result.data))).toEqual({ commsMessages: [{ words: 'Search done' }] });
  expect(f.opens()).toBe(1);
  f.revoke(); expect(f.service.messages(alice, f.thread.id)).toEqual([]); expect(f.service.refs(alice, f.thread.id)).toEqual([]); expect(f.service.thread(alice, f.thread.id)).toBeNull();
});
it('withholds words across decryption-time changes to policy, scope, ciphertext, identity, retention or existence', async () => {
  for (const path of ['internal', 'graphql'] as const) for (const change of ['policy', 'role', 'scope', 'conversation', 'ciphertext', 'sender', 'kind', 'timestamp', 'deadline', 'household', 'expiry', 'delete'] as const) {
    const f = await fixture(), row = f.service.messages(owner, f.thread.id, undefined, 1)[0];
    f.onOpen(() => {
      if (change === 'role') f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'owner')).run();
      if (change === 'policy') f.revoke();
      if (change === 'conversation') {
        const other = f.comms.threads.conversations.open({ agent: 'art', member: 'alice', venue: 'loom', place: 'th:replacement', label: 'Replacement' });
        f.db.update(threads).set({ conversation: other.id }).where(eq(threads.id, f.thread.id)).run();
      }
      if (change === 'scope') f.db.update(conversations).set({ member: 'bob' }).where(eq(conversations.id, f.thread.conversation)).run();
      if (change === 'ciphertext') f.db.update(messages).set({ words: Buffer.from('Changed') }).run();
      if (change === 'sender') f.db.update(messages).set({ sender: 'bob' }).run();
      if (change === 'kind') f.db.update(messages).set({ kind: 'reply' }).run();
      if (change === 'timestamp') f.db.update(messages).set({ at: '2026-11-14T18:01:00.000Z' }).run();
      if (change === 'deadline') f.db.update(messages).set({ keepUntil: '2026-11-16T18:00:00.000Z' }).run();
      if (change === 'household') f.db.insert(household).values({ commsDays: 1 }).run();
      if (change === 'expiry') f.time('2026-11-29T18:00:00.000Z');
      if (change === 'delete') f.comms.delete(f.thread.id);
    });
    if (path === 'internal') expect(await f.service.words(owner, row), change).toBeNull();
    else {
      const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: commsQueryFields(f.service) }) });
      const result = await graphql({ schema, source: '{ commsMessages(thread:"th:alice",limit:1) { words wordsKeepUntil } }', contextValue: { viewer: owner } });
      expect(JSON.stringify(result.data), change).not.toContain('Search done');
      if (change === 'expiry') expect(result.data).toMatchObject({ commsMessages: [{ words: null }] });
      else expect(result.errors, change).toBeDefined();
    }
  }
});
it('enforces stored and household deadlines independently, before and after decryption', async () => {
  for (const boundary of ['stored', 'household'] as const) for (const phase of ['before', 'after'] as const) {
    const f = await fixture();
    if (boundary === 'stored') f.db.update(messages).set({ keepUntil: '2026-11-14T18:01:00.000Z' }).run();
    else f.db.insert(household).values({ commsDays: 1 }).run();
    const row = f.service.messages(alice, f.thread.id, undefined, 1)[0];
    const expired = boundary === 'stored' ? '2026-11-14T18:01:00.000Z' : '2026-11-15T18:00:00.000Z';
    if (phase === 'before') f.time(expired); else f.onOpen(() => f.time(expired));
    expect(await f.service.words(alice, row)).toBeNull(); expect(f.opens()).toBe(phase === 'before' ? 0 : 1);
  }
});
it('rechecks the reader and expiry of archived step details independently of the summary',async()=>{
  for(const change of ['expiry','revoked'] as const){
    const f=await fixture();
    f.db.update(messages).set({tool:'Read',archivedStepMeta:JSON.stringify({tool:'Read',state:'done'}),
      archivedStepWords:await f.key.seal(JSON.stringify({detail:'private result'}))}).where(eq(messages.seq,3)).run();
    const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:commsQueryFields(f.service)})});
    const read=(viewer:typeof alice)=>graphql({schema,source:'{ commsMessages(thread:"th:alice",limit:1){stepDetails{detail}} }',contextValue:{viewer}});
    expect((await read(alice)).data).toMatchObject({commsMessages:[{stepDetails:{detail:'private result'}}]});
    expect(JSON.stringify((await read({kind:'member',id:'bob'})).data)).not.toContain('private result');
    f.onOpen(()=>change==='expiry'?f.time('2026-12-01T00:00:00.000Z'):f.revoke());
    const after=await read(alice);
    expect(JSON.stringify(after.data)).not.toContain('private result');
    if(change==='expiry')expect(after.data).toMatchObject({commsMessages:[{stepDetails:null}]});
    else expect(after.errors).toBeDefined();
  }
});
it('rejects invalid bounds and absent SQL rather than widening reads', async () => {
  const f = await fixture();
  expect(() => f.service.list(alice, { limit: 101 })).toThrow(); expect(() => f.service.list(alice, { offset: -1 })).toThrow();
  expect(() => f.service.messages(alice, f.thread.id, 0)).toThrow(); expect(() => f.service.messages(alice, f.thread.id, undefined, 101)).toThrow();
  expect(() => f.service.refs(alice, f.thread.id, 201)).toThrow();
  const broken = new CommsQueries(f.db, f.key, () => undefined as unknown as SQL);
  expect(() => broken.list(alice)).toThrow('SQL conversation visibility required');
});

it('never caches successful plaintext across later reads with changed content, authority or retention', async () => {
  for (const change of ['ciphertext', 'policy', 'expiry'] as const) {
    const f = await fixture(), row = f.service.messages(owner, f.thread.id, undefined, 1)[0];
    expect(await f.service.words(owner, row)).toBe('Search done');
    if (change === 'ciphertext') f.db.update(messages).set({ words: Buffer.from('New current words') }).where(eq(messages.seq, row.seq)).run();
    if (change === 'policy') f.revoke();
    if (change === 'expiry') f.time('2026-11-29T18:00:00.000Z');
    expect(await f.service.words(owner, row)).toBe(change === 'ciphertext' ? 'New current words' : null);
  }
});
it('returns the existing private question envelope intact and performs no writes during queries', async () => {
  const f = await fixture();
  const question = { words: 'Order the private pump?', answers: 'yes-no' as const, ifYes: 'Order it', ifNo: 'Skip it' };
  await f.comms.ask(f.thread.id, 'art', 'question', question);
  f.statements.splice(0);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: commsQueryFields(f.service) }) });
  const result = await graphql({ schema, source: '{ commsThreads { id } commsThread(id:"th:alice") { title } commsMessages(thread:"th:alice",limit:1) { kind words } commsRefs(thread:"th:alice") { ref } }', contextValue: { viewer: alice } });
  expect(result.errors).toBeUndefined();
  expect(JSON.parse(JSON.stringify(result.data)).commsMessages).toEqual([{ kind: 'ask', words: JSON.stringify(question) }]);
  expect(f.statements.filter(statement => /^\s*(insert|update|delete|replace|create|alter|drop)\b/i.test(statement))).toEqual([]);
  expect(f.service.thread(alice, f.thread.id)?.readSeq).toBe(0);
});


it('projects Home from the current member and owned agents, counting reply threads across the whole mailbox', async () => {
  const f = await fixture();
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const archived = f.comms.threads.open({ member: 'alice', agent: 'art', title: 'Archived' });
  await f.comms.send({ thread: archived.id, sender: 'art', kind: 'reply', words: 'Archived reply' });
  f.comms.threads.archive(archived.id, true);
  const bob = f.comms.threads.open({ member: 'bob', agent: 'art', title: 'Other private' });
  await f.comms.send({ thread: bob.id, sender: 'art', kind: 'reply', words: 'Other reply' });
  const notOwned = f.comms.threads.open({ member: 'alice', agent: 'mark', title: 'Not owned now' });
  await f.comms.send({ thread: notOwned.id, sender: 'mark', kind: 'reply', words: 'Not owned reply' });
  const latest = f.comms.threads.open({ id: 'th:latest', member: 'alice', agent: 'art', title: 'Latest' });
  await f.comms.send({ thread: latest.id, sender: 'art', kind: 'card', words: 'Progress is not unread' });
  await f.comms.send({ thread: latest.id, sender: 'alice', kind: 'message', words: 'Nor is my own message' });
  f.db.update(threads).set({ lastAt: '2026-11-14T18:02:00.000Z' }).where(eq(threads.id, latest.id)).run();
  // More than a Comms page: Home counts unread threads, rather than replies or
  // just the first 100 rows. Repeated replies still count once.
  for (let n = 0; n < 101; n++) {
    const thread = f.comms.threads.open({ id: `th:bulk${n}`, member: 'alice', agent: 'art', title: 'Older' });
    await f.comms.send({ thread: thread.id, sender: 'art', kind: 'reply', words: 'Unread' });
    await f.comms.send({ thread: thread.id, sender: 'art', kind: 'reply', words: 'Still one unread thread' });
  }
  f.db.update(threads).set({ lastAt: '2026-11-14T18:01:00.000Z' }).where(eq(threads.id, f.thread.id)).run();
  f.statements.splice(0);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: commsQueryFields(f.service) }) });
  const result = await graphql({ schema, source: '{ homeComms { member agents summaries { agent unread last { thread title at } first { thread } } } }', contextValue: { viewer: alice } });
  expect(result.errors).toBeUndefined();
  expect(JSON.parse(JSON.stringify(result.data))).toEqual({ homeComms: { member: 'alice', agents: ['art'], summaries: [
    { agent: 'art', unread: 102, last: { thread: latest.id, title: 'Latest', at: '2026-11-14T18:02:00.000Z' }, first: { thread: f.thread.id } },
  ] } });
  expect(f.opens()).toBe(0);
  expect(f.statements.join('\n')).not.toContain('"words"');
  expect(f.statements.filter(statement => /^\s*(insert|update|delete|replace)\b/i.test(statement))).toEqual([]);
  f.comms.threads.read(f.thread.id, 3);
  expect(f.service.home(alice)?.summaries[0].unread).toBe(101);
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'mark' }).run();
  expect(f.service.home(alice)?.agents).toEqual(['art', 'mark']);
  f.db.delete(memberAgents).run();
  expect(f.service.home(alice)).toEqual({ member: 'alice', agents: [], summaries: [] });
});
it('keeps Home personal for household owners and refuses missing/nonmember viewers or revoked read policy', async () => {
  const f = await fixture();
  f.db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  expect(f.service.home(owner)).toEqual({ member: 'owner', agents: ['art'], summaries: [{ agent: 'art', unread: 0, last: null, first: null }] });
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  f.revoke();
  expect(f.service.home(alice)?.summaries).toEqual([{ agent: 'art', unread: 0, last: null, first: null }]);
  for (const viewer of [{ kind: 'member', id: 'missing' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'service' }] as const) expect(f.service.home(viewer)).toBeNull();
});

it('orders Home by instant across timestamp precision and ignores replies from another sender', async () => {
  const f = await fixture();
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const newer = f.comms.threads.open({ id: 'th:newer', member: 'alice', agent: 'art', title: 'Newer' });
  const wrongSender = f.comms.threads.open({ id: 'th:wrong', member: 'alice', agent: 'art', title: 'Wrong sender' });
  await f.comms.send({ thread: newer.id, sender: 'art', kind: 'reply', words: 'Newer reply' });
  await f.comms.send({ thread: wrongSender.id, sender: 'art', kind: 'reply', words: 'Changed sender' });
  f.db.update(messages).set({ sender: 'mark' }).where(eq(messages.thread, wrongSender.id)).run();
  f.db.update(threads).set({ lastAt: '2026-11-14T18:00:00Z' }).where(eq(threads.id, f.thread.id)).run();
  f.db.update(threads).set({ lastAt: '2026-11-14T18:00:00.500Z' }).where(eq(threads.id, newer.id)).run();
  f.db.update(threads).set({ lastAt: '2026-11-14T17:59:00Z' }).where(eq(threads.id, wrongSender.id)).run();
  expect(f.service.home(alice)?.summaries[0]).toMatchObject({ unread: 2, last: { thread: newer.id }, first: { thread: newer.id } });
});

it('orders and pages Comms threads by time rather than ISO timestamp precision', async () => {
  const f = await fixture();
  const newer = f.comms.threads.open({ member: 'alice', agent: 'art', title: 'Newer' });
  f.db.update(threads).set({ lastAt: '2026-11-14T18:00:00Z' }).where(eq(threads.id, f.thread.id)).run();
  f.db.update(threads).set({ lastAt: '2026-11-14T18:00:00.500Z' }).where(eq(threads.id, newer.id)).run();
  expect(f.service.list(alice, { limit: 1 }).map(row => row.id)).toEqual([newer.id]);
  expect(f.service.list(alice, { limit: 1, offset: 1 }).map(row => row.id)).toEqual([f.thread.id]);
});
it('never decrypts thread words at an equal whole-second stored deadline', async () => {
  const f = await fixture();
  f.db.update(messages).set({ keepUntil: '2026-11-14T18:00:00Z' }).run();
  const row = f.service.messages(alice, f.thread.id, undefined, 1)[0];
  expect(await f.service.words(alice, row)).toBeNull(); expect(f.opens()).toBe(0);
});

it('filters matching thread titles before paging and counts the whole personal mailbox', async () => {
  const f = await fixture();
  for (let n = 0; n < 110; n++) f.comms.threads.open({ member: 'alice', agent: 'art', title: `Other ${n}` });
  const matching = f.comms.threads.open({ member: 'alice', agent: 'mark', title: 'Needle title' });
  const archived = f.comms.threads.open({ member: 'alice', agent: 'art', title: 'Needle archived' }); f.comms.threads.archive(archived.id, true);
  f.comms.threads.open({ member: 'bob', agent: 'art', title: 'Needle Bob' });
  expect(f.service.list(alice, { search: 'NEEDLE', limit: 1 }).map(row => row.id)).toEqual([matching.id]);
  expect(f.service.list(alice, { search: 'Needle', archived: true }).map(row => row.id)).toEqual([archived.id]);
  expect(f.service.folders(alice)).toEqual({ threads: 112, archived: 1 });
  expect(f.service.folders(owner)).toEqual({ threads: 0, archived: 0 });
  f.revoke(); expect(f.service.folders(alice)).toEqual({ threads: 0, archived: 0 });
});
it('projects a current effective word deadline without decrypting and fails closed on changed metadata or policy', async () => {
  const f = await fixture(), row = f.service.messages(alice, f.thread.id)[0];
  const stored = f.service.wordsKeepUntil(alice, row);
  expect(stored).toBe('2026-11-28T18:00:00.000Z');
  f.db.insert(household).values({ commsDays: 1 }).run();
  expect(f.service.wordsKeepUntil(alice, row)).toBe('2026-11-15T18:00:00.000Z');
  f.db.update(messages).set({ keepUntil: '2026-11-15T17:59:59Z' }).where(eq(messages.seq, row.seq)).run();
  expect(f.service.wordsKeepUntil(alice, row)).toBeNull();
  const latest = f.service.messages(alice, f.thread.id)[0];
  expect(f.service.wordsKeepUntil(alice, latest)).toBe('2026-11-15T17:59:59.000Z');
  expect(f.opens()).toBe(0);
  f.revoke(); expect(f.service.wordsKeepUntil(alice, latest)).toBeNull();
});
it('executes the shipped Work queries against the generated current-policy task projection', async () => {
  const f = await fixture();
  const { tasks } = await import('../data/schema.js');
  const { dataQueries } = await import('../data/queries.js');
  const { sourceQuery, taskQuery } = await import('../../../web/src/pieces/comms/work-query.js');
  for (const [id, owner, sourceId] of [['t-10','alice',f.thread.conversation], ['t-11','bob',f.thread.conversation], ['t-12','alice','elsewhere']]) {
    f.db.insert(tasks).values({ id, title: id, ownerKind: 'member', owner, createdByKind: 'member', createdBy: owner, createdAt: '2026-11-14T18:00:00Z', changedAt: '2026-11-14T18:00:00Z', sourceKind: 'conversation', sourceId }).run();
  }
  const schema = withQueryFields(dataQueries(f.db.$client, { tables: ['tasks'], visibility: { tasks: fields => eq(fields.owner, 'alice') } }), conversationWorkFields(f.db));
  const source = await graphql({ schema, source: sourceQuery, variableValues: { conversation: f.thread.conversation, offset: 0 }, contextValue: {viewer:alice} });
  expect(source.errors).toBeUndefined(); expect(JSON.parse(JSON.stringify(source.data))).toEqual({ tasks: [{ id:'t-10', title:'t-10', status:'open', isShelved:false }], conversationMadeChanges:[] });
  const mentioned = await graphql({ schema, source: taskQuery, variableValues: { id: 't-11' } });
  expect(mentioned.errors).toBeUndefined(); expect(JSON.parse(JSON.stringify(mentioned.data))).toEqual({ tasks: [] });
});
it('projects Home from the current member and owned agents, counting reply threads across the whole mailbox', async () => {
  const f = await fixture();
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const archived = f.comms.threads.open({ member: 'alice', agent: 'art', title: 'Archived' });
  await f.comms.send({ thread: archived.id, sender: 'art', kind: 'reply', words: 'Archived reply' });
  f.comms.threads.archive(archived.id, true);
  const bob = f.comms.threads.open({ member: 'bob', agent: 'art', title: 'Other private' });
  await f.comms.send({ thread: bob.id, sender: 'art', kind: 'reply', words: 'Other reply' });
  const notOwned = f.comms.threads.open({ member: 'alice', agent: 'mark', title: 'Not owned now' });
  await f.comms.send({ thread: notOwned.id, sender: 'mark', kind: 'reply', words: 'Not owned reply' });
  const latest = f.comms.threads.open({ id: 'th:latest', member: 'alice', agent: 'art', title: 'Latest' });
  await f.comms.send({ thread: latest.id, sender: 'art', kind: 'card', words: 'Progress is not unread' });
  await f.comms.send({ thread: latest.id, sender: 'alice', kind: 'message', words: 'Nor is my own message' });
  f.db.update(threads).set({ lastAt: '2026-11-14T18:02:00.000Z' }).where(eq(threads.id, latest.id)).run();
  // More than a Comms page: Home counts unread threads, rather than replies or
  // just the first 100 rows. Repeated replies still count once.
  for (let n = 0; n < 101; n++) {
    const thread = f.comms.threads.open({ id: `th:bulk${n}`, member: 'alice', agent: 'art', title: 'Older' });
    await f.comms.send({ thread: thread.id, sender: 'art', kind: 'reply', words: 'Unread' });
    await f.comms.send({ thread: thread.id, sender: 'art', kind: 'reply', words: 'Still one unread thread' });
  }
  f.db.update(threads).set({ lastAt: '2026-11-14T18:01:00.000Z' }).where(eq(threads.id, f.thread.id)).run();
  f.statements.splice(0);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: commsQueryFields(f.service) }) });
  const result = await graphql({ schema, source: '{ homeComms { member agents summaries { agent unread last { thread title at } first { thread } } } }', contextValue: { viewer: alice } });
  expect(result.errors).toBeUndefined();
  expect(JSON.parse(JSON.stringify(result.data))).toEqual({ homeComms: { member: 'alice', agents: ['art'], summaries: [
    { agent: 'art', unread: 102, last: { thread: latest.id, title: 'Latest', at: '2026-11-14T18:02:00.000Z' }, first: { thread: f.thread.id } },
  ] } });
  expect(f.opens()).toBe(0);
  expect(f.statements.join('\n')).not.toContain('"words"');
  expect(f.statements.filter(statement => /^\s*(insert|update|delete|replace)\b/i.test(statement))).toEqual([]);
  f.comms.threads.read(f.thread.id, 3);
  expect(f.service.home(alice)?.summaries[0].unread).toBe(101);
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'mark' }).run();
  expect(f.service.home(alice)?.agents).toEqual(['art', 'mark']);
  f.db.delete(memberAgents).run();
  expect(f.service.home(alice)).toEqual({ member: 'alice', agents: [], summaries: [] });
});
it('keeps Home personal for household owners and refuses missing/nonmember viewers or revoked read policy', async () => {
  const f = await fixture();
  f.db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  expect(f.service.home(owner)).toEqual({ member: 'owner', agents: ['art'], summaries: [{ agent: 'art', unread: 0, last: null, first: null }] });
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  f.revoke();
  expect(f.service.home(alice)?.summaries).toEqual([{ agent: 'art', unread: 0, last: null, first: null }]);
  for (const viewer of [{ kind: 'member', id: 'missing' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'service' }] as const) expect(f.service.home(viewer)).toBeNull();
});

it('orders Home by instant across timestamp precision and ignores replies from another sender', async () => {
  const f = await fixture();
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const newer = f.comms.threads.open({ id: 'th:newer', member: 'alice', agent: 'art', title: 'Newer' });
  const wrongSender = f.comms.threads.open({ id: 'th:wrong', member: 'alice', agent: 'art', title: 'Wrong sender' });
  await f.comms.send({ thread: newer.id, sender: 'art', kind: 'reply', words: 'Newer reply' });
  await f.comms.send({ thread: wrongSender.id, sender: 'art', kind: 'reply', words: 'Changed sender' });
  f.db.update(messages).set({ sender: 'mark' }).where(eq(messages.thread, wrongSender.id)).run();
  f.db.update(threads).set({ lastAt: '2026-11-14T18:00:00Z' }).where(eq(threads.id, f.thread.id)).run();
  f.db.update(threads).set({ lastAt: '2026-11-14T18:00:00.500Z' }).where(eq(threads.id, newer.id)).run();
  f.db.update(threads).set({ lastAt: '2026-11-14T17:59:00Z' }).where(eq(threads.id, wrongSender.id)).run();
  expect(f.service.home(alice)?.summaries[0]).toMatchObject({ unread: 2, last: { thread: newer.id }, first: { thread: newer.id } });
});

it('executes the actual shipped Comms selection over the shared read group', async () => {
  const f = await fixture(); f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const { commsSelection, commsThreadSelection } = await import('../../../web/src/pieces/comms/shared-query.js');
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: commsQueryFields(f.service) }) });
  const selection = commsSelection(false, '', 0);
  const result = await graphql({ schema, source: selection.query, variableValues: selection.variables, contextValue: { viewer: alice } });
  expect(result.errors).toBeUndefined();
  const detail = commsThreadSelection(f.thread.id);
  const opened = await graphql({ schema, source: detail.query, variableValues: detail.variables, contextValue: { viewer: alice } });
  expect(opened.errors).toBeUndefined();
  const picked = detail.decode(opened.data as Record<string, unknown>);
  const value = selection.decode(result.data as Record<string, unknown>);
  expect(value.home).toEqual({ member: 'alice', agents: ['art'] }); expect(picked.thread?.id).toBe(f.thread.id);
  expect(picked.messages.map(row => row.words)).toEqual(['Find t-1','Answer t-2','Search done']);
  expect(picked.messages[0].wordsKeepUntil).toBe('2026-11-28T18:00:00.000Z');
  expect(value.folders).toEqual({ threads: 1, archived: 0 });
});

it('pages the actual source-work query past fifty rows after current visibility filtering', async () => {
  const f = await fixture(), { tasks } = await import('../data/schema.js');
  const { dataQueries } = await import('../data/queries.js');
  const { sourceQuery } = await import('../../../web/src/pieces/comms/work-query.js');
  for (let n=0;n<51;n++) f.db.insert(tasks).values({id:`t-${String(n).padStart(3,'0')}`,title:`Task ${n}`,ownerKind:'member',owner:'alice',createdByKind:'member',createdBy:'alice',createdAt:'2026-11-14T18:00:00Z',changedAt:'2026-11-14T18:00:00Z',sourceKind:'conversation',sourceId:f.thread.conversation}).run();
  const schema=withQueryFields(dataQueries(f.db.$client,{tables:['tasks'],visibility:{tasks:fields=>eq(fields.owner,'alice')}}),conversationWorkFields(f.db));
  const first=await graphql({schema,source:sourceQuery,variableValues:{conversation:f.thread.conversation,offset:0},contextValue:{viewer:alice}});
  expect(first.errors).toBeUndefined(); expect((first.data?.tasks as unknown[]).length).toBe(51);
  const next=await graphql({schema,source:sourceQuery,variableValues:{conversation:f.thread.conversation,offset:50},contextValue:{viewer:alice}});
  expect(next.errors).toBeUndefined(); expect(JSON.parse(JSON.stringify(next.data))).toEqual({tasks:[{id:'t-050',title:'Task 50',status:'open',isShelved:false}],conversationMadeChanges:[]});
});
it('loads the mentioned pull-request card through current generated Changes visibility', async () => {
  const f=await fixture(), { changes, memberAgents }=await import('../data/schema.js');
  const { dataQueries }=await import('../data/queries.js'), { workVisibility }=await import('../data/work-visibility.js');
  const { changeQuery }=await import('../../../web/src/pieces/comms/work-query.js');
  const id='github:house/loom#7';
  f.db.insert(memberAgents).values({member:'alice',agent:'art'}).run();
  f.db.insert(changes).values({id,repository:'house/loom',number:7,title:'Current PR',body:'',url:'https://github.com/house/loom/pull/7',state:'open',draft:false,authorLogin:'art',agent:'art',branch:'fix',headCommit:'a'.repeat(40),baseBranch:'next',checks:'running',review:'required',mergeable:'unknown',waitingOn:'ci',openedAt:'2026-11-14T18:00:00Z',updatedAt:'2026-11-14T18:00:00Z'}).run();
  const schema=withQueryFields(dataQueries(f.db.$client,{tables:['changes'],visibility:workVisibility(alice)}),conversationWorkFields(f.db));
  const read=()=>graphql({schema,source:changeQuery,variableValues:{id,conversation:f.thread.conversation},contextValue:{viewer:alice}});
  const first=await read(); expect(first.errors).toBeUndefined(); expect(JSON.parse(JSON.stringify(first.data))).toEqual({changes:[{id,title:'Current PR',state:'open',draft:false,checks:'running',review:'required',waitingOn:'ci'}],conversationMadeChanges:[]});
  f.db.delete(memberAgents).run(); const revoked=await read(); expect(revoked.errors).toBeUndefined(); expect(JSON.parse(JSON.stringify(revoked.data))).toEqual({changes:[],conversationMadeChanges:[]});
});

it('reads archived metadata without ciphertext and rechecks thread visibility after decrypting the body', async () => {
  const f=await fixture();
  const {archivedQuestions}=await import('../data/schema.js');
  f.db.insert(archivedQuestions).values({thread:f.thread.id,sourceMember:'alice',sourceAgent:'art',sourceConversation:f.thread.conversation,ref:'approval:a',approval:'a',
    raisedAt:'2026-11-20T00:00:00Z',seenAt:'2026-11-14T00:00:00Z',keepUntil:'2026-11-16T00:00:00Z',
    words:Buffer.from(JSON.stringify({text:'Fictional archive words'})),verdict:'denied'}).run();
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:commsQueryFields(f.service)})});
  const ask=(fields:string)=>graphql({schema,source:'{commsArchivedQuestions(thread:"th:alice"){'+fields+'}}',contextValue:{viewer:alice}});
  const opens=f.opens();f.statements.splice(0);
  expect((await ask('ref verdict')).data).toEqual({commsArchivedQuestions:[{ref:'approval:a',verdict:'denied'}]});
  expect(f.opens()).toBe(opens);
  expect(f.statements.some(sql=>sql.includes('"words"'))).toBe(false);
  f.db.update(conversations).set({member:'bob'}).where(eq(conversations.id,f.thread.conversation)).run();
  const reassigned=await graphql({schema,source:'{commsArchivedQuestions(thread:"th:alice"){ref body{text}}}',contextValue:{viewer:{kind:'member',id:'bob'}}});
  expect(reassigned.data).toEqual({commsArchivedQuestions:[]});
  f.db.update(conversations).set({member:'alice'}).where(eq(conversations.id,f.thread.conversation)).run();
  f.onOpen(f.revoke);
  const changed=await ask('body{text}');
  expect(changed.data).toBeNull();
  expect(changed.errors?.[0].message).toBe('Comms changed; retry the query');
  expect(JSON.stringify(changed)).not.toContain('Fictional archive words');
  expect((await ask('ref body{text}')).data).toEqual({commsArchivedQuestions:[]});
});

it('serves the activity card and history under the current source conversation visibility', async () => {
  const f = await fixture();
  const { prepareAgentPost } = await import('./agent-posts.js');
  const at = '2026-11-14T18:00:00.000Z';
  const other = f.comms.threads.open({ agent:'art', member:'bob', title:'Other' });
  const write = async (source: string, edit: Parameters<typeof prepareAgentPost>[3]) =>
    (await prepareAgentPost(f.db, f.key, source, edit))(at);
  const thread = await write(f.thread.id,{ action:'open', words:'Boot console' });
  await write(f.thread.id,{ action:'reply', thread, words:'It scrolls!' });
  const otherActivity = await write(other.id,{ action:'open', words:'Other work' });
  const schema = new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:commsQueryFields(f.service)})});
  const read = (who: typeof alice, id: string) => graphql({schema,contextValue:{viewer:who},variableValues:{id},
    source:`query($id:String!){
      agentActivityFeed(agent:"art"){thread title latest{words} parent{words}}
      agentActivityHistory(agent:"art",thread:$id){id words}
    }`});
  const own = await read(alice,thread);
  expect(own.errors).toBeUndefined();
  expect(own.data).toEqual({agentActivityFeed:[{thread,title:'Boot console',latest:{words:'It scrolls!'},parent:{words:'Boot console'}}],
    agentActivityHistory:[{id:'1',words:'Boot console'},{id:'2',words:'It scrolls!'}]});
  expect((await read(alice,otherActivity)).data?.agentActivityHistory).toEqual([]);
  expect((await read(owner,otherActivity)).data?.agentActivityHistory).toEqual([{id:'3',words:'Other work'}]);
  f.onOpen(f.revoke);
  expect((await read(alice,thread)).data).toEqual({agentActivityFeed:[],agentActivityHistory:[]});
});

it('attaches current work states to a post without requiring the IDs in its words', async () => {
  const f = await fixture();
  const { changes, tasks } = await import('../data/schema.js');
  const { prepareAgentPost } = await import('./agent-posts.js');
  const at = '2026-11-14T18:00:00Z', id = 'github:house/loom#7';
  f.db.insert(memberAgents).values({member:'alice',agent:'art'}).run();
  f.db.insert(tasks).values({id:'t-17',title:'Fix disk cleanup',ownerKind:'member',owner:'alice',
    createdByKind:'member',createdBy:'alice',createdAt:at,changedAt:at}).run();
  f.db.insert(changes).values({id,repository:'house/loom',number:7,title:'Remove test homes',body:'',url:'https://github.com/house/loom/pull/7',
    state:'open',draft:false,authorLogin:'art',agent:'art',branch:'fix',headCommit:'a'.repeat(40),baseBranch:'next',
    checks:'passing',review:'approved',mergeable:'yes',waitingOn:'author',openedAt:at,updatedAt:at}).run();
  const thread=(await prepareAgentPost(f.db,f.key,f.thread.id,{action:'open',words:'Oh right, it was me. Fixed.',refs:['t-17',id]}))(at);
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:commsQueryFields(f.service)})});
  const read=async()=> {
    const result=await graphql({schema,source:'{agentActivityFeed(agent:"art"){latest{words work{id title state href}}}}',contextValue:{viewer:alice}});
    expect(result.errors).toBeUndefined();
    return (result.data!.agentActivityFeed as {latest:{work:unknown[];words:string}}[])[0].latest;
  };
  const task={id:'t-17',title:'Fix disk cleanup',state:'open',href:'/p/tasks-preview/task/t-17'};
  const change={id,title:'Remove test homes',state:'open',href:'/p/changes-preview/change/github%3Ahouse%2Floom%237'};
  expect(await read()).toEqual({words:'Oh right, it was me. Fixed.',work:[task,change]});
  f.db.update(changes).set({state:'merged'}).where(eq(changes.id,id)).run();
  expect((await read()).work).toEqual([task,{...change,state:'merged'}]);
  (await prepareAgentPost(f.db,f.key,f.thread.id,{action:'reply',thread,words:'See t-17 and https://github.com/house/loom/pull/7.'}))(at);
  expect((await read()).work).toEqual([task,{...change,state:'merged'}]);
  f.db.delete(memberAgents).run();
  expect((await read()).work).toEqual([task]);
});
