import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { workerProgram } from './runtime/worker-program.js';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { boxes, members, modelAccounts, modelAccountBoxes, modelAccountWindows, tokens, operationResults, sessions } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { reportWorkerAccountUsage } from './runtime/worker-http.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'a'.repeat(64), other = 'b'.repeat(64), owner = 'c'.repeat(64);
function fixture() {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values({ id: 'member', role: 'owner', joinedAt: now() }).run();
  for (const id of ['worker', 'other']) db.insert(boxes).values({ id, owner: 'member', name: id, sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: now() }).run();
  for (const [key, box] of [[token, 'worker'], [other, 'other']]) db.insert(tokens).values({ fingerprint: createHash('sha256').update(key).digest('hex'), label: box, kind: 'runner', box, createdAt: now() }).run();
  db.insert(tokens).values({ fingerprint: createHash('sha256').update(owner).digest('hex'), label: 'owner', kind: 'owner', member: 'member', createdAt: now() }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'member', provider: 'provider', label: 'Account', hasRoom: false }).run();
  db.insert(modelAccountBoxes).values({ account: 'account', box: 'worker' }).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {} }); cleanup.push(() => root.close());
  const observation = { account: 'account', owner: 'member', provider: 'provider', windows: [{ name: 'week', usage: 0.2, readAt: now(), resetsAt: new Date(clock.now() + 3.5 * 86400_000).toISOString(), durationMs: 7 * 86400_000 }] };
  const call = (input: unknown = observation, id = 'report', key = token) => root.http.request('/api/runtime/accountUsage', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ id, input }) });
  return { client, db, root, clock, now, observation, call };
}
it('records a real worker HTTP observation and its receipt through the mounted root', async () => {
  const f = fixture();
  const result = await reportWorkerAccountUsage({ url: 'https://loom.example', token, signal: new AbortController().signal, fetch: async (input, init) => f.root.http.fetch(new Request(input, init)) }, f.observation);
  expect(result).toEqual({ recorded: true });
  expect(f.db.select().from(modelAccounts).get()).toMatchObject({ usage: 0.2, usageReadAt: f.now(), hasRoom: true });
  expect(f.db.select().from(modelAccountWindows).all()).toHaveLength(1);
  expect(f.db.select().from(operationResults).all()).toHaveLength(1);
  expect(f.client.inTransaction).toBe(false);
});
it('checks live machine, existing account membership and observed identity before effects and replay', async () => {
  const f = fixture();
  for (const [input, key] of [[f.observation, other], [f.observation, owner], [{ ...f.observation, owner: 'elsewhere' }, token], [{ ...f.observation, provider: 'elsewhere' }, token]] as const) expect((await f.call(input, 'denied', key)).status).toBe(403);
  expect(f.db.select().from(operationResults).all()).toEqual([]);
  expect((await f.call()).status).toBe(200);
  f.root.writes.run(() => f.db.delete(modelAccountBoxes).run());
  expect((await f.call()).status).toBe(403);
  f.db.insert(modelAccountBoxes).values({ account: 'account', box: 'worker' }).run();
  f.root.writes.run(() => f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'worker')).run());
  expect((await f.call()).status).toBe(401);
});
it('keeps newer windows, validates complete observations and rolls back when the receipt fails', async () => {
  const f = fixture(); expect((await f.call()).status).toBe(200);
  const old = { ...f.observation, windows: f.observation.windows.map(row => ({ ...row, usage: 0.9, readAt: new Date(f.clock.now() - 1000).toISOString() })) };
  expect(await (await f.call(old, 'old')).json()).toMatchObject({ value: { recorded: false } });
  expect((await f.call({ ...f.observation, windows: [{ ...f.observation.windows[0], usage: 1.1 }] }, 'invalid')).status).toBe(400);
  expect((await f.call({ ...f.observation, box: 'other' }, 'injected')).status).toBe(400);
  f.client.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect((await f.call({ ...f.observation, windows: [{ ...f.observation.windows[0], usage: 0.5 }] }, 'rollback')).status).toBe(503);
  expect(f.db.select().from(modelAccountWindows).get()?.usage).toBe(0.2);
  expect(f.db.select().from(modelAccounts).get()).toMatchObject({ usage: 0.2, usageReadAt: f.now(), hasRoom: true });
  expect(f.db.select().from(operationResults).all()).toHaveLength(2);
});

