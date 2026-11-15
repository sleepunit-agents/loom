import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { recordAccountUsage, accountUsageUnavailable } from './runtime/account-usage.js';
import { refreshAccountWindows, recordAccountWindows } from './runtime/account-windows.js';
import { dataDatabase } from './core/data/database.js';
import { Operations } from './core/operations/index.js';
import { workerProgram } from './runtime/worker-program.js';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { boxes, members, modelAccounts, modelAccountBoxes, modelAccountWindows, tokens, operationResults, sessions, agents, memberAgents, agentBoxes, agentModels, agentRunSettings, jobs } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import type { ModelRole } from './runtime/placement.js';
import { reportWorkerAccountUsage } from './runtime/worker-http.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'a'.repeat(64), other = 'b'.repeat(64), owner = 'c'.repeat(64);
function fixture(roles: readonly ModelRole[] = []) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values({ id: 'member', role: 'owner', joinedAt: now() }).run();
  for (const id of ['worker', 'other']) db.insert(boxes).values({ id, owner: 'member', name: id, sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: now() }).run();
  for (const [key, box] of [[token, 'worker'], [other, 'other']]) db.insert(tokens).values({ fingerprint: createHash('sha256').update(key).digest('hex'), label: box, kind: 'runner', box, createdAt: now() }).run();
  db.insert(tokens).values({ fingerprint: createHash('sha256').update(owner).digest('hex'), label: 'owner', kind: 'owner', member: 'member', createdAt: now() }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'member', provider: 'provider', label: 'Account', hasRoom: false }).run();
  db.insert(modelAccountBoxes).values({ account: 'account', box: 'worker' }).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {}, modelRoles: () => roles }); cleanup.push(() => root.close());
  const observation = { account: 'account', owner: 'member', provider: 'provider', windows: [{ name: 'week', usage: 0.2, readAt: now(), resetsAt: new Date(clock.now() + 3.5 * 86400_000).toISOString(), durationMs: 7 * 86400_000 }] };
  const readBases = new Map<string, string>();
  const call = async (input: unknown = observation, id = 'report', key = token) => {
    const value = input as typeof observation & { basis?: string };
    let witness = value.basis ?? readBases.get(id);
    if (!witness) {
      const reply = await (await operation('accountUsageBasis', { account: value.account, owner: value.owner, provider: value.provider }, id+'-basis', key)).json();
      witness = reply.value?.basis ?? '00000000-0000-4000-8000-000000000001'; readBases.set(id, witness!);
    }
    return root.http.request('/api/runtime/accountUsage', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ id, input: { ...value, basis: witness } }) });
  };
  const identity = { account: 'account', owner: 'member', provider: 'provider' };
  const operation = (name: string, input: unknown = identity, id = name, key = token) => root.http.request('/api/runtime/'+name, { method: 'POST', headers: { authorization: 'Bearer '+key, 'content-type': 'application/json' }, body: JSON.stringify({ id, input }) });
  const basis = async () => (await (await operation('accountUsageBasis')).json()).value.basis as string;
  return { client, db, root, clock, now, observation, call, operation, basis, identity };
}
it('records a real worker HTTP observation and its receipt through the mounted root', async () => {
  const f = fixture();
  const result = await reportWorkerAccountUsage({ url: 'https://loom.example', token, signal: new AbortController().signal, fetch: async (input, init) => f.root.http.fetch(new Request(input, init)) }, { ...f.observation, basis: await f.basis() });
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
  const response = await f.root.http.request('/api/runtime/accountUsage', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui='+cookie }, body: JSON.stringify({ id: 'cookie-report', input: { ...f.observation, basis: await f.basis() } }) });
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
  expect(result).toBe(0); expect(fetcher).toHaveBeenCalledTimes(2); expect(output).toHaveBeenCalledOnce();
  expect(f.db.select().from(modelAccountWindows).get()?.usage).toBe(0.2);
  expect(f.db.select().from(operationResults).get()?.operation).toBe('runtime.accountUsage');
});

it('latches a current failed read without fabricating a usage timestamp or erasing windows', async () => {
  const f = fixture(); await f.call(); const before = f.db.select().from(modelAccounts).get(), windows = f.db.select().from(modelAccountWindows).all();
  const response = await f.operation('accountUnavailable', { ...f.identity, basis: await f.basis() });
  expect(await response.json()).toMatchObject({ value: { recorded: true } });
  expect(f.db.select().from(modelAccounts).get()).toEqual({ ...before, hasRoom: false });
  expect(f.db.select().from(modelAccountWindows).all()).toEqual(windows);
});
it('ignores an old failure after a newer success, including an identical provider observation', async () => {
  const f = fixture(); await f.call(); const basis = await f.basis();
  expect(await (await f.call(f.observation, 'same-success')).json()).toMatchObject({ value: { recorded: true } });
  expect(await (await f.operation('accountUnavailable', { ...f.identity, basis })).json()).toMatchObject({ value: { recorded: false } });
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
});
it('keeps failure and success receipt replay from relatching a recovered account', async () => {
  const f = fixture(); await f.call(); const failed = { ...f.identity, basis: await f.basis() };
  expect((await f.operation('accountUnavailable', failed)).status).toBe(200);
  await f.call(f.observation, 'recovered'); expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
  expect((await f.operation('accountUnavailable', failed)).status).toBe(200);
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
});
it('does not consume a failure witness or mutate quota when its receipt rolls back', async () => {
  const f = fixture(); await f.call(); const input = { ...f.identity, basis: await f.basis() };
  f.client.exec("CREATE TRIGGER reject_failure BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect((await f.operation('accountUnavailable', input)).status).toBe(503); expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
  f.client.exec('DROP TRIGGER reject_failure');
  expect(await (await f.operation('accountUnavailable', input, 'explicit-new-attempt')).json()).toMatchObject({ value: { recorded: true } });
});
it('runs default worker failure reporting through the actual root without leaking diagnostics', async () => {
  const f = fixture(); await f.call(); const output = vi.fn(), error = vi.fn();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => f.root.http.fetch(new Request(input, init))); cleanup.push(() => { fetcher.mockRestore(); });
  const config = { command: { command: '/fake/reader', args: [], cwd: '/fake', env: {} }, account: f.identity, report: { url: 'https://loom.example', tokenFile: '/token' } };
  expect(await workerProgram({ args: ['--account-usage', '/config'], read: async path => path === '/config' ? JSON.stringify(config) : token,
    on: () => {}, off: () => {}, output, error, usage: () => async () => { throw Error('provider credential diagnostic'); },
  })).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(2); expect(output).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledExactlyOnceWith('Worker stopped: invalid configuration or unavailable execution\n');
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(false);
});
it('refuses stale witnesses after a trusted quota edit and across root restart', async () => {
  const f = fixture(); await f.call(); const basis = await f.basis();
  f.root.writes.run(() => f.db.update(modelAccountWindows).set({ usage: 0.3 }).run());
  expect(await (await f.operation('accountUnavailable', { ...f.identity, basis })).json()).toMatchObject({ value: { recorded: false } });
  const old = await f.basis(); await f.root.close();
  const next = sharedRoot({ db: f.db, clock: f.clock, originAllowed: () => true, reportError: () => {} }); cleanup.push(() => next.close());
  const response = await next.http.request('/api/runtime/accountUnavailable', { method: 'POST', headers: { authorization: 'Bearer '+token, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'restart-failure', input: { ...f.identity, basis: old } }) });
  expect(await response.json()).toMatchObject({ value: { recorded: false } }); expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
});
it('requires current account scope for both witness and failure operations', async () => {
  const f = fixture(); await f.call(); const input = { ...f.identity, basis: await f.basis() };
  for (const name of ['accountUsageBasis', 'accountUnavailable']) {
    const value = name === 'accountUsageBasis' ? f.identity : input;
    for (const key of [other, owner]) expect((await f.operation(name, value, name+'-denied', key)).status).toBe(403);
    expect((await f.operation(name, { ...value, provider: 'other-provider' }, name+'-provider')).status).toBe(403);
  }
  f.root.writes.run(() => f.db.delete(modelAccountBoxes).run());
  expect((await f.operation('accountUnavailable', input)).status).toBe(403);
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
});
it('refuses fabricated witnesses without turning their presence into authority', async () => {
  const f = fixture(); await f.call();
  const response = await f.operation('accountUnavailable', { ...f.identity, basis: '00000000-0000-4000-8000-000000000001' });
  expect(await response.json()).toMatchObject({ value: { recorded: false } }); expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
  expect((await f.operation('accountUnavailable', { ...f.identity, basis: 'invalid' }, 'bad')).status).toBe(400);
});

