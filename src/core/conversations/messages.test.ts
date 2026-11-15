import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, deletedThreads, household, inbox, inboxRefs, members, messages, threadRefs, threads, turns, conversationPeople, conversations } from '../data/schema.js';
import type { WordsKey } from '../../pieces/comms/crypto.js';
import { wordsKey } from '../../pieces/comms/crypto.js';
import { generateX25519Identity } from 'age-encryption';
import { CommsMessages } from './messages.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
async function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let now = '2026-11-14T18:00:00.000Z';
  const db = createDataSchema(client, () => now);
  for (const id of ['jonathan', 'owner']) db.insert(members).values({ id, role: 'member', joinedAt: now }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const key = wordsKey(await generateX25519Identity());
  const service = new CommsMessages(db, key, () => now);
  const thread = service.threads.open({ id: 'th:one', member: 'jonathan', agent: 'art', title: 'Pump' });
  return { db, client, key, service, thread, at: (v: string) => { now = v; } };
}

it('encrypts messages, deduplicates concurrent client retries and indexes typed mentions at their latest sequence', async () => {
  const { db, service, thread } = await fixture();
  const input = { thread: thread.id, sender: 'jonathan', kind: 'message' as const, clientId: 'client-1', words: 'See t-12 github:owner/repo#7 and note:pump/order' };
  const [first, second] = await Promise.all([service.send(input), service.send(input)]);
  expect(first).toEqual(second);
  expect(first.seq).toBe(1);
  expect(first.keepUntil).toBe('2026-11-28T18:00:00.000Z');
  expect(first.words?.includes(Buffer.from('See t-12'))).toBe(false);
  expect(await service.words(thread.id, 1)).toBe(input.words);
  expect(db.select().from(inbox).all()).toMatchObject([{ words: null, thread: thread.id, messageSeq: 1, member: 'jonathan', to: 'art' }]);
  expect(db.select().from(threadRefs).all().map(r => r.ref).sort()).toEqual(['github:owner/repo#7', 'note:pump/order', 't-12']);
  await service.send({ ...input, clientId: 'client-2', words: 't-12 again' });
  expect(db.select().from(threadRefs).where(eq(threadRefs.ref, 't-12')).get()?.messageSeq).toBe(2);
  expect(db.select().from(inbox).all().map(r => r.seq)).toEqual([1, 2]);
});

it('keeps private question details and answer text out of every plaintext Inbox column', async () => {
  const { db, service, thread } = await fixture();
  const question = { words: 'Buy the private pump?', answers: 'yes-no' as const, why: 'Private reason', ifYes: 'Private yes', ifNo: 'Private no', link: 'https://example.test/private' };
  const ask = await service.ask(thread.id, 'art', 'ask-1', question);
  expect(await service.words(thread.id, ask.seq)).toBe(JSON.stringify(question));
  const item = service.threads.conversations.item(ask.inboxItem!);
  expect(item).toMatchObject({ words: null, why: null, ifYes: null, ifNo: null, link: null, answers: 'yes-no', thread: thread.id });
  expect(() => service.threads.conversations.answer(item.id, 'jonathan', 'words', 'Secret reply')).toThrow('encrypted Comms');
  const results = await Promise.all([service.answer(item.id, 'jonathan', 'words', 'Secret reply'), service.answer(item.id, 'owner', 'words', 'Other secret reply')]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({ answer: 'words', answerText: null, answeredBy: results[0].answeredBy });
  const rows = db.select().from(messages).all();
  expect(rows).toHaveLength(2);
  expect(['jonathan', 'owner']).toContain(results[0].answeredBy);
  expect(await service.words(thread.id, 2)).toBe(results[0].answeredBy === 'jonathan' ? 'Secret reply' : 'Other secret reply');
  expect(db.select().from(inbox).all()).toHaveLength(2);
  expect(db.select().from(inbox).where(eq(inbox.source, 'answer')).get()).toMatchObject({ sourceId: item.id, words: null, thread: thread.id, messageSeq: 2 });
  expect(JSON.stringify(db.select().from(inbox).all())).not.toContain('Private');
  expect(JSON.stringify(db.select().from(inbox).all())).not.toContain('Secret reply');
  expect(await service.answer(item.id, 'owner', 'yes')).toEqual(results[0]);
});

it('validates words answers and records yes/no verdict inline on the same round trip', async () => {
  const { db, service, thread } = await fixture();
  const ask = await service.ask(thread.id, 'art', 'ask', { words: 'Which?', answers: 'words' });
  await expect(service.answer(ask.inboxItem!, 'jonathan', 'yes')).rejects.toThrow('needs words');
  await expect(service.answer(ask.inboxItem!, 'jonathan', 'words', ' ')).rejects.toThrow('needs words');
  const yesNo = await service.ask(thread.id, 'art', 'ask-2', { words: 'Go?', answers: 'yes-no' });
  await service.answer(yesNo.inboxItem!, 'owner', 'yes');
  expect(db.select().from(messages).where(eq(messages.kind, 'answer')).get()).toMatchObject({ verdict: 'yes', sender: 'owner' });
});

it('rolls message, refs and question state back together if Inbox insertion fails', async () => {
  const { db, client, service, thread } = await fixture();
  client.exec("CREATE TRIGGER refuse_mail BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'mail unavailable'); END");
  await expect(service.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 't-12' })).rejects.toThrow('mail unavailable');
  expect(db.select().from(messages).all()).toHaveLength(0);
  expect(db.select().from(threadRefs).all()).toHaveLength(0);
  client.exec('DROP TRIGGER refuse_mail');
  const ask = await service.ask(thread.id, 'art', 'ask', { words: 'Go?', answers: 'yes-no' });
  client.exec("CREATE TRIGGER refuse_mail BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'mail unavailable'); END");
  await expect(service.answer(ask.inboxItem!, 'jonathan', 'yes')).rejects.toThrow('mail unavailable');
  expect(db.select().from(messages).all()).toHaveLength(1);
  expect(service.threads.conversations.item(ask.inboxItem!).state).toBe('waiting');
});

