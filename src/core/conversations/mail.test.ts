import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { generateX25519Identity } from 'age-encryption';
import { createDataSchema } from '../data/database.js';
import { agents, conversations, inbox, jobs, members, messages } from '../data/schema.js';
import { wordsKey } from '../../pieces/comms/crypto.js';
import { CommsMessages } from './messages.js';
import { ConversationMail } from './mail.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
async function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let time = '2026-11-14T18:00:00.000Z';
  const now = () => time, db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const key = wordsKey(await generateX25519Identity()), comms = new CommsMessages(db, key, now);
  const thread = comms.threads.open({ id: 'th:one', member: 'jonathan', agent: 'art', title: 'Pump' });
  db.insert(jobs).values({ id: 'job-1', agent: 'art', conversation: thread.conversation, title: 'Pump', state: 'running', brief: '', model: 'model-1', startedByKind: 'member', startedBy: 'jonathan', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: now() }).run();
  db.update(conversations).set({ job: 'job-1' }).where(eq(conversations.id, thread.conversation)).run();
  const plain = (words: string) => comms.threads.conversations.send({ conversation: thread.conversation, toKind: 'agent', to: 'art', source: 'trigger', fromKind: 'schedule', words });
  const send = (words: string) => comms.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words });
  return { client, db, key, comms, thread, plain, send, mail: new ConversationMail(comms), at: (value: string) => { time = value; } };
}

it('takes only an explicitly prepared batch and treats an empty batch as no mail', async () => {
  const { comms, thread, plain } = await fixture(), service = comms.threads.conversations;
  const first = plain('First'), second = plain('Later');
  expect(service.take(thread.conversation, 'job-1', []).map(item => item.id)).toEqual([]);
  expect(service.take(thread.conversation, 'job-1', [first.id]).map(item => item.id)).toEqual([first.id]);
  expect(service.item(second.id)).toMatchObject({ state: 'waiting', job: null });
  expect(service.take(thread.conversation, 'job-1', [first.id]).map(item => item.id)).toEqual([first.id]);
});

it('decrypts private mail outside transactions, commits exact ordered mail, and keeps words out of durable metadata', async () => {
  const { client, db, key, comms, thread, plain, send } = await fixture();
  const first = await send('Private pump request'), second = plain('Trigger');
  const mail = new ConversationMail(new CommsMessages(db, { ...key, open: async blob => {
    expect(client.inTransaction).toBe(false);
    return key.open(blob);
  } }, comms.now));
  const commit = await mail.prepareTake(thread.conversation, 'job-1');
  expect(db.select().from(inbox).all().map(item => item.state)).toEqual(['waiting', 'waiting']);
  const late = await send('Later private words');
  const result = db.transaction(() => commit());
  expect(result.map(row => [row.item.id, row.words])).toEqual([[first.inboxItem, 'Private pump request'], [second.id, 'Trigger']]);
  expect(result[0].item.words).toBeNull();
  expect(comms.threads.conversations.item(late.inboxItem!).state).toBe('waiting');
  expect(db.select().from(messages).all().map(row => row.delivery)).toEqual(['sending', 'sending']);
  expect(JSON.stringify(db.select().from(inbox).all())).not.toContain('Private pump request');
  expect(db.select().from(jobs).get()?.brief).toBe('');
  expect(commit().map(row => row.words)).toEqual(['Private pump request', 'Trigger']);
});

it('rolls back the whole claim when the outer operation fails and updates delivery only on confirmation', async () => {
  const { db, comms, thread, mail, send } = await fixture();
  const message = await send('Private');
  const commit = await mail.prepareTake(thread.conversation, 'job-1');
  expect(() => db.transaction(() => { commit(); throw new Error('receipt failed'); })).toThrow('receipt failed');
  expect(comms.threads.conversations.item(message.inboxItem!).state).toBe('waiting');
  commit();
  expect(db.select().from(messages).get()?.delivery).toBe('sending');
  expect(() => db.transaction(() => { mail.confirm(thread.conversation, 'job-1', message.inboxItem!); throw new Error('accept failed'); })).toThrow('accept failed');
  expect(comms.threads.conversations.item(message.inboxItem!).state).toBe('taken');
  expect(db.select().from(messages).get()?.delivery).toBe('sending');
  const done = mail.confirm(thread.conversation, 'job-1', message.inboxItem!);
  expect(mail.confirm(thread.conversation, 'job-1', message.inboxItem!)).toEqual(done);
  expect(done.state).toBe('done');
  expect(db.select().from(messages).get()?.delivery).toBe('delivered');
});

