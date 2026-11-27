import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, conversationSessions, household, members, deletedThreads } from '../data/schema.js';
import { CommsMessages } from './messages.js';
import { Conversations } from './index.js';
import { ConversationSessions, expireConversationSessions, oldestConversationSession } from './sessions.js';
import { SESSION_BYTES, SESSION_ID, modelFamily } from './session-limit.js';
import { ageCutoff } from './retention.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let at = Date.parse('2026-11-14T12:00:00.000Z');
  const now = () => new Date(at).toISOString(), db = createDataSchema(client, now);
  db.insert(agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(household).values({ commsDays: 3 }).run();
  const cv = new Conversations(db, now).open({ agent: 'art', venue: 'discord', place: '["g","c",null]', label: 'c' }).id;
  // A stand-in for the words key: sealing is seen to happen, and opening undoes it.
  const key = { seal: async (words: string) => Buffer.from('SEALED:' + Buffer.from(words).toString('hex')), open: async (blob: Uint8Array) => Buffer.from(Buffer.from(blob).toString().slice(7), 'hex').toString(), hash: (words: string) => words };
  const sessions = new ConversationSessions(db, now, key);
  const files = Buffer.from('record').toString('base64');
  const save = async (more: Partial<{ harness: string; model: string; session: string; files: string; since: string; until: string }> = {}) => sessions.store(await sessions.seal({ conversation: cv, harness: 'claude', model: 'claude-opus-5-5', session: 'abcd-1234', files, ...more }));
  return { db, cv, key, sessions, save, files, now, later: (ms: number) => { at += ms; } };
}

it('keeps one session for a conversation and harness, sealed, and replaces it whole', async () => {
  const f = fixture();
  expect(await f.save()).toBe(true);
  expect(await f.save({ session: 'efgh-5678' })).toBe(true);
  expect(await f.save({ harness: 'codex', model: 'gpt-6-luna', session: 'thread-1' })).toBe(true);
  const rows = f.db.select().from(conversationSessions).all();
  expect(rows.map(row => [row.harness, row.session, row.bytes])).toEqual([['claude', 'efgh-5678', 6], ['codex', 'thread-1', 6]]);
  expect(rows.every(row => row.files.toString().startsWith('SEALED:') && !row.files.includes(Buffer.from(f.files)))).toBe(true);
  expect(await f.sessions.open(f.cv, 'claude', 'claude-sonnet-5-5')).toMatchObject({ session: 'efgh-5678', files: f.files });
  expect(await f.sessions.open(f.cv, 'codex', 'gpt-6.1-sol')).toMatchObject({ session: 'thread-1' });
  expect(await f.sessions.open(f.cv, 'agy', 'gemini-4-argon-high')).toBeNull();
});

it('hands a session on within one family of models and not across', async () => {
  const f = fixture(); await f.save();
  expect(await f.sessions.open(f.cv, 'claude', 'gpt-6-luna')).toBeNull();
  expect(await f.sessions.open(f.cv, 'claude', 'Claude-Fable-5-2')).not.toBeNull();
  expect([modelFamily('claude-opus-5-5'), modelFamily('gpt-6.1-sol'), modelFamily('gemini-4-argon-high'), modelFamily('GPT-6-luna')]).toEqual(['claude', 'gpt', 'gemini', 'gpt']);
});

it('keeps nothing too large, empty or with an id that could be a path, and then removes what was kept', async () => {
  const f = fixture();
  await f.save();
  expect(await f.save({ files: Buffer.alloc(SESSION_BYTES + 1, 1).toString('base64') })).toBe(false);
  expect(f.db.select().from(conversationSessions).all()).toEqual([]);
  expect(await f.save({ files: Buffer.alloc(SESSION_BYTES, 1).toString('base64') })).toBe(true);
  for (const session of ['../x', 'a/b', '', 'abc', '.hidden']) { expect(SESSION_ID.test(session), session).toBe(false); expect(await f.save({ session })).toBe(false); }
  expect(await f.save({ files: '' })).toBe(false);
  expect(f.db.select().from(conversationSessions).all()).toEqual([]);
});