it('uses household retention, refuses expired reads before sweeping and preserves metadata after clearing ciphertext', async () => {
  const { db, service, thread, at } = await fixture();
  db.insert(household).values({ commsDays: 1 }).run();
  const row = await service.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 'Short lived' });
  expect(row.keepUntil).toBe('2026-11-15T18:00:00.000Z');
  at(row.keepUntil!);
  expect(await service.words(thread.id, row.seq)).toBeNull();
  expect(service.expire()).toBe(1);
  expect(service.expire()).toBe(0);
  expect(db.select().from(messages).get()).toMatchObject({ seq: 1, words: null, sender: 'jonathan', inboxItem: row.inboxItem });
  expect(db.select().from(inbox).get()?.state).toBe('waiting');
});

it('deletes ciphertext and refs, settles pending mail, leaves a tombstone and rejects delayed encrypted writes', async () => {
  const { db, key, service, thread } = await fixture();
  await service.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 't-12' });
  const ask = await service.ask(thread.id, 'art', 'ask', { words: 't-13?', answers: 'yes-no' });
  await service.answer(ask.inboxItem!, 'jonathan', 'yes');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed: WordsKey = { ...key, seal: async words => { await gate; return key.seal(words); } };
  const other = new CommsMessages(db, delayed, service.now);
  const pending = other.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 'Late' });
  service.delete(thread.id);
  release();
  await expect(pending).rejects.toThrow('Thread not found');
  service.delete(thread.id);
  expect(db.select().from(threads).all()).toHaveLength(0);
  expect(db.select().from(messages).all()).toHaveLength(0);
  expect(db.select().from(threadRefs).all()).toHaveLength(0);
  expect(db.select().from(inboxRefs).all()).toHaveLength(0);
  expect(db.select().from(deletedThreads).get()?.conversation).toBe(thread.conversation);
  expect(db.select().from(inbox).all().every(row => row.thread === null && row.messageSeq === null)).toBe(true);
  expect(db.select().from(inbox).where(and(eq(inbox.source, 'answer'), eq(inbox.state, 'resolved'))).get()).toBeDefined();
  expect(() => service.threads.open({ id: thread.id, member: 'jonathan', agent: 'art', title: 'Retry' })).toThrow('deleted');
});