it('does not let old success or failure receipt replays consume a current failure witness', async () => {
  const f = fixture(); await f.call(); const old = { ...f.identity, basis: await f.basis() };
  await f.operation('accountUnavailable', old, 'old-failure'); await f.call(f.observation, 'new-success');
  const current = { ...f.identity, basis: await f.basis() };
  await f.call(); await f.operation('accountUnavailable', old, 'old-failure');
  expect(await (await f.operation('accountUnavailable', current, 'current-failure')).json()).toMatchObject({ value: { recorded: true } });
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(false);
});

it('does not let an older success reopen quota after a newer failure', async () => {
  const f = fixture(); await f.call(); const basis = await f.basis();
  expect(await (await f.operation('accountUnavailable', { ...f.identity, basis }, 'new-failure')).json()).toMatchObject({ value: { recorded: true } });
  expect(await (await f.call({ ...f.observation, basis }, 'old-success')).json()).toMatchObject({ value: { recorded: false } });
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(false);
});
it('does not invalidate an active witness when a fresh success rolls back with its receipt', async () => {
  const f = fixture(); await f.call(); const basis = await f.basis();
  f.client.exec("CREATE TRIGGER reject_success BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect((await f.call({ ...f.observation, basis }, 'rolled-success')).status).toBe(503);
  f.client.exec('DROP TRIGGER reject_success');
  expect(await (await f.operation('accountUnavailable', { ...f.identity, basis })).json()).toMatchObject({ value: { recorded: true } });
});
it('requires a bearer machine proof for both witness and failure, not a runner cookie', async () => {
  const f = fixture(), cookie = 'q'.repeat(64), basis = await f.basis();
  f.db.insert(sessions).values({ id: createHash('sha256').update(cookie).digest('hex'), token: createHash('sha256').update(token).digest('hex'), device: 'Fixture', via: 'link', isAgent: true, issuedAt: f.now(), seenAt: f.now(), provedAt: f.now() }).run();
  for (const name of ['accountUsageBasis', 'accountUnavailable']) {
    const input = name === 'accountUsageBasis' ? f.identity : { ...f.identity, basis };
    expect((await f.root.http.request('/api/runtime/'+name, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui='+cookie }, body: JSON.stringify({ id: 'cookie-'+name, input }) })).status).toBe(403);
  }
});

it('refuses unwitnessed success reports before quota or receipt effects', async () => {
  const f = fixture(), before = f.db.select().from(modelAccounts).get();
  const response = await f.operation('accountUsage', f.observation, 'no-witness');
  expect(response.status).toBe(400); expect(f.db.select().from(modelAccounts).get()).toEqual(before);
  expect(f.db.select().from(modelAccountWindows).all()).toEqual([]); expect(f.db.select().from(operationResults).all()).toEqual([]);
});
it('rejects a successful completion whose persisted snapshot changed without cache invalidation', async () => {
  const f = fixture(); await f.call(); const basis = await f.basis();
  f.root.writes.run(() => f.db.update(modelAccountWindows).set({ usage: 0.3 }).run());
  const before = f.db.select().from(modelAccountWindows).all();
  expect(await (await f.call({ ...f.observation, basis }, 'edited-success')).json()).toMatchObject({ value: { recorded: false } });
  expect(f.db.select().from(modelAccountWindows).all()).toEqual(before);
});
it('clears retained failure witnesses on root shutdown before database access is possible', async () => {
  const registrations = vi.spyOn(Operations.prototype, 'register'); cleanup.push(() => { registrations.mockRestore(); });
  const f = fixture(), input = { ...f.identity, basis: await f.basis() };
  const operation = registrations.mock.calls.map(call => call[0]).find(value => value.name === 'runtime.accountUnavailable')!;
  const auth = f.root.credentials.authenticate(new Request('http://loom', { headers: { authorization: 'Bearer '+token } }))!;
  await f.root.close();
  const sql = vi.spyOn(f.client, 'prepare').mockImplementation(() => { throw Error('SQL after closed admission'); });
  try {
    // Retain the registered synchronous callback to test cache disposal itself,
    // independently of the outer admission gate (which is tested below).
    expect(operation.run({ db: f.client, viewer: auth.viewer, now: f.clock.now(), changed: () => { throw Error('Unexpected effect'); } }, input)).toEqual({ recorded: false });
    expect(sql).not.toHaveBeenCalled();
  } finally { sql.mockRestore(); }
});
it('fences an authenticated failure request held in its body reader when root admission closes', async () => {
  const f = fixture(), input = { ...f.identity, basis: await f.basis() }; let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    began(); await held;
    try { controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: 'held-failure', input }))); controller.close(); } catch { /* shutdown may already have cancelled it */ }
  } }, { highWaterMark: 0 });
  const pending = f.root.http.fetch(new Request('http://loom/api/runtime/accountUnavailable', { method: 'POST', headers: { authorization: 'Bearer '+token, 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit));
  await started; const closing = f.root.close(), sql = vi.spyOn(f.client, 'prepare').mockImplementation(() => { throw Error('SQL after closed admission'); });
  release();
  try {
    expect([400,403,503]).toContain((await pending).status); await closing;
    expect(sql).not.toHaveBeenCalled();
  } finally { sql.mockRestore(); }
});