it('keeps a session for the household\'s keep time counted from when it was started, however often it is saved since', async () => {
  const f = fixture(); await f.save();
  const started = Date.parse(f.now());
  expect(oldestConversationSession(f.db)).toBe(started);
  // The conversation goes on: the session is saved again each day, and its start does not move.
  for (let day = 1; day <= 2; day++) {
    f.later(86_400_000); await f.save({ files: Buffer.from('record, day ' + day).toString('base64') });
    expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(new Date(started).toISOString());
    expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).toMatchObject({ startedAt: new Date(started).toISOString(), lastSavedAt: f.now() });
  }
  f.later(86_400_000 - 1000);
  expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).not.toBeNull();
  expect(expireConversationSessions(f.db, ageCutoff(f.now(), 3))).toBe(0);
  f.later(1000);
  // Three days after it was started it is not handed on, though it was saved a day ago, whether or not the sweep has run.
  expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).toBeNull();
  // A save now does not continue it: it starts a new session and a new count.
  await f.save({ session: 'fresh-0001' });
  expect(f.db.select().from(conversationSessions).get()).toMatchObject({ session: 'fresh-0001', startedAt: f.now() });
  f.later(3 * 86_400_000);
  expect(expireConversationSessions(f.db, ageCutoff(f.now(), 3))).toBe(1);
  expect(oldestConversationSession(f.db)).toBeUndefined();
});

it('counts a session started with older erasable words handed in from the oldest of them, so none outlives the keep time', async () => {
  const f = fixture();
  // A direct conversation's body starts fresh and is handed history whose oldest line was said two days ago.
  const said = new Date(Date.parse(f.now()) - 2 * 86_400_000).toISOString();
  expect(await f.save({ since: said })).toBe(true);
  expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(said);
  // A day later that word is erased (the keep time is three days), and the session that holds it is not handed on.
  f.later(86_400_000 - 1000); expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).not.toBeNull();
  f.later(1000); expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).toBeNull();
  expect(expireConversationSessions(f.db, ageCutoff(f.now(), 3))).toBe(1);
  // Handed words already past the keep time, a session is not kept at all, and takes the one kept with it.
  await f.save();
  expect(await f.save({ since: new Date(Date.parse(f.now()) - 3 * 86_400_000).toISOString() })).toBe(false);
  expect(f.db.select().from(conversationSessions).all()).toEqual([]);
  // A later save never moves the start forward, and an earlier `since` moves it back.
  await f.save(); const first = f.now();
  f.later(3_600_000); await f.save({ since: f.now() });
  expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(first);
  const earlier = new Date(Date.parse(first) - 3_600_000).toISOString();
  await f.save({ since: earlier });
  expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(earlier);
  // A time that is not one, or is in the future, is not a start.
  for (const since of ['yesterday', new Date(Date.parse(f.now()) + 86_400_000).toISOString()]) { await f.save({ since }); expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(earlier); }
});

it('hands on nothing it cannot open', async () => {
  const f = fixture(); await f.save();
  f.db.update(conversationSessions).set({ files: Buffer.from('not what was sealed') }).run();
  expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).toBeNull();
});

it('erases all checkpoints for a deleted Comms thread and fences a pending read and a delayed save', async () => {
  const f = fixture();
  f.db.insert(members).values({id:'alice',role:'member',joinedAt:f.now()}).run();
  const comms = new CommsMessages(f.db,f.key,f.now);
  const thread = comms.threads.open({agent:'art',member:'alice',title:'Private'});
  const input = {conversation:thread.conversation,harness:'claude',model:'fixture',session:'abcd-1234',files:f.files};
  const prepared = await f.sessions.seal(input);
  expect(f.sessions.store(prepared)).toBe(true);
  expect(f.sessions.store(await f.sessions.seal({...input,harness:'codex'}))).toBe(true);
  expect(await f.save()).toBe(true);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const waiting = new ConversationSessions(f.db,f.now,{...f.key,async open(blob) {
    started.resolve(); await release.promise; return f.key.open(blob);
  }});
  const opening = waiting.open(thread.conversation,'claude','fixture');
  await started.promise;
  comms.delete(thread.id);
  comms.delete(thread.id);
  release.resolve();
  expect(await opening).toBeNull();
  expect(f.sessions.store(prepared)).toBe(false);
  expect(f.db.select({conversation:conversationSessions.conversation}).from(conversationSessions).all())
    .toEqual([{conversation:f.cv}]);
});