it('never holds a transaction across crypto and rejects reads deleted while decryption is pending', async () => {
  const { db, client, key, service, thread } = await fixture();
  const row = await service.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 'Private' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const checked: WordsKey = { ...key,
    seal: async words => { expect(client.inTransaction).toBe(false); return key.seal(words); },
    open: async bytes => { expect(client.inTransaction).toBe(false); await gate; return key.open(bytes); },
  };
  const other = new CommsMessages(db, checked, service.now);
  const ask = await other.ask(thread.id, 'art', 'ask', { words: 'Go?', answers: 'yes-no' });
  expect(await other.ask(thread.id, 'art', 'ask', { words: 'Changed retry?', answers: 'words' })).toEqual(ask);
  await other.answer(ask.inboxItem!, 'jonathan', 'done');
  const pending = other.words(thread.id, row.seq);
  service.delete(thread.id);
  release();
  expect(await pending).toBeNull();
});

it('prepares encryption without effects and commits messages, questions and answers inside the caller transaction', async () => {
  const { db, client, key, service, thread } = await fixture();
  let seals = 0;
  const checked = new CommsMessages(db, { ...key, seal: async value => {
    expect(client.inTransaction).toBe(false);
    seals++;
    return key.seal(value);
  } }, service.now);
  const commitMessage = await checked.prepareSend({ thread: thread.id, sender: 'jonathan', kind: 'message', clientId: 'prepared', words: 'Private t-12' });
  const commitQuestion = await checked.prepareAsk(thread.id, 'art', 'prepared-ask', { words: 'Private question?', answers: 'words' });
  expect(db.select().from(messages).all()).toHaveLength(0);
  expect(db.select().from(inbox).all()).toHaveLength(0);
  expect(db.select().from(threadRefs).all()).toHaveLength(0);
  // A later operation error must roll back every effect, including mail/refs.
  expect(() => db.transaction(() => { commitMessage(); commitQuestion(); throw new Error('operation rejected'); })).toThrow('operation rejected');
  expect(db.select().from(messages).all()).toHaveLength(0);
  expect(db.select().from(inbox).all()).toHaveLength(0);
  expect(db.select().from(threadRefs).all()).toHaveLength(0);
  const question = db.transaction(() => { commitMessage(); return commitQuestion(); });
  const commitAnswer = await checked.prepareAnswer(question.inboxItem!, 'jonathan', 'words', 'Private answer');
  expect(service.threads.conversations.item(question.inboxItem!).state).toBe('waiting');
  expect(db.select().from(messages).all()).toHaveLength(2);
  expect(() => db.transaction(() => { commitAnswer(); throw new Error('receipt rejected'); })).toThrow('receipt rejected');
  expect(service.threads.conversations.item(question.inboxItem!).state).toBe('waiting');
  expect(db.select().from(messages).all()).toHaveLength(2);
  db.transaction(() => commitAnswer());
  expect(service.threads.conversations.item(question.inboxItem!).state).toBe('answered');
  expect(seals).toBe(3);
  expect(commitMessage().seq).toBe(1);
  expect(commitQuestion().seq).toBe(2);
  expect(commitAnswer().answer).toBe('words');
  expect(db.select().from(messages).all()).toHaveLength(3);
});

it('rechecks source state when a prepared commit is delayed or retried after deletion', async () => {
  const { service, thread } = await fixture();
  const input = { thread: thread.id, sender: 'jonathan', kind: 'message' as const, clientId: 'old', words: 'Private' };
  await service.send(input);
  const retry = await service.prepareSend(input);
  const ask = await service.ask(thread.id, 'art', 'old-ask', { words: 'Go?', answers: 'yes-no' });
  const askRetry = await service.prepareAsk(thread.id, 'art', 'old-ask', { words: 'Go?', answers: 'yes-no' });
  const answer = await service.prepareAnswer(ask.inboxItem!, 'jonathan', 'yes');
  service.delete(thread.id);
  expect(retry).toThrow('Thread not found');
  expect(askRetry).toThrow('Thread not found');
  expect(answer).toThrow('Not a private question');
});

