import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../clock.js';
import { Operations, type Change } from '../operations/index.js';
import { createDataSchema } from '../data/database.js';
import { OperationResults } from '../data/operation-results.js';
import { DataWrites } from '../data/writes.js';
import { actionResults, agents, inbox, inboxReads, members, messages, operationResults, threads } from '../data/schema.js';
import { CommsMessages } from './messages.js';
import { registerConversationOperations, type ConversationAccess } from './operations.js';
import type { Viewer } from '../../policy.js';

const clients: Database.Database[] = [], dispatchers: Operations[] = [];
afterEach(() => { for (const op of dispatchers.splice(0)) op.close(); for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const statements: string[] = [];
  const client = new Database(':memory:', { verbose: s => statements.push(s) }); clients.push(client);
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  for (const id of ['jonathan', 'other']) db.insert(members).values({ id, role: 'member', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const changes: Change[][] = [], publicationTransactions: boolean[] = [];
  const operations = new Operations(client, clock, batch => { changes.push(batch); publicationTransactions.push(client.inTransaction); }, {
    receipts: new OperationResults(db), writes: new DataWrites(db, { refreshAccess() {}, changed() {} }), reportError(error) { throw error; },
  });
  dispatchers.push(operations);
  let encryptionGate: (() => Promise<void>) | undefined;
  let seals = 0;
  let allowed = true;
  const policyCalls: { viewer: Viewer; access: ConversationAccess }[] = [];
  const service = new CommsMessages(db, {
    async seal(words) { seals++; expect(client.inTransaction).toBe(false); await encryptionGate?.(); return Buffer.from(`sealed:${words}`); },
    async open(blob) { return Buffer.from(blob).toString().slice(7); },
    hash(words) { return createHmac('sha256', Buffer.alloc(32, 4)).update(words).digest('hex'); },
  }, now);
  registerConversationOperations(operations, service, { authorize(viewer, access) { policyCalls.push({ viewer, access }); return allowed; } });
  const viewer: Viewer = { kind: 'member', id: 'jonathan' };
  const call = (name: string, input: unknown, id: string, valid = () => true) => operations.callAsync('socket', viewer, name, input, id, true, valid);
  const thread = service.threads.open({ id: 'th:one', member: 'jonathan', agent: 'art', title: 'Pump' });
  return { client, db, clock, statements, service, operations,
    receipts: () => db.select().from(operationResults).all().map(row => ({ ...row, result: row.result.toString('utf8') })), changes, publicationTransactions, policyCalls, thread, call,
    seals: () => seals,
    gate: (fn: () => Promise<void>) => { encryptionGate = fn; }, allow: (value: boolean) => { allowed = value; } };
}

it('dispatches prepared encrypted messages with metadata-only receipts and postcommit changes', async () => {
  const f = fixture(), input = { thread: f.thread.id, clientId: 'client-1', words: 'private-message-sentinel t-12' };
  const first = await f.call('comms.send', input, 'send-1');
  expect(first).toMatchObject({ ok: true, value: { thread: f.thread.id, seq: 1, item: expect.any(String) } });
  expect(await f.call('comms.send', input, 'send-1')).toEqual(first);
  expect(f.db.select().from(messages).all()).toHaveLength(1);
  expect(f.db.select().from(inbox).all()).toMatchObject([{ words: null, messageSeq: 1 }]);
  expect(JSON.stringify(f.receipts())).not.toContain('private-message-sentinel');
  expect(f.client.prepare('SELECT input_hash FROM operation_results').get()).toEqual({
    input_hash: f.service.key.hash(`conversation-operation\0${JSON.stringify({ clientId: input.clientId, thread: input.thread, words: input.words })}`),
  });
  expect(f.changes).toHaveLength(1);
  expect(f.changes[0].map(c => c.type)).toEqual(['threads', 'conversations', 'messages', 'inbox']);
  expect(f.publicationTransactions).toEqual([false]);
  expect(f.client.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'core_*'").all()).toEqual([]);
  f.allow(false);
  expect(await f.call('comms.send', input, 'send-1')).toMatchObject({ ok: false, code: 'denied' });
});

it('rejects an initially denied request before encryption starts', async () => {
  const f = fixture(); f.allow(false);
  expect(await f.call('comms.send', { thread: f.thread.id, clientId: 'one', words: 'secret' }, 'one')).toMatchObject({ ok: false, code: 'denied' });
  expect(f.seals()).toBe(0);
  expect(f.db.select().from(messages).all()).toEqual([]);
  expect(f.changes).toEqual([]);
});

it('refuses a different SQLite connection before registering any operation', () => {
  const first = fixture(), second = fixture();
  const operations = new Operations(first.client, new FakeClock(), () => {}, { receipts: new OperationResults(first.db) }); dispatchers.push(operations);
  expect(() => registerConversationOperations(operations, second.service, { authorize: () => true })).toThrow('shared connection');
  expect(operations.offered('socket')).toEqual([]);
});

it('rechecks authentication and current resource policy after encryption without committing or publishing', async () => {
  for (const ended of ['session', 'policy'] as const) {
    const f = fixture(); let release!: () => void, entered!: () => void, current = true;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    f.gate(() => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
    const pending = f.call('comms.send', { thread: f.thread.id, clientId: 'one', words: 'secret' }, 'one', () => current);
    await entering;
    expect(f.db.select().from(messages).all()).toEqual([]);
    if (ended === 'session') current = false; else f.allow(false);
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'denied' });
    expect(f.db.select().from(inbox).all()).toEqual([]);
    expect(f.receipts()).toEqual([]);
    expect(f.changes).toEqual([]);
  }
});

it('rolls prepared effects back when the operation receipt cannot commit', async () => {
  const f = fixture();
  f.client.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'receipt refused'); END");
  expect(await f.call('comms.send', { thread: f.thread.id, clientId: 'one', words: 'secret' }, 'one')).toMatchObject({ ok: false });
  expect(f.db.select().from(messages).all()).toEqual([]);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  expect(f.changes).toEqual([]);
});

it('answers private questions through the encrypted seam and never records words in generic receipts or Inbox', async () => {
  const f = fixture();
  const ask = await f.service.ask(f.thread.id, 'art', 'ask', { words: 'Private question', answers: 'words' });
  const input = { item: ask.inboxItem!, answer: 'words', words: 'private-answer-sentinel' };
  const result = await f.call('inbox.answer', input, 'answer');
  expect(result).toEqual({ ok: true, value: { saved: true } });
  expect(await f.call('inbox.answer', input, 'answer')).toEqual(result);
  expect(f.service.threads.conversations.item(input.item)).toMatchObject({ state: 'answered', answerText: null, answeredBy: 'jonathan' });
  expect(await f.service.words(f.thread.id, 2)).toBe(input.words);
  expect(JSON.stringify(f.receipts())).not.toContain(input.words);
  expect(JSON.stringify(f.db.select().from(inbox).all())).not.toContain(input.words);
  expect(f.db.select().from(inboxReads).all()).toEqual([]);
});

it('checks Inbox authorization before preparation and before replay of answers and read marks', async () => {
  const f = fixture();
  const ask = await f.service.ask(f.thread.id, 'art', 'ask', { words: 'Private question', answers: 'words' });
  const input = { item: ask.inboxItem!, answer: 'words', words: 'private reply' };
  f.allow(false);
  expect(await f.call('inbox.answer', input, 'answer')).toMatchObject({ code: 'denied' });
  expect(await f.call('inbox.read', { item: input.item }, 'read')).toMatchObject({ code: 'denied' });
  expect(f.seals()).toBe(1); // only the agent's original ask, no answer encryption
  expect(f.service.threads.conversations.item(input.item).state).toBe('waiting');
  expect(f.db.select().from(inboxReads).all()).toEqual([]);
  expect(f.receipts()).toEqual([]);
  f.allow(true);
  expect(await f.call('inbox.answer', input, 'answer')).toMatchObject({ ok: true });
  expect(await f.call('inbox.read', { item: input.item }, 'read')).toMatchObject({ ok: true });
  const changes = f.changes.length;
  f.allow(false);
  expect(await f.call('inbox.answer', input, 'answer')).toMatchObject({ code: 'denied' });
  expect(await f.call('inbox.read', { item: input.item }, 'read')).toMatchObject({ code: 'denied' });
  expect(f.changes).toHaveLength(changes);
});

it('rechecks Inbox authorization after private-answer encryption without answering or publishing', async () => {
  const f = fixture();
  const ask = await f.service.ask(f.thread.id, 'art', 'ask', { words: 'Private question', answers: 'words' });
  let release!: () => void, entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  f.gate(() => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  const pending = f.call('inbox.answer', { item: ask.inboxItem!, answer: 'words', words: 'private reply' }, 'answer');
  await entering;
  f.allow(false); release();
  expect(await pending).toMatchObject({ code: 'denied' });
  expect(f.service.threads.conversations.item(ask.inboxItem!).state).toBe('waiting');
  expect(f.db.select().from(messages).all()).toHaveLength(1);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  expect(f.receipts()).toEqual([]);
  expect(f.changes).toEqual([]);
});

it('redirects task and approval answers to their source while ordinary answers use the shared Inbox', async () => {
  const f = fixture(), cvs = f.service.threads.conversations;
  for (const source of ['task', 'approval', 'secret-request', 'notice'] as const) {
    const item = cvs.send({ toKind: 'person', to: 'jonathan', source, sourceId: source, fromKind: 'agent', fromId: 'art', words: 'Proceed?', answers: 'yes-no' });
    const result = await f.call('inbox.answer', { item: item.id, answer: 'yes' }, source);
    expect(result.ok).toBe(source === 'notice');
    expect(cvs.item(item.id).state).toBe(source === 'notice' ? 'answered' : 'waiting');
  }
});

it('uses authenticated read marks and the metadata services for rename, pin, archive, stop and delete', async () => {
  const f = fixture();
  const item = f.service.threads.conversations.send({ toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'agent', words: 'Ready' });
  expect(await f.call('inbox.read', { item: item.id }, 'read')).toEqual({ ok: true, value: { saved: true } });
  expect(f.db.select().from(inboxReads).all()).toMatchObject([{ item: item.id, member: 'jonathan' }]);
  await f.service.send({ thread: f.thread.id, sender: 'jonathan', kind: 'message', words: 'One message' });
  f.service.threads.working(f.thread.id, true);
  for (const input of [{ change: 'rename', title: 'New name' }, { change: 'pin', pinned: true }, { change: 'archive', archived: true }, { change: 'read', seq: 100 }, { change: 'stop' }]) {
    expect(await f.call('comms.change', { thread: f.thread.id, ...input }, `change-${input.change}`)).toEqual({ ok: true, value: { saved: true } });
  }
  expect(f.service.threads.thread(f.thread.id)).toMatchObject({ title: 'New name', pinned: true, archivedAt: expect.any(String), readSeq: 1, stopRequested: true });
  expect(f.policyCalls.filter(c => c.access.action === 'change').map(c => c.access.action === 'change' ? c.access.change : '')).toEqual(expect.arrayContaining(['read', 'stop', 'rename', 'pin', 'archive']));
  expect(await f.call('comms.change', { thread: f.thread.id, change: 'delete' }, 'delete')).toEqual({ ok: true, value: { saved: true } });
  expect(f.db.select().from(threads).all()).toEqual([]);
});

it('requires signed-in window dispatch, rejects claimed senders and binds opens to the authenticated member', async () => {
  const f = fixture(), input = { thread: 'th:two', agent: 'art', title: 'Second' };
  // Without a window, a member is still the member; an agent is never one.
  expect(await f.operations.callAsync('socket', { kind: 'agent', id: 'art' }, 'comms.open', input, 'no-window', false)).toMatchObject({ code: 'denied' });
  expect(await f.operations.callAsync('http', { kind: 'member', id: 'jonathan' }, 'comms.open', input, 'open-http', true)).toMatchObject({ ok: true });
  expect(await f.operations.callAsync('socket', { kind: 'agent', id: 'art' }, 'comms.open', input, 'open', true)).toMatchObject({ code: 'denied' });
  expect(await f.call('comms.open', { ...input, member: 'other' }, 'spoof')).toMatchObject({ code: 'invalid' });
  expect(await f.call('comms.open', input, 'open')).toMatchObject({ ok: true, value: { thread: 'th:two' } });
  expect(f.service.threads.conversations.conversation(f.service.threads.thread('th:two').conversation).member).toBe('jonathan');
  expect(await f.call('comms.send', { thread: f.thread.id, clientId: 'spoof', words: 'secret', sender: 'other' }, 'spoof')).toMatchObject({ code: 'invalid' });
  expect(f.policyCalls.some(c => c.access.action === 'open' && c.access.member === 'jonathan')).toBe(true);
});

it('authorizes the current opened target on replay and refuses deleted or changed thread identities', async () => {
  const f = fixture(), input = { thread: 'th:two', agent: 'art', title: 'Second' };
  const first = await f.call('comms.open', input, 'open');
  expect(first.ok).toBe(true);
  expect(await f.call('comms.open', input, 'open')).toEqual(first);
  expect(f.policyCalls.at(-1)?.access).toMatchObject({ action: 'open', id: input.thread, existing: { thread: { id: input.thread }, conversation: { member: 'jonathan', agent: 'art' } } });
  f.allow(false);
  expect(await f.call('comms.open', input, 'open')).toMatchObject({ code: 'denied' });
  f.allow(true);
  expect(await f.call('comms.change', { thread: input.thread, change: 'delete' }, 'delete')).toMatchObject({ ok: true });
  expect(await f.call('comms.open', input, 'open')).toMatchObject({ code: 'denied' });
  expect(await f.call('comms.open', input, 'new-id')).toMatchObject({ code: 'denied' });
  expect(f.db.select().from(threads).all()).toHaveLength(1);
  const original = { thread: f.thread.id, agent: 'art', title: 'Pump' };
  expect(await f.call('comms.open', original, 'original')).toMatchObject({ ok: true });
  f.client.prepare('UPDATE conversations SET member=? WHERE id=?').run('other', f.thread.conversation);
  expect(await f.call('comms.open', original, 'original')).toMatchObject({ code: 'denied' });
});

it('dismisses only the signed-in member own action result through an authenticated window', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(actionResults).values([
    { id: 'mine', member: 'jonathan', at, ok: true, text: 'Saved', page: '/inbox' },
    { id: 'other', member: 'other', at, ok: false, text: 'Private outcome', page: '/inbox' },
  ]).run();
  for (const id of ['other', 'missing']) expect(await f.call('inbox.dismissResult', { id }, `deny-${id}`)).toMatchObject({ ok: false, code: 'denied' });
  for (const kind of ['agent', 'runner', 'service'] as const) expect(await f.operations.callAsync('socket', { kind, id: 'jonathan' }, 'inbox.dismissResult', { id: 'mine' }, `deny-${kind}`, true)).toMatchObject({ ok: false, code: 'denied' });
  expect(await f.operations.callAsync('socket', { kind: 'agent', id: 'art' }, 'inbox.dismissResult', { id: 'mine' }, 'no-window', false)).toMatchObject({ ok: false, code: 'denied' });
  expect(await f.call('inbox.dismissResult', { id: 'mine' }, 'expired', () => false)).toMatchObject({ ok: false, code: 'denied' });
  expect(f.db.select().from(actionResults).all().every(r => r.readAt === null)).toBe(true);
  const result = await f.call('inbox.dismissResult', { id: 'mine' }, 'dismiss');
  expect(result).toEqual({ ok: true, value: { saved: true } });
  expect(f.db.select().from(actionResults).where(eq(actionResults.id, 'mine')).get()?.readAt).toBe(at);
  expect(f.db.select().from(actionResults).where(eq(actionResults.id, 'other')).get()?.readAt).toBeNull();
  expect(f.changes).toEqual([[{ type: 'actionResults', id: 'mine' }]]); expect(f.publicationTransactions).toEqual([false]);
  f.clock.advance(1000);
  expect(await f.call('inbox.dismissResult', { id: 'mine' }, 'dismiss')).toEqual(result);
  expect(await f.call('inbox.dismissResult', { id: 'mine' }, 'dismiss-again')).toEqual(result);
  expect(f.db.select().from(actionResults).where(eq(actionResults.id, 'mine')).get()?.readAt).toBe(at);
  f.db.update(actionResults).set({ member: 'other' }).where(eq(actionResults.id, 'mine')).run();
  expect(await f.call('inbox.dismissResult', { id: 'mine' }, 'dismiss')).toMatchObject({ ok: false, code: 'denied' });
});
it('rolls action-result dismissal back if the shared operation receipt cannot commit', async () => {
  const f = fixture();
  f.db.insert(actionResults).values({ id: 'mine', member: 'jonathan', at: new Date(f.clock.now()).toISOString(), ok: true, text: 'Saved', page: '/inbox' }).run();
  f.client.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'receipt refused'); END");
  expect(await f.call('inbox.dismissResult', { id: 'mine' }, 'dismiss')).toMatchObject({ ok: false });
  expect(f.db.select().from(actionResults).get()?.readAt).toBeNull(); expect(f.changes).toEqual([]);
});

it('selects only the outcome ID during dismissal authorization and receipt replay', async () => {
  const f = fixture();
  f.db.insert(actionResults).values({ id: 'mine', member: 'jonathan', at: new Date(f.clock.now()).toISOString(), ok: false, text: 'Private failure details', page: '/inbox' }).run();
  for (const phase of ['initial', 'replay']) {
    f.statements.splice(0);
    expect(await f.call('inbox.dismissResult', { id: 'mine' }, 'dismiss')).toEqual({ ok: true, value: { saved: true } });
    const reads = f.statements.filter(s => /^\s*select\b/i.test(s) && s.includes('"action_results"'));
    expect(reads.length, phase).toBeGreaterThan(0);
    for (const query of reads) {
      expect(query, phase).not.toMatch(/"(?:text|page|ok|at|read_at)"/);
      expect(query.slice(0, query.toLowerCase().indexOf(' from ')), phase).not.toContain('*');
    }
  }
});
