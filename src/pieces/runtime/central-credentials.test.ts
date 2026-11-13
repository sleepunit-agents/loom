import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { signin, hash } from '../../core/signin/index.js';
import { HouseholdRows } from '../../core/household/rows.js';
import { fixture } from '../../fixture.js';
import { runtimeStore } from './store.js';
import { centralRuntimeCredentials } from './central-credentials.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'runtime-credentials-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true })); fixture(home);
  const clock = new FakeClock(), app = await startLoom({ home, clock, next: true, stdout: () => {} }); cleanups.push(app.close);
  const s = signin(app), store = runtimeStore(app.db), owner = { kind: 'member' as const, id: 'jonathan' };
  app.db.transaction(() => {
    s.tokens.replace({ v: 1, tokens: [] }, {});
    for (const id of ['a', 'b']) {
      store.put('box', { id, name: id, owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1 }, 1);
      new HouseholdRows(app.db, 'settings').put(`signin-principal:runner:${id}`, { active: true });
    }
    for (const [id, box, state] of [['h-1', 'a', 'running'], ['h-10', 'b', 'running'], ['h-2', 'a', 'done']] as const)
      store.put('job', { id, box, runner: box, agent: 'art', title: id, state, createdAt: 1 }, 1);
    store.put('settings', { id: 'art', agent: 'art', boxes: ['a', 'b'] }, 1);
  })();
  let sequence = 0;
  const mint = (role: string, label = 'same display label') => {
    const token = randomBytes(32).toString('hex');
    s.tokens.change(tokens => tokens.push({ label, role, sha256: hash(token), created: new Date(clock.now()).toISOString() }));
    return token;
  };
  const auth = (token: string) => s.resolve({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);
  const post = (token: string, op: string, input: unknown = {}) => fetch(`${app.url}/api/runtime/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ input, id: `http-${++sequence}` }) });
  const revoke = (id = 'revoke') => app.operations.call('direct', owner, 'runtime.revokeBox', { box: 'a' }, id);
  return { app, clock, s, store, mint, auth, post, revoke };
}
it('revokes all exact runner and job-linked tokens including terminal jobs, preserving unrelated principals', async () => {
  const f = await setup();
  const affected = ['runner:a', 'runner:a', 'agent:art@h-1', 'agent:art/bridge@h-1', 'agent:mark@h-2'].map(role => f.mint(role));
  const others = ['runner:b', 'agent:art@h-10', 'agent:art', 'agent:art/bridge', 'owner'].map(role => f.mint(role));
  const handles = affected.map(token => f.auth(token)!);
  expect(handles.every(handle => handle.valid())).toBe(true);
  expect((await f.post(affected[0], 'hearBox')).status).toBe(200);
  expect(f.revoke()).toEqual({ ok: true, value: { box: 'a', revoked: true } });
  for (const [i, token] of affected.entries()) {
    expect(f.auth(token)).toBeUndefined(); expect(handles[i].valid()).toBe(false);
    expect(f.s.tokens.records(hash(token))[0].revoked).toBe(new Date(f.clock.now()).toISOString());
  }
  expect((await f.post(affected[0], 'hearBox')).status).toBe(401);
  expect((await f.post(affected[2], 'listJobs')).status).toBe(401);
  for (const token of others) expect(f.auth(token)?.valid()).toBe(true);
  expect(f.store.read('job', 'h-1')?.state).toBe('lost');
  expect(f.store.read('job', 'h-2')?.state).toBe('done');
  expect(f.store.read('job', 'h-10')?.state).toBe('running');
  expect(new HouseholdRows(f.app.db, 'settings').get('signin-principal:runner:a')).toEqual({ active: false });
  // Reactivating a principal cannot resurrect revoked credentials.
  f.app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'signin.setPrincipal', { kind: 'runner', id: 'a', active: true }, 'reactivate');
  expect(f.auth(affected[0])).toBeUndefined();
});
it('rolls real credential and principal changes back on a later failure and permits the same retry', async () => {
  const f = await setup(), runner = f.mint('runner:a'), body = f.mint('agent:art@h-1');
  const handles = [f.auth(runner)!, f.auth(body)!], before = f.s.tokens.document();
  const changed = vi.spyOn(f.app.live, 'changed');
  f.app.db.exec("CREATE TRIGGER reject_preferences BEFORE UPDATE ON runtime_settings BEGIN SELECT RAISE(ABORT, 'test abort'); END");
  expect(f.revoke()).toMatchObject({ ok: false, code: 'unavailable' });
  expect(f.s.tokens.document()).toEqual(before);
  expect(handles.every(h => h.valid())).toBe(true);
  expect(new HouseholdRows(f.app.db, 'settings').get('signin-principal:runner:a')).toEqual({ active: true });
  expect(f.store.read('box', 'a')?.revokedAt).toBeUndefined();
  expect(changed).not.toHaveBeenCalled();
  expect(f.app.db.prepare('SELECT * FROM core_operations WHERE id=?').get('revoke')).toBeUndefined();
  f.app.db.exec('DROP TRIGGER reject_preferences');
  expect(f.revoke()).toMatchObject({ ok: true }); expect(handles.every(h => !h.valid())).toBe(true);
  expect(changed.mock.calls[0][0]).toContainEqual({ type: 'core.access', id: 'credentials' });
});
it('replays without reapplying revocation or notifying and preserves previously revoked timestamps', async () => {
  const f = await setup(), token = f.mint('runner:a');
  f.s.tokens.change(tokens => { tokens[0].revoked = '2020-01-01T00:00:00.000Z'; });
  expect(f.revoke()).toMatchObject({ ok: true });
  expect(f.s.tokens.records(hash(token))[0].revoked).toBe('2020-01-01T00:00:00.000Z');
  const before = f.s.tokens.document(), changed = vi.spyOn(f.app.live, 'changed');
  expect(f.revoke()).toMatchObject({ ok: true }); expect(changed).not.toHaveBeenCalled();
  expect(f.s.tokens.document()).toEqual(before);
});
it('revokes a box in an empty new home without a token document and requires the caller transaction', async () => {
  const f = await setup();
  f.app.db.prepare('DELETE FROM household_settings WHERE id=?').run('token-envelope');
  expect(() => centralRuntimeCredentials.revokeBox(f.app.db, { box: 'a', jobs: [], now: f.clock.now() })).toThrow('caller transaction');
  expect(f.revoke()).toMatchObject({ ok: true });
  expect(new HouseholdRows(f.app.db, 'settings').get('signin-principal:runner:a')).toEqual({ active: false });
});
it('denies real nonowner bearer requests before central credentials change', async () => {
  const f = await setup(), runner = f.mint('runner:a'), body = f.mint('agent:art@h-1');
  const before = f.s.tokens.document();
  for (const token of [runner, body]) expect((await f.post(token, 'revokeBox', { box: 'a' })).status).toBe(403);
  expect(f.s.tokens.document()).toEqual(before); expect(f.auth(runner)?.valid()).toBe(true);
});