it('shares identical-value completion tracking with the existing trusted refresh API', async () => {
  const f = fixture(); await f.call(); const basis = await f.basis();
  const otherHandle = dataDatabase(f.client);
  expect(await refreshAccountWindows(otherHandle, 'account', async () => f.observation.windows, f.now)).toEqual({ refreshed: true });
  expect(await (await f.operation('accountUnavailable', { ...f.identity, basis })).json()).toMatchObject({ value: { recorded: false } });
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
});
for (const failed of [false, true]) it(`does not apply a trusted ${failed ? 'failed' : 'successful'} read after a newer reporting completion`, async () => {
  const f = fixture(); await f.call(); let release!: (value: typeof f.observation.windows) => void, reject!: (error: Error) => void;
  const held = new Promise<typeof f.observation.windows>((yes, no) => { release = yes; reject = no; });
  const pending = refreshAccountWindows(dataDatabase(f.client), 'account', async () => held, f.now);
  expect(await (await f.call(f.observation, 'report-newer')).json()).toMatchObject({ value: { recorded: true } });
  if (failed) reject(Error('provider failed')); else release(f.observation.windows);
  expect(await pending).toEqual({ refreshed: false }); expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true);
});

for (const writer of ['windows', 'summary', 'unavailable'] as const) it(`shares standalone ${writer} completions with reporting witnesses`, async () => {
  const f = fixture(); if (writer !== 'unavailable') await f.call(); const basis = await f.basis(), otherHandle = dataDatabase(f.client);
  if (writer === 'windows') expect(recordAccountWindows(otherHandle, f.identity, f.observation.windows, f.now())).toBe(true);
  else if (writer === 'summary') expect(recordAccountUsage(otherHandle, { ...f.identity, windows: f.observation.windows, now: f.now() }).recorded).toBe(true);
  else expect(accountUsageUnavailable(otherHandle, f.identity)).toBe(true);
  const response = writer === 'unavailable' ? await f.call({ ...f.observation, basis }, 'old-success')
    : await f.operation('accountUnavailable', { ...f.identity, basis });
  expect(await response.json()).toMatchObject({ value: { recorded: false } });
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(writer !== 'unavailable');
});
it('publishes an identical-state failure completion to both reporting and trusted readers', async () => {
  const f = fixture(), basis = await f.basis(); // Already unavailable; the failure must still publish a generation.
  let release!: (value: typeof f.observation.windows) => void;
  const held = new Promise<typeof f.observation.windows>(resolve => { release = resolve; });
  const pending = refreshAccountWindows(dataDatabase(f.client), 'account', async () => held, f.now);
  expect(await (await f.operation('accountUnavailable', { ...f.identity, basis })).json()).toMatchObject({ value: { recorded: true } });
  expect(await (await f.call({ ...f.observation, basis }, 'old-reporting-success')).json()).toMatchObject({ value: { recorded: false } });
  release(f.observation.windows); expect(await pending).toEqual({ refreshed: false });
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(false); expect(f.db.select().from(modelAccountWindows).all()).toEqual([]);
});

