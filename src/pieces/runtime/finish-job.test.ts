import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { HouseholdRows } from '../../core/household/rows.js';
import { runtimeStore } from './store.js';
import { centralRuntimeCredentials } from './central-credentials.js';
import { installRuntime } from './index.js';
import type { RuntimeCredentials } from './credentials.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup(options: { staging?: boolean; credentials?: 'missing' | 'async' | 'reject' | 'throw' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-finish-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true })); fixture(home);
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, next: true, stdout: () => {}, staging: options.staging, ...(options.credentials ? { install(app) {
    const credentials: RuntimeCredentials | undefined = options.credentials === 'missing' ? undefined : {
      ...centralRuntimeCredentials,
      revokeJob(db, input) {
        centralRuntimeCredentials.revokeJob(db, input);
        if (options.credentials === 'throw') throw new Error('revocation failed');
        return options.credentials === 'reject' ? Promise.reject(new Error('async revocation failed')) : Promise.resolve();
      },
    };
    installRuntime(app.db, app.operations, app.live, () => new SharingDatabase(app.db, home).sharing(), { credentials });
  } } : {}) }); cleanups.push(app.close);
  const store = runtimeStore(app.db), auth = signin(app);
  app.db.transaction(() => {
    auth.tokens.replace({ v: 1, tokens: [] }, {});
    for (const id of ['a', 'b', 'jonathan', 'art', 'runtime']) {
      store.put('box', { id, name: id, owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1 }, 1);
      new HouseholdRows(app.db, 'settings').put(`signin-principal:runner:${id}`, { active: true });
    }
    for (const state of ['queued', 'starting', 'running', 'waiting', 'done', 'failed', 'stopped', 'lost', 'uncertain'] as const)
      store.put('job', { id: state, agent: 'art', box: 'a', runner: 'a', title: state, state, createdAt: 1 }, 1);
    for (const id of ['other', 'private', 'mismatch', 'missing-box', 'jonathan', 'art', 'runtime'])
      store.put('job', { id, agent: 'art', box: id === 'other' ? 'b' : id === 'missing-box' ? 'absent' : ['jonathan', 'art', 'runtime'].includes(id) ? id : 'a',
        runner: id === 'other' || id === 'mismatch' ? 'b' : ['jonathan', 'art', 'runtime'].includes(id) ? id : 'a',
        title: id, state: 'running', createdAt: 1, ...(id === 'private' ? { member: 'jonathan' } : {}) }, 1);
  })();
  let seq = 0;
  const mint = (role: string) => {
    const token = randomBytes(32).toString('hex');
    auth.tokens.change(tokens => tokens.push({ role, label: 'same label', sha256: hash(token), created: new Date(clock.now()).toISOString() })); return token;
  };
  const resolve = (token: string) => auth.resolve({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);
  const call = (input: unknown, viewer: Viewer = { kind: 'runner', id: 'a' }, id = `op-${++seq}`) => app.operations.call('direct', viewer, 'runtime.finishJob', input, id);
  const post = (token: string, input: unknown, id = `http-${++seq}`) => fetch(`${app.url}/api/runtime/finishJob`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ input, id }) });
  return { home, app, clock, store, auth, mint, resolve, call, post };
}
it('finishes through real bearer HTTP and invalidates only exact job credentials and existing auth handles', async () => {
  const revoke = vi.spyOn(centralRuntimeCredentials, 'revokeJob');
  const f = await setup(), runner = f.mint('runner:a');
  const bodies = ['agent:art@running', 'agent:art@running', 'agent:art/bridge@running', 'agent:mark@running'].map(f.mint);
  const others = ['runner:b', 'agent:art@running-other', 'agent:art@waiting', 'agent:art', 'agent:art/bridge', 'owner'].map(f.mint);
  const handles = bodies.map(t => f.resolve(t)!); expect(handles.every(h => h.valid())).toBe(true);
  f.clock.advance(10);
  const response = await f.post(runner, { job: 'running', state: 'done' }, 'finish');
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, value: { job: 'running', state: 'done' } });
  expect(f.store.read('job', 'running')).toMatchObject({ state: 'done', endedAt: f.clock.now(), changedAt: f.clock.now() });
  for (const [i, token] of bodies.entries()) {
    expect(f.resolve(token)).toBeUndefined(); expect(handles[i].valid()).toBe(false);
    expect((await f.post(token, { job: 'waiting', state: 'failed' })).status).toBe(401);
  }
  for (const token of [runner, ...others]) expect(f.resolve(token)?.valid()).toBe(true);
  expect(new HouseholdRows(f.app.db, 'settings').get('signin-principal:runner:a')).toEqual({ active: true });
  expect(f.store.read('job', 'waiting')?.state).toBe('waiting');
  // Admission diagnostics from earlier successful resolutions publish asynchronously.
  // Drain them before checking that the runtime retry itself emits nothing.
  await Promise.resolve();
  // A network retry is acknowledged even though a new finish is forbidden.
  const before = f.store.read('job', 'running'), tokens = f.auth.tokens.document(), changed = vi.spyOn(f.app.live, 'changed');
  f.clock.advance(20);
  expect(await (await f.post(runner, { job: 'running', state: 'done' }, 'finish')).json()).toEqual({ ok: true, value: { job: 'running', state: 'done' } });
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(f.store.read('job', 'running')).toEqual(before); expect(f.auth.tokens.document()).toEqual(tokens); expect(changed).not.toHaveBeenCalled();
  expect(f.call({ job: 'running', state: 'done' })).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.call({ job: 'running', state: 'failed' })).toMatchObject({ ok: false, code: 'conflict' });
  const receipts = JSON.stringify(f.app.db.prepare("SELECT result FROM core_operations WHERE name='runtime.finishJob'").all());
  for (const token of [runner, ...bodies, ...others]) expect(receipts).not.toContain(token);
});
it('supports both completion states only from claimed states and preserves earlier revocations', async () => {
  const f = await setup();
  const old = f.mint('agent:art@starting'); f.auth.tokens.change(tokens => { tokens[0].revoked = '2020-01-01T00:00:00.000Z'; });
  const starting = f.mint('agent:art@starting'), waiting = f.mint('agent:art/bridge@waiting'), other = f.mint('agent:art@other'), runner = f.mint('runner:a');
  for (const [job, state] of [['starting', 'failed'], ['running', 'done'], ['waiting', 'failed']] as const) {
    expect(f.call({ job, state })).toEqual({ ok: true, value: { job, state } });
    expect(f.resolve(other)?.valid()).toBe(true); expect(f.resolve(runner)?.valid()).toBe(true);
    if (job === 'starting') { expect(f.resolve(starting)).toBeUndefined(); expect(f.resolve(waiting)?.valid()).toBe(true); }
    if (job === 'waiting') expect(f.resolve(waiting)).toBeUndefined();
  }
  expect(f.auth.tokens.records(hash(old))[0].revoked).toBe('2020-01-01T00:00:00.000Z');
  for (const job of ['queued', 'done', 'failed', 'stopped', 'lost', 'uncertain']) {
    const before = f.store.read('job', job);
    expect(f.call({ job, state: 'done' })).toMatchObject({ ok: false, code: 'conflict' });
    expect(f.store.read('job', job)).toEqual(before);
  }
});
it('denies other assignments, private and missing jobs, absent/revoked boxes, and viewer-kind collisions', async () => {
  const f = await setup(), tokens = f.auth.tokens.document();
  for (const job of ['other', 'private', 'missing', 'missing-box', 'mismatch'])
    expect(f.call({ job, state: 'done' })).toMatchObject({ ok: false, code: 'denied' });
  f.app.db.transaction(() => { const { changedAt: _, ...job } = f.store.read('job', 'mismatch')!; f.store.put('job', { ...job, runner: 'a', box: 'b' }, 1); })();
  expect(f.call({ job: 'mismatch', state: 'done' })).toMatchObject({ ok: false, code: 'denied' });
  for (const viewer of [{ kind: 'member', id: 'jonathan' }, { kind: 'agent', id: 'art' }, { kind: 'service', id: 'runtime' }] as Viewer[])
    expect(f.call({ job: viewer.id, state: 'done' }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  f.app.db.transaction(() => { const { changedAt: _, ...box } = f.store.read('box', 'a')!; f.store.put('box', { ...box, revokedAt: 1 }, 1); })();
  expect(f.call({ job: 'running', state: 'done' })).toMatchObject({ ok: false, code: 'denied' });
  expect(f.auth.tokens.document()).toEqual(tokens);
});
it('refuses identity, timestamps, unknown results and non-completion states, but accepts completion after hosting withdrawal', async () => {
  const f = await setup(), before = f.store.read('job', 'running');
  for (const extra of [{ box: 'b' }, { runner: 'b' }, { agent: 'mark' }, { endedAt: 1 }, { changedAt: 1 }, { result: 'words' }])
    expect(f.call({ job: 'running', state: 'done', ...extra })).toMatchObject({ ok: false, code: 'invalid' });
  for (const state of ['queued', 'starting', 'running', 'waiting', 'stopped', 'lost', 'uncertain'])
    expect(f.call({ job: 'running', state })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.store.read('job', 'running')).toEqual(before);
  f.app.db.transaction(() => { const { changedAt: _, ...box } = f.store.read('box', 'a')!; f.store.put('box', { ...box, reportOnly: true, mayHost: [] }, 1); })();
  expect(f.call({ job: 'running', state: 'failed' })).toMatchObject({ ok: true });
});
it('rolls central credential changes, job metadata, receipts and notifications back on later failures', async () => {
  const f = await setup(), token = f.mint('agent:art@running'), handle = f.resolve(token)!, changed = vi.spyOn(f.app.live, 'changed');
  for (const table of ['runtime_jobs', 'core_operations']) {
    const before = f.store.read('job', 'running'), tokens = f.auth.tokens.document();
    f.app.db.exec(`CREATE TRIGGER abort_finish BEFORE ${table === 'runtime_jobs' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'abort'); END`);
    expect(f.call({ job: 'running', state: 'done' }, undefined, 'stable')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(f.store.read('job', 'running')).toEqual(before); expect(f.auth.tokens.document()).toEqual(tokens); expect(handle.valid()).toBe(true);
    expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='stable'").get()).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
    f.app.db.exec('DROP TRIGGER abort_finish');
  }
  expect(f.call({ job: 'running', state: 'done' }, undefined, 'stable')).toMatchObject({ ok: true }); expect(handle.valid()).toBe(false);
  expect(changed.mock.calls[0][0]).toEqual([{ type: 'core.access', id: 'credentials' }, { type: 'runtime.job', id: 'running' }]);
});
it('fails closed for missing, throwing and asynchronous credential roles', async () => {
  for (const credentials of ['missing', 'throw', 'async', 'reject'] as const) {
    const f = await setup({ credentials }), token = f.mint('agent:art@running'), before = f.store.read('job', 'running'), tokens = f.auth.tokens.document();
    const changed = vi.spyOn(f.app.live, 'changed');
    expect(f.call({ job: 'running', state: 'done' })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(f.store.read('job', 'running')).toEqual(before); expect(f.auth.tokens.document()).toEqual(tokens); expect(f.resolve(token)?.valid()).toBe(true);
    expect(changed).not.toHaveBeenCalled(); expect(f.app.db.prepare("SELECT * FROM core_operations WHERE name='runtime.finishJob'").all()).toEqual([]);
    // Pass a whole event-loop turn: an abandoned rejection would fail Vitest
    // and would terminate an ordinary daemon under Node's default policy.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});
it('requires the caller transaction and permits empty-home completion and staging without outside effects', async () => {
  const f = await setup({ staging: true });
  expect(() => centralRuntimeCredentials.revokeJob(f.app.db, { job: 'running', now: f.clock.now() })).toThrow('caller transaction');
  f.app.db.prepare('DELETE FROM household_settings WHERE id=?').run('token-envelope');
  expect(f.call({ job: 'running', state: 'done' })).toMatchObject({ ok: true });
  expect(f.store.read('job', 'running')).toMatchObject({ state: 'done', endedAt: f.clock.now() });
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
});

it('durably replays the original acknowledgement across a daemon restart without revoking again', async () => {
  const f = await setup(), runner = f.mint('runner:a'); f.mint('agent:art@running');
  const input = { job: 'running', state: 'done' }, ack = { ok: true, value: input };
  expect(await (await f.post(runner, input, 'restart-retry')).json()).toEqual(ack);
  const before = f.store.read('job', 'running'), tokens = f.auth.tokens.document();
  await f.app.close(); f.clock.advance(100);
  const restarted = await startLoom({ home: f.home, clock: f.clock, next: true, stdout: () => {} }); cleanups.push(restarted.close);
  const changed = vi.spyOn(restarted.live, 'changed'), revoke = vi.spyOn(centralRuntimeCredentials, 'revokeJob');
  const response = await fetch(`${restarted.url}/api/runtime/finishJob`, { method: 'POST', headers: { authorization: `Bearer ${runner}`, 'content-type': 'application/json' }, body: JSON.stringify({ input, id: 'restart-retry' }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual(ack);
  expect(runtimeStore(restarted.db).read('job', 'running')).toEqual(before);
  expect(signin(restarted).tokens.document()).toEqual(tokens);
  expect(changed).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
});
