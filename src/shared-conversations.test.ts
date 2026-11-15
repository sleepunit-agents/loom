import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { generateX25519Identity } from 'age-encryption';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, household, inbox, memberAgents, members, messages, operationResults, threads, tokens, sessions, turns } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { wordsKey } from './pieces/comms/crypto.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const client = new Database(':memory:'); cleanup.push(() => { if (client.open) client.close(); });
  const clock = new FakeClock(Date.parse('2026-11-14T18:00:00Z')), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  for (const [id, role] of [['alice','member'],['bob','member'],['owner','owner']] as const) db.insert(members).values({ id, role, joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const credentials = Object.fromEntries(['alice','bob','owner'].map((member, n) => {
    const token = String(n+1).repeat(64), cookie = String(n+4).repeat(64);
    db.insert(tokens).values({ fingerprint: hash(token), label: member, kind: 'owner', member, createdAt: now() }).run();
    db.insert(sessions).values({ id: hash(cookie), token: hash(token), device: 'Browser', via: 'token', isAgent: false, issuedAt: now(), seenAt: now(), provedAt: now() }).run();
    return [member, { token, cookie }];
  }));
  let seal: (() => Promise<void>) | undefined;
  const key = wordsKey(await generateX25519Identity());
  const errors: unknown[] = [];
  const root = sharedRoot({ db, clock, originAllowed: () => true, commsKey: { ...key, async seal(words) { await seal?.(); return key.seal(words); } }, reportError: error => errors.push(error) });
  cleanup.push(() => root.close());
  const post = (name: string, input: object, id: string, person = 'alice', bearer = false) => root.http.request(`/api/${name.replace('.','/')}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${credentials[person].token}` } : { cookie: `loom_ui=${credentials[person].cookie}` }) }, body: JSON.stringify({ input, id }),
  });
  const query = async (source: string, person = 'alice') => {
    const response = await root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `loom_ui=${credentials[person].cookie}` }, body: JSON.stringify({ query: source }) });
    return { response, body: await response.json() as { data?: Record<string, unknown>; errors?: unknown[] } };
  };
  return { client, db, clock, root, errors, credentials, post, query, gate: (fn: () => Promise<void>) => { seal = fn; } };
}
it('mounts actual shared private reads and cookie writes with metadata-only receipts and current ownership', async () => {
  const f = await fixture();
  expect(await (await f.post('comms.open', { thread: 'th:pump', agent: 'art', title: 'Pump' }, 'open')).json()).toMatchObject({ ok: true, value: { thread: 'th:pump' } });
  const input = { thread: 'th:pump', clientId: 'message-1', words: 'PRIVATE PERSON MESSAGE' };
  const sent = await (await f.post('comms.send', input, 'send')).json(); expect(sent).toMatchObject({ ok: true });
  expect(await (await f.post('comms.send', input, 'send')).json()).toEqual(sent);
  const query = '{homeComms{member agents} commsThreads{id} commsMessages(thread:"th:pump"){seq words wordsKeepUntil} inboxFolders{needs alerts all}}';
  const read = await f.query(query); expect(read.body.errors).toBeUndefined(); expect(JSON.stringify(read.body.data)).toContain('PRIVATE PERSON MESSAGE');
  expect((await f.query(query,'bob')).body.data?.commsThreads).toEqual([]);
  expect((await f.query('{commsThread(id:"th:pump"){id}}','owner')).body.data?.commsThread).toEqual({ id: 'th:pump' });
  expect((await f.post('comms.send', { ...input, clientId:'owner' }, 'owner-send','owner')).status).toBe(403);
  expect((await f.post('comms.send', { ...input, clientId:'bearer' }, 'bearer','alice',true)).status).toBe(403);
  expect(JSON.stringify(f.db.select().from(inbox).all())).not.toContain('PRIVATE PERSON MESSAGE');
  expect(JSON.stringify(f.db.select().from(operationResults).all())).not.toContain('PRIVATE PERSON MESSAGE');
  expect(f.db.select().from(messages).all()).toHaveLength(1);
  f.root.writes.run(() => f.db.delete(memberAgents).run());
  expect((await f.post('comms.send', input, 'send')).status).toBe(403);
  expect((await f.query(query)).body.data?.homeComms).toEqual({ member: 'alice', agents: [] });
  expect(f.errors).toEqual([]);
});
it('answers the same private Inbox item through real HTTP and denies other people or stale sessions', async () => {
  const f = await fixture(), comms = f.root.services.comms!;
  const thread = comms.threads.open({ member:'alice',agent:'art',title:'Pump' });
  const question = await comms.ask(thread.id,'art','ask',{words:'PRIVATE QUESTION',answers:'words'});
  expect((await f.post('inbox.answer',{item:question.inboxItem!,answer:'words',words:'PRIVATE ANSWER'},'other','bob')).status).toBe(403);
  expect((await f.post('inbox.read',{item:question.inboxItem!},'read')).status).toBe(200);
  expect((await f.post('inbox.answer',{item:question.inboxItem!,answer:'words',words:'PRIVATE ANSWER'},'answer')).status).toBe(200);
  const read = await f.query(`{inboxItem(id:"${question.inboxItem}"){read state body{words} answerText bodyKeepUntil answerKeepUntil}}`);
  expect(read.body.errors).toBeUndefined(); expect(read.body.data?.inboxItem).toMatchObject({read:true,state:'answered',body:{words:'PRIVATE QUESTION'},answerText:'PRIVATE ANSWER'});
  const durable = JSON.stringify([f.db.select().from(inbox).all(),f.db.select().from(operationResults).all()]);
  expect(durable).not.toContain('PRIVATE QUESTION'); expect(durable).not.toContain('PRIVATE ANSWER');
  f.root.writes.run(() => f.db.delete(sessions).where(eq(sessions.id,hash(f.credentials.alice.cookie))).run());
  expect((await f.post('inbox.answer',{item:question.inboxItem!,answer:'words',words:'PRIVATE ANSWER'},'answer')).status).toBe(401);
});
it('rechecks current ownership after private encryption yields and commits no stale effect or receipt', async () => {
  const f = await fixture();
  expect((await f.post('comms.open',{thread:'th:pump',agent:'art',title:'New conversation'},'open')).status).toBe(200);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.gate(() => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  const pending = f.post('comms.send',{thread:'th:pump',clientId:'message',words:'PRIVATE DELAYED'},'send');
  await waiting; f.root.writes.run(() => f.db.delete(memberAgents).run()); release();
  expect((await pending).status).toBe(403); expect(f.db.select().from(messages).all()).toEqual([]);
  expect(f.db.select().from(operationResults).where(eq(operationResults.id,'send')).all()).toEqual([]);
});
it('owns household-shortened expiry and daily history rollup, and removes its timer on close', async () => {
  const f = await fixture();
  expect((await f.post('comms.open',{thread:'th:pump',agent:'art',title:'New conversation'},'open')).status).toBe(200);
  expect((await f.post('comms.send',{thread:'th:pump',clientId:'message',words:'PRIVATE EXPIRING'},'send')).status).toBe(200);
  f.clock.advance(2*86400000);
  expect(f.db.select().from(messages).get()?.words).not.toBeNull();
  f.root.writes.run(() => f.db.insert(household).values({commsDays:1}).run());
  f.clock.advance(0); expect(f.db.select().from(messages).get()?.words).toBeNull();
  f.clock.advance(90*86400000);
  expect(f.db.select().from(turns).all()).toEqual([]);
  expect(f.client.prepare('SELECT messages FROM conversation_days').get()).toEqual({messages:1});
  await f.root.close(); f.client.close(); expect(() => f.clock.advance(100*86400000)).not.toThrow();
});