it.each(['startup sweep','repeat deletion'])('removes legacy checkpoints for already deleted threads on %s',async cleanup=>{
  const f=fixture(), other=new Conversations(f.db,f.now).open({agent:'art',venue:'loom',place:'th:former',label:'Former'});
  expect(await f.save()).toBe(true);
  for (const harness of ['claude','codex']) {
    expect(f.sessions.store(await f.sessions.seal({conversation:other.id,harness,model:'fixture',session:'abcd-1234',files:f.files}))).toBe(true);
  }
  f.db.insert(deletedThreads).values({id:'th:former',conversation:other.id,at:f.now()}).run();
  expect(await f.sessions.open(other.id,'claude','fixture')).toBeNull();
  const comms=new CommsMessages(f.db,f.key,f.now);
  if(cleanup==='startup sweep') expect(comms.expire()).toBe(2);
  else comms.delete('th:former');
  expect(f.db.select({id:conversationSessions.conversation}).from(conversationSessions).all()).toEqual([{id:f.cv}]);
});

it('counts a session from the keep time before the first of its words is erased, when that is earlier than the word\'s age gives', async () => {
  const f = fixture(), day = 86_400_000, at = (ms: number) => new Date(Date.parse(f.now()) + ms).toISOString();
  // Handed a word said an hour ago whose own limit is a day away (a work notice counts from its thread's opening;
  // a word written under a shorter keep time keeps that limit): the keep time is three days, so the count starts two days back.
  expect(await f.save({ since: at(-3_600_000), until: at(day) })).toBe(true);
  expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(at(-2 * day));
  // It is handed on until that word is erased, and goes in the sweep that erases it.
  f.later(day - 1000); expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).not.toBeNull();
  expect(expireConversationSessions(f.db, ageCutoff(f.now(), 3))).toBe(0);
  f.later(1000); expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).toBeNull();
  expect(expireConversationSessions(f.db, ageCutoff(f.now(), 3))).toBe(1);
  // A later job handed an earlier erasure moves the start back; one handed a later erasure leaves it.
  await f.save(); const first = f.now();
  await f.save({ until: at(4 * day) }); expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(first);
  await f.save({ until: at(2 * day) }); expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(at(-day));
  // Handed a word already erased, or a time that is none, nothing of it is counted or kept past its time.
  await f.save({ until: 'soon' }); expect(f.db.select().from(conversationSessions).get()?.startedAt).toBe(at(-day));
  expect(await f.save({ until: f.now() })).toBe(false);
  expect(f.db.select().from(conversationSessions).all()).toEqual([]);
});

it('erases a thread\'s session when the thread is archived', async () => {
  const f = fixture();
  f.db.insert(members).values({ id: 'alice', role: 'member', joinedAt: f.now() }).run();
  const comms = new CommsMessages(f.db, f.key, f.now), thread = comms.threads.open({ agent: 'art', member: 'alice', title: 'Private' });
  for (const harness of ['claude', 'codex']) expect(f.sessions.store(await f.sessions.seal({ conversation: thread.conversation, harness, model: 'fixture', session: 'abcd-1234', files: f.files }))).toBe(true);
  expect(await f.save()).toBe(true);
  comms.threads.archive(thread.id, false);
  expect(f.db.select().from(conversationSessions).all()).toHaveLength(3);
  comms.threads.archive(thread.id, true);
  expect(f.db.select({ conversation: conversationSessions.conversation }).from(conversationSessions).all()).toEqual([{ conversation: f.cv }]);
});