it('records each committed Comms message as one wordless turn and records its speakers', async () => {
  const { db, service, thread } = await fixture();
  const sent = { thread: thread.id, sender: 'jonathan', kind: 'message' as const, clientId: 'one', words: 'Private request' };
  await Promise.all([service.send(sent), service.send(sent)]);
  await service.send({ thread: thread.id, sender: 'art', kind: 'card', clientId: 'card', run: 'run-1', tool: 'lookup', words: 'Private lookup', turn: { model: 'model-1', outcome: 'progressed' } });
  await service.send({ thread: thread.id, sender: 'art', kind: 'reply', run: 'run-1', words: 'Private reply', turn: { model: 'model-1', outcome: 'answered', latencyMs: 250 } });
  const ask = await service.ask(thread.id, 'art', 'ask-1', { words: 'Private question?', answers: 'words' });
  await service.answer(ask.inboxItem!, 'jonathan', 'words', 'Private answer');
  await service.answer(ask.inboxItem!, 'jonathan', 'words', 'Retry');
  await service.send({ thread: thread.id, sender: 'art', kind: 'notice', words: 'Private notice' });
  const recorded = db.select().from(turns).all();
  expect(recorded.map(r => [r.seq, r.kind, r.fromKind, r.fromId])).toEqual([
    [1, 'message', 'person', 'jonathan'], [2, 'action', 'agent', 'art'], [3, 'reply', 'agent', 'art'],
    [4, 'note', 'agent', 'art'], [5, 'message', 'person', 'jonathan'], [6, 'note', 'agent', 'art'],
  ]);
  expect(recorded[2]).toMatchObject({ run: 'run-1', model: 'model-1', outcome: 'answered', latencyMs: 250 });
  expect(JSON.stringify(recorded)).not.toContain('Private');
  expect(db.select().from(conversationPeople).all()).toEqual([
    { conversation: thread.conversation, whoKind: 'person', who: 'jonathan' },
    { conversation: thread.conversation, whoKind: 'agent', who: 'art' },
  ]);
  expect(db.select().from(conversations).where(eq(conversations.id, thread.conversation)).get()?.turnCount).toBe(6);
});
it('rolls wordless turns and speaker/count updates back with failed message delivery', async () => {
  const { db, client, service, thread } = await fixture();
  client.exec("CREATE TRIGGER refuse_mail BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'mail unavailable'); END");
  await expect(service.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 'Private' })).rejects.toThrow();
  expect(db.select().from(turns).all()).toEqual([]);
  expect(db.select().from(conversationPeople).all()).toEqual([]);
  expect(db.select().from(conversations).where(eq(conversations.id, thread.conversation)).get()?.turnCount).toBe(0);
});

it('uses actual stored expiry instants for private word reads and ciphertext sweeps', async () => {
  const { db, service, thread, key } = await fixture();
  const message = await service.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 'Expired by stored deadline' });
  db.update(messages).set({ keepUntil: '2026-11-14T18:00:00Z' }).run();
  const neverDecrypt = new CommsMessages(db, { ...key, open: async () => { throw new Error('Must not decrypt expired words'); } }, service.now);
  expect(await neverDecrypt.words(thread.id, message.seq)).toBeNull();
  expect(service.expire()).toBe(1);
  expect(db.select().from(messages).get()?.words).toBeNull();
});

it('applies a shortened household deadline to existing word reads and ciphertext sweeps independently of stored expiry', async () => {
  const { db, service, thread, key, at } = await fixture();
  const message = await service.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 'Shortened retention' });
  at('2026-11-16T18:00:00.000Z');
  db.insert(household).values({ commsDays: 1 }).run();
  expect(message.keepUntil).toBe('2026-11-28T18:00:00.000Z');
  const neverDecrypt = new CommsMessages(db, { ...key, open: async () => { throw new Error('Must not decrypt household-expired words'); } }, service.now);
  expect(await neverDecrypt.words(thread.id, message.seq)).toBeNull();
  expect(service.expire()).toBe(1);
  expect(db.select().from(messages).get()?.words).toBeNull();
});
it.each(['household', 'stored'] as const)('withholds words when the %s retention deadline expires during decryption', async deadline => {
  const { db, service, thread, key, at } = await fixture();
  const message = await service.send({ thread: thread.id, sender: 'jonathan', kind: 'message', words: 'Expires during open' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const gated = new CommsMessages(db, { ...key, open: async blob => { await gate; return key.open(blob); } }, service.now);
  const reading = gated.words(thread.id, message.seq);
  if (deadline === 'household') { db.insert(household).values({ commsDays: 1 }).run(); at('2026-11-16T18:00:00.000Z'); }
  else at(message.keepUntil!);
  expect(db.select().from(messages).get()?.words).not.toBeNull();
  release(); expect(await reading).toBeNull();
});