it('delivers encrypted question answers to the agent and leaves the person question out of its mail', async () => {
  const { db, comms, thread, mail } = await fixture();
  const ask = await comms.ask(thread.id, 'art', 'question', { words: 'Private question?', answers: 'words' });
  await comms.answer(ask.inboxItem!, 'jonathan', 'words', 'Private answer');
  const result = (await mail.prepareTake(thread.conversation, 'job-1'))();
  expect(result).toMatchObject([{ item: { source: 'answer', sourceId: ask.inboxItem, state: 'taken', words: null }, words: 'Private answer' }]);
  expect(comms.threads.conversations.item(ask.inboxItem!).state).toBe('answered');
  mail.confirm(thread.conversation, 'job-1', result[0].item.id);
  expect(db.select().from(messages).all().map(row => row.delivery)).toEqual([null, null]);
  expect(JSON.stringify(db.select().from(inbox).all())).not.toContain('Private answer');
});

it.each(['ended', 'replaced', 'mute', 'recipient', 'content', 'delete'] as const)('refuses prepared mail when its %s state changes during decryption', async change => {
  const { db, key, comms, thread, send } = await fixture();
  const message = await send('Never release stale words');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const mail = new ConversationMail(new CommsMessages(db, { ...key, open: async blob => { await gate; return key.open(blob); } }, comms.now));
  const pending = mail.prepareTake(thread.conversation, 'job-1');
  if (change === 'ended') db.update(jobs).set({ state: 'lost' }).where(eq(jobs.id, 'job-1')).run();
  if (change === 'replaced') db.update(conversations).set({ job: null }).where(eq(conversations.id, thread.conversation)).run();
  if (change === 'mute') db.update(inbox).set({ volume: 'mute' }).where(eq(inbox.id, message.inboxItem!)).run();
  if (change === 'recipient') db.update(inbox).set({ toKind: 'person', to: 'jonathan' }).where(eq(inbox.id, message.inboxItem!)).run();
  if (change === 'content') db.update(messages).set({ words: await key.seal('Replacement') }).where(eq(messages.thread, thread.id)).run();
  if (change === 'delete') comms.delete(thread.id);
  release();
  const commit = await pending;
  expect(() => commit()).toThrow();
  expect(db.select().from(inbox).all().every(item => item.state !== 'taken')).toBe(true);
});

it.each([false, true])('rechecks retention at release with ciphertext swept=%s', async sweep => {
  const { db, key, comms, thread, send, at } = await fixture();
  const message = await send('Expiring');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const mail = new ConversationMail(new CommsMessages(db, { ...key, open: async blob => { await gate; return key.open(blob); } }, comms.now));
  const pending = mail.prepareTake(thread.conversation, 'job-1');
  at(message.keepUntil!);
  if (sweep) comms.expire();
  release();
  const commit = await pending;
  expect(commit()).toMatchObject([{ item: { state: 'taken', words: null }, words: null }]);
});

it('does not decrypt or claim muted mail and rejects preparation inside a transaction', async () => {
  const { db, key, comms, thread, send } = await fixture();
  const message = await send('Muted');
  db.update(inbox).set({ volume: 'mute' }).where(eq(inbox.id, message.inboxItem!)).run();
  const mail = new ConversationMail(new CommsMessages(db, { ...key, open: async () => { throw new Error('Must not decrypt'); } }, comms.now));
  const commit = await mail.prepareTake(thread.conversation, 'job-1');
  expect(commit()).toEqual([]);
  expect(comms.threads.conversations.item(message.inboxItem!).state).toBe('waiting');
  let pending!: ReturnType<ConversationMail['prepareTake']>;
  db.transaction(() => { pending = mail.prepareTake(thread.conversation, 'job-1'); });
  await expect(pending).rejects.toThrow('outside a transaction');
});

it('rejects a malformed private reference, failed decryption, and a stale confirmation without taking mail', async () => {
  const { db, key, comms, thread, mail, send } = await fixture();
  const message = await send('Private');
  const other = await comms.send({ thread: thread.id, sender: 'art', kind: 'reply', words: 'A different valid message' });
  db.update(inbox).set({ messageSeq: other.seq }).where(eq(inbox.id, message.inboxItem!)).run();
  await expect(mail.prepareTake(thread.conversation, 'job-1')).rejects.toThrow('reference differs');
  db.update(inbox).set({ messageSeq: message.seq }).where(eq(inbox.id, message.inboxItem!)).run();
  const broken = new ConversationMail(new CommsMessages(db, { ...key, open: async () => { throw new Error('Decrypt failed'); } }, comms.now));
  await expect(broken.prepareTake(thread.conversation, 'job-1')).rejects.toThrow('Decrypt failed');
  expect(comms.threads.conversations.item(message.inboxItem!).state).toBe('waiting');
  (await mail.prepareTake(thread.conversation, 'job-1'))();
  db.update(jobs).set({ state: 'lost' }).where(eq(jobs.id, 'job-1')).run();
  expect(() => mail.confirm(thread.conversation, 'job-1', message.inboxItem!)).toThrow('not running');
  expect(db.select().from(messages).get()?.delivery).toBe('sending');
});
