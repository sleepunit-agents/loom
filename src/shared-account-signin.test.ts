import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { accountSignins, agents, boxes, inbox, jobs, memberAgents, members, modelAccounts, modelAccountBoxes, operationResults, tokens } from './core/data/schema.js';
import { OperationResults } from './core/data/operation-results.js';
import { DataWrites } from './core/data/writes.js';
import { Operations } from './core/operations/index.js';
import { registerSharedAccountSignIn } from './shared-account-signin.js';
import type { Viewer } from './policy.js';
import { sharedRoot } from './shared-root.js';
import { wordsKey } from './pieces/comms/crypto.js';
import { generateX25519Identity } from 'age-encryption';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const worker = 'a'.repeat(64), otherWorker = 'b'.repeat(64), owner = 'c'.repeat(64), stranger = 'd'.repeat(64);
async function fixture(before: (db: ReturnType<typeof createDataSchema>) => void = () => {}) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values([{ id: 'member', role: 'owner', joinedAt: now() }, { id: 'stranger', role: 'member', joinedAt: now() }]).run();
  for (const id of ['box', 'other']) db.insert(boxes).values({ id, owner: 'member', name: id === 'box' ? 'the art box' : 'another', sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: now() }).run();
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');
  db.insert(tokens).values([{ fingerprint: hash(worker), label: 'box', kind: 'runner', box: 'box', createdAt: now() }, { fingerprint: hash(otherWorker), label: 'other', kind: 'runner', box: 'other', createdAt: now() },
    { fingerprint: hash(owner), label: 'owner', kind: 'owner', member: 'member', createdAt: now() }, { fingerprint: hash(stranger), label: 'stranger', kind: 'owner', member: 'stranger', createdAt: now() }]).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'member', provider: 'provider', label: 'Codex subscription', hasRoom: false }).run();
  before(db);
  const commsKey = wordsKey(await generateX25519Identity()), start = () => sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {}, modelRoles: () => [], commsKey });
  let root = start(), n = 0; cleanup.push(() => root.close());
  /** The program stops and starts again on the same database. */
  const restart = async () => { await root.close(); root = start(); };
  const call = async (key: string, name: string, input: unknown = {}, id = 'call-' + ++n) => {
    const reply = await root.http.request('/api/' + name.replace('.', '/'), { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ id, input }) });
    return { status: reply.status, ...(await reply.json() as { ok: boolean; value?: any; code?: string; message?: string }) };
  };
  /** Every retry receipt as stored, to look for something that should not be kept. */
  const receipts = () => db.select().from(operationResults).all().map(row => row.operation + ' ' + row.result.toString('utf8')).join('\n');
  return { db, clock, call, receipts, restart, stored: (text: string) => db.$client.serialize().includes(Buffer.from(text)), item: (id: string) => db.select().from(inbox).where(eq(inbox.id, id)).get()!, row: (id: string) => db.select().from(accountSignins).where(eq(accountSignins.id, id)).get()! };
}

