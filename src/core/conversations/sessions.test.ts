import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, conversationSessions, household } from '../data/schema.js';
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
  const save = async (more: Partial<{ harness: string; model: string; session: string; files: string }> = {}) => sessions.store(await sessions.seal({ conversation: cv, harness: 'claude', model: 'claude-opus-5-5', session: 'abcd-1234', files, ...more }));
  return { db, cv, sessions, save, files, now, later: (ms: number) => { at += ms; } };
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
    expect(f.db.select().from(conversationSessions).get()?.savedAt).toBe(new Date(started).toISOString());
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
  expect(f.db.select().from(conversationSessions).get()).toMatchObject({ session: 'fresh-0001', savedAt: f.now() });
  f.later(3 * 86_400_000);
  expect(expireConversationSessions(f.db, ageCutoff(f.now(), 3))).toBe(1);
  expect(oldestConversationSession(f.db)).toBeUndefined();
});

it('hands on nothing it cannot open', async () => {
  const f = fixture(); await f.save();
  f.db.update(conversationSessions).set({ files: Buffer.from('not what was sealed') }).run();
  expect(await f.sessions.open(f.cv, 'claude', 'claude-opus-5-5')).toBeNull();
});
