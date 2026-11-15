import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { agents, conversations, digests, digestItems, inbox, inboxRefs, members, messages } from '../data/schema.js';
import { CommsMessages } from './messages.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const now = () => '2026-11-14T18:00:00.000Z', db = createDataSchema(client, now);
  for (const id of ['alice', 'bob']) db.insert(members).values({ id, role: 'member', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  let onSeal = () => {};
  const sealed: Buffer[] = [];
  const key = { hash: (s: string) => s, open: async (b: Uint8Array) => Buffer.from(Buffer.from(b).toString().slice(7), 'base64').toString(), seal: async (s: string) => { expect(client.inTransaction).toBe(false); onSeal(); const value = Buffer.from('sealed:' + Buffer.from(s).toString('base64')); sealed.push(value); return value; } };
  const comms = new CommsMessages(db, key, now), thread = comms.threads.open({ member: 'alice', agent: 'art', title: 'Private' });
  const input = { conversation: thread.conversation, run: 'run-1', summary: 'Completed the search', items: [{ kind: 'task' as const, text: 't-1' }],
    question: { to: 'alice', words: 'Order the private pump?', answers: 'yes-no' as const, why: 'Private reason', ifYes: 'Order privately', ifNo: 'Skip privately', refs: ['t-1', 'cv-reference'] } };
  return { client, db, comms, thread, input, sealed, onSeal: (fn: () => void) => { onSeal = fn; } };
}
const changes = ['revision', 'scope', 'venue', 'place', 'delete'] as const;
function mutate(f: ReturnType<typeof fixture>, change: typeof changes[number]) {
  if (change === 'revision') f.comms.threads.conversations.digest({ ...f.input, summary: 'Newer', question: undefined });
  if (change === 'scope') f.db.update(conversations).set({ member: 'bob' }).where(eq(conversations.id, f.thread.conversation)).run();
  if (change === 'venue') f.db.update(conversations).set({ venue: 'wake' }).where(eq(conversations.id, f.thread.conversation)).run();
  if (change === 'place') f.db.update(conversations).set({ place: 'other' }).where(eq(conversations.id, f.thread.conversation)).run();
  if (change === 'delete') f.comms.delete(f.thread.id);
}
it('writes private digest questions only in encrypted thread messages and links the same Inbox item', async () => {
  const f = fixture();
  expect(() => f.comms.threads.conversations.digest(f.input)).toThrow('encrypted Comms');
  const commit = await f.comms.prepareDigest(f.input);
  expect(f.db.select().from(inbox).all()).toEqual([]); expect(f.db.select().from(digests).all()).toEqual([]);
  const digest = f.db.transaction(commit);
  expect(digest).toMatchObject({ summary: f.input.summary, revision: 1 });
  const mail = f.db.select().from(inbox).where(eq(inbox.id, digest.inboxItem!)).get()!;
  expect(mail).toMatchObject({ toKind: 'person', to: 'alice', conversation: f.thread.conversation, answers: 'yes-no', words: null, why: null, ifYes: null, ifNo: null, thread: f.thread.id });
  expect(JSON.stringify(mail)).not.toContain('private pump');
  expect(f.db.select().from(messages).get()?.words).toEqual(f.sealed[0]);
  expect(f.sealed[0].includes(Buffer.from(f.input.question.words))).toBe(false);
  expect(JSON.parse((await f.comms.words(f.thread.id, mail.messageSeq!))!)).toMatchObject({ words: f.input.question.words, why: f.input.question.why });
  expect(f.db.select().from(inboxRefs).all()).toEqual(expect.arrayContaining([{ item: mail.id, ref: 't-1' }, { item: mail.id, ref: 'cv-reference' }]));
  expect(f.db.select().from(digestItems).all()).toMatchObject([{ digest: digest.id, kind: 'task', text: 't-1' }]);
});
it('retires pending asks on rewrite but preserves answered history, including a rewrite with no question', async () => {
  const f = fixture(), first = await f.comms.digest(f.input);
  const second = await f.comms.digest({ ...f.input, items: [{ kind: 'decision', text: 'Choose the smaller pump' }], question: { ...f.input.question, words: 'A revised private ask?' } });
  expect(second.id).toBe(first.id); expect(second.revision).toBe(2);
  expect(f.db.select().from(digestItems).all()).toEqual([{ digest: second.id, kind: 'decision', text: 'Choose the smaller pump' }]);
  expect(f.comms.threads.conversations.item(first.inboxItem!).state).toBe('resolved');
  await f.comms.answer(second.inboxItem!, 'alice', 'yes');
  const third = await f.comms.digest({ ...f.input, items: undefined, question: undefined });
  expect(f.db.select().from(digestItems).all()).toEqual([]);
  expect(third).toMatchObject({ revision: 3, inboxItem: null });
  expect(f.comms.threads.conversations.item(second.inboxItem!).state).toBe('answered');
});
it('rolls a prepared private digest and its encrypted question back with its caller transaction', async () => {
  const f = fixture(), commit = await f.comms.prepareDigest(f.input);
  expect(() => f.db.transaction(() => { commit(); throw new Error('outer failure'); })).toThrow('outer failure');
  for (const table of [messages, inbox, digests, digestItems]) expect(f.db.select().from(table).all()).toEqual([]);
});
it('rejects changed revision, changed scope, other recipient or a deleted thread after encryption', async () => {
  for (const change of changes) {
    const f = fixture();
    f.onSeal(() => mutate(f, change));
    const commit = await f.comms.prepareDigest(f.input);
    expect(() => commit(), change).toThrow();
    expect(f.db.select().from(messages).all()).toEqual([]);
    expect(f.db.select().from(inbox).all()).toEqual([]);
  }
  const f = fixture();
  await expect(f.comms.digest({ ...f.input, question: { ...f.input.question, to: 'bob' } })).rejects.toThrow('member thread');
});
it.each(['task', 'approval'] as const)('links a private digest question to a %s outcome without persisting its words', async kind => {
  const f = fixture();
  const digest = await f.comms.digest({ ...f.input, question: { ...f.input.question, waitsOnKind: kind, waitsOnId: 'source-1' } });
  expect(f.comms.threads.conversations.item(digest.inboxItem!)).toMatchObject({ waitsOnKind: kind, waitsOnId: 'source-1', words: null });
  f.comms.threads.conversations.resolve(kind, 'source-1', 'Source settled');
  expect(f.comms.threads.conversations.item(digest.inboxItem!)).toMatchObject({ state: 'resolved', resolution: 'Source settled' });
});

it('revalidates questionless prepared rewrites against revisions, routing scope and deleted thread', async () => {
  for (const change of changes) {
    const f = fixture();
    const commit = await f.comms.prepareDigest({ ...f.input, question: undefined });
    mutate(f, change);
    expect(() => commit(), change).toThrow();
    expect(f.db.select().from(messages).all()).toEqual([]);
    expect(f.db.select().from(digests).all()).toHaveLength(change === 'revision' ? 1 : 0);
  }
});
it('owns the private rewrite transaction even without an enclosing caller transaction', async () => {
  const f = fixture(), first = await f.comms.digest(f.input);
  const oldMessages = f.db.select().from(messages).all(), oldMail = f.db.select().from(inbox).all();
  const commit = await f.comms.prepareDigest({ ...f.input, summary: 'Changed', question: { ...f.input.question, words: 'Changed private ask' } });
  f.client.exec("CREATE TRIGGER refuse_digest BEFORE UPDATE ON digests BEGIN SELECT RAISE(ABORT, 'digest unavailable'); END");
  expect(() => commit()).toThrow('digest unavailable');
  expect(f.db.select().from(messages).all()).toEqual(oldMessages);
  expect(f.db.select().from(inbox).all()).toEqual(oldMail);
  expect(f.db.select().from(digests).all()).toEqual([first]);
});

it('rejects oversized private digest summaries without encrypting or writing any rows', async () => {
  for (const question of [true, false]) {
    const f = fixture();
    await expect(f.comms.prepareDigest({ ...f.input, summary: 'x'.repeat(601), question: question ? f.input.question : undefined })).rejects.toThrow('600');
    expect(f.sealed).toEqual([]);
    for (const table of [messages, inbox, digests, digestItems]) expect(f.db.select().from(table).all()).toEqual([]);
  }
});