it('carries a page out and a code back, and records the sign-in only on the worker\'s word', async () => {
  const f = await fixture();
  expect((await f.call(stranger, 'runtime.accountSignIn', { account: 'account', box: 'box' })).ok).toBe(false);
  expect((await f.call(worker, 'runtime.accountSignIn', { account: 'account', box: 'box' })).ok).toBe(false);
  const asked = await f.call(owner, 'runtime.accountSignIn', { account: 'account', box: 'box' }); expect(asked.ok).toBe(true);
  const id = asked.value.id as string;
  // Asking again while one is open is the same request.
  expect((await f.call(owner, 'runtime.accountSignIn', { account: 'account', box: 'box' })).value.id).toBe(id);
  expect(f.row(id)).toMatchObject({ state: 'asked', askedByKind: 'member', askedBy: 'member' });
  // Only the worker of the machine named gets it, and only once.
  expect((await f.call(otherWorker, 'runtime.signInNext')).value).toBeNull();
  expect((await f.call(owner, 'runtime.signInNext')).ok).toBe(false);
  expect((await f.call(worker, 'runtime.signInNext')).value).toEqual({ id, account: 'account', owner: 'member', provider: 'provider' });
  expect((await f.call(worker, 'runtime.signInNext')).value).toBeNull();
  for (const [name, input] of [['runtime.signInCode', { id, take: 'take' }], ['runtime.signInTake', { id }], ['runtime.signInDone', { id, signedIn: true }]] as const) expect((await f.call(otherWorker, name, input)).ok).toBe(false);
  expect((await f.call(worker, 'runtime.signInPage', { id, link: 'http://not-https.example/x' })).ok).toBe(false);
  expect((await f.call(worker, 'runtime.signInPage', { id, link: 'https://provider.example/oauth?state=1' })).ok).toBe(true);
  const item = f.item(f.row(id).item!);
  expect(item).toMatchObject({ toKind: 'person', to: 'member', member: 'member', source: 'notice', state: 'waiting', answers: 'words', link: 'https://provider.example/oauth?state=1',
    words: 'Sign Codex subscription in on the art box. Open the page, sign in, then answer with the code it shows.' });
  expect((await f.call(owner, 'runtime.accountSignInStatus', { id })).value).toEqual({ state: 'waiting', why: null, item: item.id });
  expect((await f.call(stranger, 'runtime.accountSignInStatus', { id })).ok).toBe(false);
  expect((await f.call(worker, 'runtime.signInCode', { id, take: 'take' })).value).toEqual({ code: null, stop: false, answered: false });
  expect((await f.call(worker, 'runtime.signInTake', { id }, 'early')).value).toEqual({ taken: false });
  // The owner answers the inbox item with the code the page showed; a stranger cannot.
  expect((await f.call(stranger, 'inbox.answer', { item: item.id, answer: 'words', words: '4/0AbCdEf_code-123' })).ok).toBe(false);
  const answered = await f.call(owner, 'inbox.answer', { item: item.id, answer: 'words', words: '4/0AbCdEf_code-123' }); expect(answered).toMatchObject({ ok: true });
  // There is a code to take; the worker takes it, and reads what it took.
  expect((await f.call(worker, 'runtime.signInCode', { id, take: 'take' })).value).toEqual({ code: null, stop: false, answered: true });
  expect((await f.call(worker, 'runtime.signInTake', { id }, 'take')).value).toEqual({ taken: true });
  expect(f.item(item.id).answerText).toBe('(used)');
  expect((await f.call(worker, 'runtime.signInCode', { id, take: 'take' })).value).toEqual({ code: '4/0AbCdEf_code-123', stop: false, answered: true });
  expect(f.db.select().from(modelAccountBoxes).all()).toEqual([]);
  expect((await f.call(worker, 'runtime.signInDone', { id, signedIn: true })).ok).toBe(true);
  expect(f.db.select().from(modelAccountBoxes).all()).toEqual([{ account: 'account', box: 'box' }]);
  expect((await f.call(owner, 'runtime.accountSignInStatus', { id })).value).toMatchObject({ state: 'done', why: null });
  expect((await f.call(worker, 'runtime.signInCode', { id, take: 'take' })).value).toEqual({ code: null, stop: true, answered: false });
  // A finished request is finished: a new ask is a new request.
  expect((await f.call(owner, 'runtime.accountSignIn', { account: 'account', box: 'box' })).value.id).not.toBe(id);
});
it('shows a device code with nothing to answer, and clears the item when the worker reports', async () => {
  const f = await fixture(), id = (await f.call(owner, 'runtime.accountSignIn', { account: 'account', box: 'box' })).value.id as string;
  await f.call(worker, 'runtime.signInNext');
  expect((await f.call(worker, 'runtime.signInPage', { id, link: 'https://auth.example/device', userCode: 'ABCD-12345' })).ok).toBe(true);
  const item = f.item(f.row(id).item!);
  expect(item).toMatchObject({ answers: null, state: 'waiting', link: 'https://auth.example/device' }); expect(item.words).toContain('enter the code ABCD-12345');
  expect((await f.call(worker, 'runtime.signInDone', { id, signedIn: false, why: 'unsaid' })).ok).toBe(true);
  expect(f.item(item.id)).toMatchObject({ state: 'resolved', resolution: 'The provider\'s program says the account is not signed in' });
  expect(f.row(id)).toMatchObject({ state: 'failed', why: 'The provider\'s program says the account is not signed in' }); expect(f.db.select().from(modelAccountBoxes).all()).toEqual([]);
});
it('ends a request nobody finished, refuses a pasted answer that is not a code, and never hands a late request to a worker', async () => {
  const f = await fixture(), id = (await f.call(owner, 'runtime.accountSignIn', { account: 'account', box: 'box' })).value.id as string;
  f.clock.advance(21 * 60_000);
  expect((await f.call(owner, 'runtime.accountSignInStatus', { id })).value.state).toBe('failed');
  expect((await f.call(worker, 'runtime.signInNext')).value).toBeNull(); expect(f.row(id)).toMatchObject({ state: 'failed', why: 'It ran out of time' });
  const second = (await f.call(owner, 'runtime.accountSignIn', { account: 'account', box: 'box' })).value.id as string; expect(second).not.toBe(id);
  await f.call(worker, 'runtime.signInNext'); await f.call(worker, 'runtime.signInPage', { id: second, link: 'https://provider.example/x' });
  await f.call(owner, 'inbox.answer', { item: f.row(second).item!, answer: 'words', words: 'sure, one moment; rm -rf' });
  expect((await f.call(worker, 'runtime.signInCode', { id: second, take: 'take' })).value).toEqual({ code: null, stop: true, answered: false });
  expect((await f.call(worker, 'runtime.signInTake', { id: second }, 'take')).value).toEqual({ taken: false });
  // The worker reports its own reason for stopping; loom knows the better one.
  await f.call(worker, 'runtime.signInDone', { id: second, signedIn: false, why: 'ended' });
  expect(f.row(second)).toMatchObject({ state: 'failed', why: 'That did not look like a sign-in code' });
  expect(f.item(f.row(second).item!)).toMatchObject({ answerText: '(used)' });
});
const code = '4/0AbCdEf_code-123';
async function waitingWithCode(f: Awaited<ReturnType<typeof fixture>>) {
  const id = (await f.call(owner, 'runtime.accountSignIn', { account: 'account', box: 'box' })).value.id as string;
  await f.call(worker, 'runtime.signInNext'); await f.call(worker, 'runtime.signInPage', { id, link: 'https://provider.example/x' });
  const item = f.row(id).item!;
  expect((await f.call(owner, 'inbox.answer', { item, answer: 'words', words: code })).ok).toBe(true);
  return { id, item };
}
it('hands the code to one take: that taker may ask again, nobody else gets it, and it leaves the database when taken', async () => {
  const f = await fixture(), { id, item } = await waitingWithCode(f);
  expect(f.stored(code)).toBe(true);
  expect((await f.call(worker, 'runtime.signInTake', { id }, 'take-1')).value).toEqual({ taken: true });
  expect(f.stored(code)).toBe(false); expect(f.item(item).answerText).toBe('(used)');
  // The reply to the take was lost: the same write again is the same take.
  expect((await f.call(worker, 'runtime.signInTake', { id }, 'take-1')).value).toEqual({ taken: true });
  // The reply with the code was lost: the taker reads again.
  for (let n = 0; n < 2; n++) expect((await f.call(worker, 'runtime.signInCode', { id, take: 'take-1' })).value).toEqual({ code, stop: false, answered: true });
  // The same machine's token without the take, a second worker process or a copy of the token, gets nothing.
  expect((await f.call(worker, 'runtime.signInTake', { id }, 'take-2')).value).toEqual({ taken: false });
  expect((await f.call(worker, 'runtime.signInCode', { id, take: 'take-2' })).value).toEqual({ code: null, stop: true, answered: false });
  expect((await f.call(otherWorker, 'runtime.signInCode', { id, take: 'take-1' })).ok).toBe(false);
  expect(f.receipts()).not.toContain(code); expect(f.receipts()).not.toContain('runtime.signInCode');
  await f.call(worker, 'runtime.signInDone', { id, signedIn: true });
  expect((await f.call(worker, 'runtime.signInCode', { id, take: 'take-1' })).value).toEqual({ code: null, stop: true, answered: false });
  expect(f.receipts()).not.toContain(code); expect(f.stored(code)).toBe(false);
});
it('forgets a taken code when the program restarts: the taker is told to stop, and no later take gets it', async () => {
  const f = await fixture(), { id } = await waitingWithCode(f);
  expect((await f.call(worker, 'runtime.signInTake', { id }, 'take-1')).value).toEqual({ taken: true });
  await f.restart();
  expect((await f.call(worker, 'runtime.signInTake', { id }, 'take-1')).value).toEqual({ taken: true });      // its receipt
  expect((await f.call(worker, 'runtime.signInCode', { id, take: 'take-1' })).value).toEqual({ code: null, stop: true, answered: false });
  expect((await f.call(worker, 'runtime.signInTake', { id }, 'take-2')).value).toEqual({ taken: false });
  await f.call(worker, 'runtime.signInDone', { id, signedIn: false, why: 'ended' });
  expect(f.row(id)).toMatchObject({ state: 'failed', why: 'The sign-in was ended before it finished' });
});
it('stores loom\'s own sentence for a worker\'s reason word, and none of any other text a worker sends', async () => {
  const f = await fixture(), leak = 'token sk-PRIVATE-0123456789 was rejected';
  for (const [why, sentence] of [['wrong-code', 'The provider did not accept the code'], ['no-program', 'This machine has no sign-in program for this provider'],
    [leak, 'The sign-in did not finish'], ['constructor', 'The sign-in did not finish'], [undefined, 'The sign-in did not finish']] as const) {
    const { id } = await waitingWithCode(f);
    expect((await f.call(worker, 'runtime.signInDone', { id, signedIn: false, ...(why === undefined ? {} : { why }) })).ok).toBe(true);
    expect(f.row(id)).toMatchObject({ state: 'failed', why: sentence });
  }
  expect(f.stored('PRIVATE')).toBe(false);
});
it('blanks an answered code the worker never collected, when the sign-in fails or runs out of time', async () => {
  const f = await fixture(), failed = await waitingWithCode(f);
  expect(f.item(failed.item).answerText).toBe(code);
  await f.call(worker, 'runtime.signInDone', { id: failed.id, signedIn: false, why: 'stopped' });
  expect(f.item(failed.item)).toMatchObject({ answerText: '(used)', state: 'answered' }); expect(f.row(failed.id)).toMatchObject({ state: 'failed', why: 'The worker stopped' });
  const late = await waitingWithCode(f);
  f.clock.advance(21 * 60_000);
  // Out of time: the worker is told to stop without the code, and the next sweep blanks it.
  expect((await f.call(worker, 'runtime.signInCode', { id: late.id, take: 'take' })).value).toEqual({ code: null, stop: true, answered: false });
  expect((await f.call(worker, 'runtime.signInNext')).value).toBeNull();
  expect(f.item(late.item).answerText).toBe('(used)'); expect(f.row(late.id)).toMatchObject({ state: 'failed', why: 'It ran out of time' });
});
it('closes a sign-in that ran out of time on the program\'s own tick, with no worker polling and nobody asking', async () => {
  const f = await fixture(), late = await waitingWithCode(f);
  // Past the sign-in's twenty minutes, and across at least one of the runtime's sweeps.
  f.clock.advance(21 * 60_000);
  expect(f.row(late.id)).toMatchObject({ state: 'failed', why: 'It ran out of time' });
  expect(f.item(late.item)).toMatchObject({ answerText: '(used)', state: 'answered' });
});
it('drops, at start, the receipts an earlier version kept for the code and closes what ran out of time while it was down', async () => {
  const f = await fixture(db => {
    db.insert(operationResults).values([{ caller: 'worker', id: 'old', operation: 'runtime.signInCode', inputHash: 'x', result: Buffer.from(JSON.stringify({ ok: true, value: { code, stop: false } })), expiresAt: '2999-01-01T00:00:00.000Z' },
      { caller: 'worker', id: 'kept', operation: 'runtime.signInDone', inputHash: 'x', result: Buffer.from('{"ok":true,"value":{"saved":true}}'), expiresAt: '2999-01-01T00:00:00.000Z' }]).run();
    db.insert(accountSignins).values({ id: 'signin-stale', account: 'account', box: 'box', askedByKind: 'member', askedBy: 'member', state: 'asked', askedAt: '2000-01-01T00:00:00.000Z', changedAt: '2000-01-01T00:00:00.000Z' }).run();
  });
  expect(f.db.select({ id: operationResults.id }).from(operationResults).all()).toEqual([{ id: 'kept' }]);
  expect(f.row('signin-stale')).toMatchObject({ state: 'failed', why: 'It ran out of time' });
});
it('lets an agent ask only with the authority of the member its current work is for', () => {
  const client = new Database(':memory:'), clock = new FakeClock(), now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values([{ id: 'member', role: 'owner', fullOwner: true, joinedAt: now() }, { id: 'guest', role: 'member', joinedAt: now() },
    // A household owner who does not have the agent: the role alone gives a body nothing of theirs.
    { id: 'second', role: 'owner', joinedAt: now() }]).run();
  db.insert(boxes).values({ id: 'box', owner: 'member', name: 'box', sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: now() }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'member', provider: 'provider', label: 'Subscription', hasRoom: false }).run();
  db.insert(agents).values({ id: 'bot', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  // The guest and the first owner have the agent; that owner owns the account and the machine.
  db.insert(memberAgents).values([{ member: 'guest', agent: 'bot' }, { member: 'member', agent: 'bot' }]).run();
  const job = (id: string, member: string | null) => db.insert(jobs).values({ id, agent: 'bot', box: 'box', member, title: '', state: 'running', brief: '', model: 'm', startedByKind: 'agent', startedBy: 'bot', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: now() }).run();
  job('for-guest', 'guest'); job('for-owner', 'member'); job('for-nobody', null); job('for-second', 'second');
  const operations = new Operations(client, clock, () => {}, { receipts: new OperationResults(db), writes: new DataWrites(db, { refreshAccess() {}, changed() {} }), reportError: () => {} });
  cleanup.push(() => operations.close(), () => { client.close(); });
  const work = new WeakMap<Viewer, string>();
  registerSharedAccountSignIn(operations, db, now, () => undefined, viewer => { const found = work.get(viewer); return found ? { job: found } : undefined; });
  let n = 0;
  // The viewer is what the credential resolves to: a body's names the member its job is for (currentToken).
  const body = (on?: string): Viewer => {
    const member = on ? db.select({ member: jobs.member }).from(jobs).where(eq(jobs.id, on)).get()?.member : null;
    const viewer: Viewer = { kind: 'agent', id: 'bot', ...(member ? { workingFor: member } : {}) }; if (on) work.set(viewer, on);
    return viewer;
  };
  const ask = (on?: string) => operations.call('http', body(on), 'runtime.accountSignIn', { account: 'account', box: 'box' }, 'ask-' + ++n);
  expect(ask('for-guest')).toMatchObject({ ok: false, code: 'denied' });
  expect(ask('for-nobody')).toMatchObject({ ok: false, code: 'denied' });
  expect(ask()).toMatchObject({ ok: false, code: 'denied' });
  // The member could ask themselves, but the agent is not on their list: its body acts on nobody's word.
  expect(operations.call('http', { kind: 'member', id: 'second' }, 'runtime.accountSignIn', { account: 'account', box: 'box' }, 'second-asks')).toMatchObject({ ok: true });
  db.delete(accountSignins).run();
  expect(ask('for-second')).toMatchObject({ ok: false, code: 'denied' });
  const asked = ask('for-owner'); expect(asked).toMatchObject({ ok: true });
  const id = (asked as { value: { id: string } }).value.id;
  expect(db.select().from(accountSignins).where(eq(accountSignins.id, id)).get()).toMatchObject({ askedByKind: 'agent', askedBy: 'bot' });
  const status = (on: string) => operations.call('http', body(on), 'runtime.accountSignInStatus', { id });
  expect(status('for-owner')).toMatchObject({ ok: true }); expect(status('for-guest')).toMatchObject({ ok: false, code: 'denied' });
  expect(status('for-second')).toMatchObject({ ok: false, code: 'denied' });
  // Once the member no longer has the agent, the body that was asking for them can ask and read nothing.
  db.delete(memberAgents).where(eq(memberAgents.member, 'member')).run();
  expect(status('for-owner')).toMatchObject({ ok: false, code: 'denied' }); expect(ask('for-owner')).toMatchObject({ ok: false, code: 'denied' });
});