it('refreshes from the normal worker before claims and reports later failure through actual root ingestion', async () => {
  const f = fixture([{ model: 'model', provider: 'provider', harness: 'native', series: 'series' }]), output = vi.fn(), error = vi.fn(), paths: string[] = [];
  f.db.insert(agents).values({ id: 'agent', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  f.db.insert(memberAgents).values({ member: 'member', agent: 'agent' }).run();
  f.db.insert(agentBoxes).values({ agent: 'agent', box: 'worker', position: 0 }).run();
  f.db.insert(agentModels).values({ agent: 'agent', model: 'model', position: 0 }).run();
  f.db.insert(agentRunSettings).values({ agent: 'agent', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  f.db.insert(jobs).values({ id: 'quota-ready-job', agent: 'agent', title: 'Work', state: 'queued', brief: 'instructions', model: 'model', startedByKind: 'agent', startedBy: 'agent', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', queuedAt: f.now() }).run();
  expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(false);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { paths.push(new URL(String(input)).pathname); return f.root.http.fetch(new Request(input, init)); });
  cleanup.push(() => { fetcher.mockRestore(); });
  const command = { command: '/fake/reader', args: [], cwd: '/fake', env: {} };
  const config = { url: 'https://loom.example', box: 'worker', tokenFile: '/token', build: command, runners: { native: command }, accountUsage: { readers: [{ account: f.identity, command }] } };
  let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
  let stop!: () => void; const ended = new Promise<void>(resolve => { stop = resolve; });
  let attempts = 0, scans = 0;
  const pending = workerProgram({ args: ['/config'], read: async path => path === '/config' ? JSON.stringify(config) : token,
    on: () => {}, off: () => {}, output, error, usage: () => async () => { if (attempts++ > 0) throw Error('private diagnostic'); return f.observation.windows; },
    executor: () => ({} as never),
    run: async input => { expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(true); expect(await input.control.next()).toMatchObject({ id: 'quota-ready-job', box: 'worker', model: 'model', account: 'account', harness: 'native' }); expect(f.db.select().from(jobs).get()).toMatchObject({ state: 'starting', box: 'worker', account: 'account' }); release(); await ended; },
    pause: async (ms, signal) => {
      expect(ms).toBe(60_000);
      if (scans++ === 0) await ready;
      else { expect(f.db.select().from(modelAccounts).get()?.hasRoom).toBe(false); stop(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
    },
  });
  expect(await pending).toBe(0);
  expect(paths).toEqual(['/api/runtime/accountUsageBasis', '/api/runtime/accountUsage', '/api/runtime/next', '/api/runtime/accountUsageBasis', '/api/runtime/accountUnavailable']);
  expect(f.db.select().from(modelAccountWindows).get()?.usage).toBe(0.2);
  expect(f.db.select().from(operationResults).all().map(row => row.operation)).toEqual(['runtime.accountUsage', 'runtime.next', 'runtime.accountUnavailable']);
  expect(error).toHaveBeenCalledExactlyOnceWith('Worker quota refresh unavailable\n'); expect(output).not.toHaveBeenCalled();
});
