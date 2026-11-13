import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { runtimeStore } from './store.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(staging = false) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-jobs-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true })); fixture(home);
  const clock = new FakeClock(), app = await startLoom({ home, clock, next: true, staging }); cleanups.push(app.close);
  const store = runtimeStore(app.db), auth = signin(app);
  app.db.transaction(() => {
    auth.tokens.replace({ v: 1, tokens: [] }, {});
    for (const id of ['a', 'b']) store.put('box', { id, name: id, owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1 }, 1);
    for (const id of ['j', 'other', 'private', 'terminal']) store.put('job', {
      id, agent: 'art', box: id === 'other' ? 'b' : 'a', runner: id === 'other' ? 'b' : 'a', title: id,
      state: id === 'terminal' ? 'done' : 'queued', createdAt: 1,
      ...(id === 'private' ? { member: 'jonathan' } : {}), ...(id === 'terminal' ? { endedAt: 2 } : {}),
    }, 1);
  })();
  let seq = 0;
  const call = (op: string, input: unknown, viewer: Viewer = { kind: 'runner', id: 'a' }, id = `op-${++seq}`) => app.operations.call('direct', viewer, `runtime.${op}`, input, id);
  const bearer = (runner: string) => {
    app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'signin.setPrincipal', { kind: 'runner', id: runner, active: true }, `principal-${++seq}`);
    const token = randomBytes(32).toString('hex');
    auth.tokens.change(tokens => tokens.push({ role: `runner:${runner}`, label: `test-${++seq}`, sha256: hash(token), created: new Date(clock.now()).toISOString() }));
    return token;
  };
  const post = async (token: string, op: string, input: unknown, id = `http-${++seq}`) => (await fetch(`${app.url}/api/runtime/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ input, id }) })).json();
  const box = (set: object) => app.db.transaction(() => { const { changedAt: _, ...before } = store.read('box', 'a')!; store.put('box', { ...before, ...set }, clock.now()); })();
  return { app, clock, store, call, bearer, post, box };
}
it('fake runner claims only its queued job and reports progress over real bearer HTTP', async () => {
  const f = await setup(), token = f.bearer('a');
  expect(await f.post(token, 'claimJob', { job: 'j' }, 'claim')).toEqual({ ok: true, value: { job: 'j', state: 'starting' } });
  const before = f.store.read('job', 'j');
  expect(await f.post(token, 'claimJob', { job: 'j' }, 'claim')).toMatchObject({ ok: true });
  expect(await f.post(token, 'claimJob', { job: 'j' })).toMatchObject({ ok: false, code: 'conflict' });
  f.clock.advance(10);
  expect(await f.post(token, 'reportJob', { job: 'j', state: 'running' })).toEqual({ ok: true, value: { job: 'j', state: 'running' } });
  expect(await f.post(token, 'reportJob', { job: 'j', state: 'waiting' })).toMatchObject({ ok: true });
  expect(await f.post(token, 'reportJob', { job: 'j', state: 'running' })).toMatchObject({ ok: true });
  expect(f.store.read('job', 'j')).toEqual({ ...before, state: 'running', changedAt: f.clock.now() });
  expect(f.store.read('job', 'other')?.state).toBe('queued');
});
it('denies off-assignment, missing, private and other viewer kinds for both operations', async () => {
  const f = await setup();
  for (const op of ['claimJob', 'reportJob']) {
    const body = (job: string) => ({ job, ...(op === 'reportJob' ? { state: 'running' } : {}) });
    for (const job of ['other', 'missing', 'private']) expect(f.call(op, body(job))).toMatchObject({ ok: false, code: 'denied' });
    for (const viewer of [{ kind: 'member', id: 'jonathan' }, { kind: 'agent', id: 'art' }, { kind: 'service', id: 'runtime' }] as Viewer[])
      expect(f.call(op, body('j'), viewer)).toMatchObject({ ok: false, code: 'denied' });
  }
});
it('refuses revoked/missing boxes, divergent job runner, report-only and withdrawn hosting eligibility', async () => {
  const f = await setup();
  for (const set of [{ reportOnly: true }, { mayHost: [] }, { owner: 'pollock' }, { revokedAt: 1 }]) {
    f.box(set); expect(f.call('claimJob', { job: 'j' })).toMatchObject({ ok: false, code: 'denied' });
    f.box({ reportOnly: false, mayHost: '*', owner: 'jonathan', revokedAt: undefined });
  }
  f.app.db.transaction(() => { const { changedAt: _, ...job } = f.store.read('job', 'j')!; f.store.put('job', { ...job, runner: 'b' }, 1); })();
  expect(f.call('claimJob', { job: 'j' })).toMatchObject({ ok: false, code: 'denied' });
  f.app.db.prepare("DELETE FROM runtime_boxes WHERE id='b'").run();
  expect(f.call('claimJob', { job: 'other' }, { kind: 'runner', id: 'b' })).toMatchObject({ ok: false, code: 'denied' });
});
it('never reports unclaimed/terminal work or accepts state, identity and timestamp injection', async () => {
  const f = await setup();
  for (const job of ['j', 'terminal']) expect(f.call('reportJob', { job, state: 'running' })).toMatchObject({ ok: false, code: 'conflict' });
  for (const input of [{ job: 'j', runner: 'b' }, { job: 'j', createdAt: 1 }]) expect(f.call('claimJob', input)).toMatchObject({ ok: false, code: 'invalid' });
  for (const state of ['queued', 'starting', 'done', 'failed', 'stopped', 'lost', 'uncertain']) expect(f.call('reportJob', { job: 'j', state })).toMatchObject({ ok: false, code: 'invalid' });
  f.call('claimJob', { job: 'j' }); f.box({ reportOnly: true, mayHost: [] });
  expect(f.call('reportJob', { job: 'j', state: 'waiting' })).toMatchObject({ ok: true });
  f.box({ revokedAt: f.clock.now() });
  expect(f.call('reportJob', { job: 'j', state: 'running' })).toMatchObject({ ok: false, code: 'denied' });
});
it('rolls back claims/reports and receipts on failure; only committed state changes notify', async () => {
  const f = await setup(), changed = vi.spyOn(f.app.live, 'changed');
  for (const [op, input, state] of [['claimJob', { job: 'j' }, 'queued'], ['reportJob', { job: 'j', state: 'running' }, 'starting']] as const) {
    changed.mockClear();
    f.app.db.exec("CREATE TRIGGER abort_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'abort'); END");
    expect(f.call(op, input, undefined, op)).toMatchObject({ ok: false });
    expect(f.store.read('job', 'j')?.state).toBe(state); expect(changed).not.toHaveBeenCalled();
    f.app.db.exec('DROP TRIGGER abort_receipt');
    expect(f.call(op, input, undefined, op)).toMatchObject({ ok: true });
    expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'runtime.job', id: 'j' }]);
    changed.mockClear(); f.clock.advance(1);
    expect(f.call(op, input, undefined, op)).toMatchObject({ ok: true }); expect(changed).not.toHaveBeenCalled();
  }
  expect(f.call('reportJob', { job: 'j', state: 'running' })).toMatchObject({ ok: true }); expect(changed).not.toHaveBeenCalled();
});
it('performs metadata handshake in staging without releasing an outside effect', async () => {
  const f = await setup(true), token = f.bearer('a');
  expect(await f.post(token, 'claimJob', { job: 'j' })).toMatchObject({ ok: true });
  expect(await f.post(token, 'reportJob', { job: 'j', state: 'running' })).toMatchObject({ ok: true });
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
  expect(f.app.db.prepare('SELECT result FROM core_operations WHERE name LIKE ?').all('runtime.%')).not.toEqual([]);
});