for (const column of ['owner', 'provider'] as const) it(`checks current ${column} before receipt replay`, async () => {
  const f = fixture(); expect((await f.call()).status).toBe(200);
  if (column === 'owner') f.db.insert(members).values({ id: 'peer', role: 'member', joinedAt: f.now() }).run();
  f.root.writes.run(() => f.db.update(modelAccounts).set({ [column]: column === 'owner' ? 'peer' : 'other-provider' }).run());
  expect((await f.call()).status).toBe(403);
  expect(f.db.select().from(operationResults).all()).toHaveLength(1);
});

it('refuses a runner cookie without the bearer machine proof', async () => {
  const f = fixture(), cookie = 'z'.repeat(64);
  f.db.insert(sessions).values({ id: createHash('sha256').update(cookie).digest('hex'), token: createHash('sha256').update(token).digest('hex'), device: 'Fixture', via: 'link', isAgent: true, issuedAt: f.now(), seenAt: f.now(), provedAt: f.now() }).run();
  const response = await f.root.http.request('/api/runtime/accountUsage', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui='+cookie }, body: JSON.stringify({ id: 'cookie-report', input: f.observation }) });
  expect(response.status).toBe(403); expect(f.db.select().from(operationResults).all()).toEqual([]);
  expect(f.db.select().from(modelAccountWindows).all()).toEqual([]);
});

it('rejects a retained-window regression even if the summary oldest reading advances', async () => {
  const f = fixture(), base = f.observation.windows[0], at = (delta: number) => new Date(f.clock.now()+delta).toISOString();
  const first = { ...f.observation, windows: [{ ...base, name: 'week', readAt: at(-1000) }, { ...base, name: 'short', readAt: at(-3000) }] };
  expect((await f.call(first)).status).toBe(200);
  const before = f.db.select().from(modelAccountWindows).all();
  const next = { ...f.observation, windows: [{ ...base, name: 'week', readAt: at(-2000), usage: 0.8 }, { ...base, name: 'short', readAt: at(-2000) }] };
  expect(await (await f.call(next, 'regressed')).json()).toMatchObject({ value: { recorded: false } });
  expect(f.db.select().from(modelAccountWindows).all()).toEqual(before);
});
it('rolls back semantically invalid observations before committing a receipt', async () => {
  const f = fixture(), before = f.db.select().from(modelAccounts).get();
  const invalid = { ...f.observation, windows: [{ ...f.observation.windows[0], readAt: new Date(Date.parse(f.observation.windows[0].resetsAt)+1).toISOString() }] };
  expect((await f.call(invalid)).status).toBe(503);
  expect(f.db.select().from(modelAccounts).get()).toEqual(before);
  expect(f.db.select().from(modelAccountWindows).all()).toEqual([]);
  expect(f.db.select().from(operationResults).all()).toEqual([]);
});

it('uses the default executable reporter through actual root authentication and ingestion', async () => {
  const f = fixture(), output = vi.fn();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => f.root.http.fetch(new Request(input, init)));
  cleanup.push(() => { fetcher.mockRestore(); });
  const config = { command: { command: '/fake/private-reader', args: [], cwd: '/fake', env: {} },
    account: { account: 'account', owner: 'member', provider: 'provider' }, report: { url: 'https://loom.example', tokenFile: '/token' } };
  const result = await workerProgram({ args: ['--account-usage', '/config'],
    read: async path => { if (path === '/config') return JSON.stringify(config); if (path === '/token') return token; throw Error('Unexpected read'); },
    on: () => {}, off: () => {}, output, error: text => { throw Error(text); },
    usage: () => async () => f.observation.windows,
  });
  expect(result).toBe(0); expect(fetcher).toHaveBeenCalledOnce(); expect(output).toHaveBeenCalledOnce();
  expect(f.db.select().from(modelAccountWindows).get()?.usage).toBe(0.2);
  expect(f.db.select().from(operationResults).get()?.operation).toBe('runtime.accountUsage');
});
