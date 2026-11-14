import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, migrate, type Viewer } from '../../core/index.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { HouseholdRows } from '../../core/household/rows.js';
import { runtimeStore } from './store.js';
import { schema } from './schema/001.js';
import { jobResults } from './results.js';
import type { RuntimeRecords } from './records.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup(staging = false) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-results-')); fixture(home);
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock(), sharing = fixtureSharing();
  let app = await startLoom({ home, next: true, staging, clock, sharing: () => sharing, stdout: () => {} });
  cleanups.push(() => app.close());
  let seq = 0;
  const store = () => runtimeStore(app.db);
  const put = (id: string, extra: Partial<RuntimeRecords['job']> = {}) => app.db.transaction(() => store().put('job', {
    id, agent: 'art', runner: 'a', box: 'a', title: id, state: 'running', createdAt: 1, ...extra,
  }, clock.now()))();
  app.db.transaction(() => {
    store().put('box', { id: 'a', name: 'a', owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1 }, 1);
    new HouseholdRows(app.db, 'settings').put('signin-principal:runner:a', { active: true });
    signin(app).tokens.replace({ v: 1, tokens: [] }, {});
  })();
  const mint = (role: string) => {
    const token = randomBytes(32).toString('hex');
    signin(app).tokens.change(tokens => tokens.push({ role, label: 'test', sha256: hash(token), created: new Date(clock.now()).toISOString() })); return token;
  };
  const call = (name: string, input: unknown, viewer: Viewer = { kind: 'runner', id: 'a' }, id = `op-${++seq}`) => app.operations.call('direct', viewer, `runtime.${name}`, input, id);
  const read = (job = 'j', viewer: Viewer = { kind: 'member', id: 'jonathan' }) => call('jobResult', { job }, viewer);
  return { get app() { return app; }, get store() { return store(); }, clock, sharing, put, mint, call, read,
    restart: async () => { await app.close(); app = await startLoom({ home, next: true, staging, clock, sharing: () => sharing, stdout: () => {} }); } };
}
it('reports output through real runner bearer HTTP, atomically completes and revokes body credentials', async () => {
  const f = await setup(); f.put('j'); const runner = f.mint('runner:a'), body = f.mint('agent:art@j');
  const handle = signin(f.app).resolve({ headers: { authorization: `Bearer ${body}` } } as IncomingMessage)!;
  const response = await fetch(`${f.app.url}/api/runtime/finishJob`, { method: 'POST', headers: { authorization: `Bearer ${runner}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'finish', input: { job: 'j', state: 'failed', exit: 2, log: 'private diagnostic' } }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, value: { job: 'j', state: 'failed' } });
  expect(f.read()).toEqual({ ok: true, value: { job: 'j', result: { exit: 2, log: 'private diagnostic' } } });
  expect(handle.valid()).toBe(false); expect(f.store.read('job', 'j')).toMatchObject({ state: 'failed', endedAt: f.clock.now() });
  const metadata = f.call('listJobs', {}, { kind: 'member', id: 'jonathan' });
  expect(JSON.stringify(metadata)).not.toContain('private diagnostic'); expect(f.store.read('job', 'j')).not.toHaveProperty('exit');
  const receipts = JSON.stringify(f.app.db.prepare('SELECT result FROM core_operations').all());
  expect(receipts).not.toContain('private diagnostic'); expect(receipts).not.toContain(body); expect(receipts).not.toContain(runner);
});
it('keeps a bounded tail and the old short refusal headline, preserving omitted fields and clearing explicit empty logs', async () => {
  const f = await setup(); f.put('j');
  expect(f.read()).toEqual({ ok: true, value: { job: 'j', result: null } });
  const headline = "the box couldn't start it: missing service";
  for (const [log, expected] of [
    ['x'.repeat(6000), 'x'.repeat(4000)],
    [headline + '\n' + 'a'.repeat(5000), headline + '\n' + 'a'.repeat(3957)],
    ["the box couldn't start it: " + 'x'.repeat(300) + '\n' + 't'.repeat(5000), 't'.repeat(4000)],
    ['z'.repeat(4000), 'z'.repeat(4000)],
  ]) {
    expect(f.call('reportJob', { job: 'j', state: 'running', log, exit: -1 }).ok).toBe(true);
    const kept = jobResults(f.app.db).read('j')!.log!;
    expect(kept).toHaveLength(4000);
    expect(kept).toBe(expected);
  }
  expect(f.call('reportJob', { job: 'j', state: 'waiting', log: '' }).ok).toBe(true);
  expect(jobResults(f.app.db).read('j')).toEqual({ exit: -1, log: '' });
  expect(f.call('finishJob', { job: 'j', state: 'done', exit: 0 }).ok).toBe(true);
  expect(jobResults(f.app.db).read('j')).toEqual({ exit: 0, log: '' });
  expect(f.call('finishJob', { job: 'j', state: 'done', log: 'overwrite' })).toMatchObject({ ok: false, code: 'conflict' });
});
it('checks current private/project/agent visibility and independent service type and operation grants on every read', async () => {
  const f = await setup();
  for (const [job, scope] of [['j', {}], ['private', { member: 'jonathan' }], ['project', { project: 'other' }]] as const) {
    f.put(job); f.call('reportJob', { job, state: 'running', log: `words-${job}` }); f.put(job, scope);
  }
  f.sharing.projects.other.agents = [];
  const agent: Viewer = { kind: 'agent', id: 'art' }, pollock: Viewer = { kind: 'member', id: 'pollock' }, svc: Viewer = { kind: 'service', id: 'svc' };
  expect(f.read('j', agent).ok).toBe(true); expect(f.read('private').ok).toBe(true);
  for (const [job, viewer] of [['private', agent], ['private', pollock], ['project', agent], ['project', pollock], ['j', pollock], ['missing', agent], ['j', { kind: 'runner', id: 'a' }]] as [string, Viewer][])
    expect(f.read(job, viewer)).toMatchObject({ ok: false, code: 'denied' });
  f.sharing.services.svc = { types: ['runtime.job'], operations: [] };
  expect(f.read('j', svc)).toMatchObject({ ok: false, code: 'denied' });
  f.sharing.services.svc = { types: [], operations: ['runtime.jobResult'] };
  expect(f.read('j', svc)).toMatchObject({ ok: false, code: 'denied' });
  f.sharing.services.svc.types = ['runtime.job'];
  expect(f.read('j', svc).ok).toBe(true); expect(f.read('private', svc)).toMatchObject({ ok: false, code: 'denied' });
  f.sharing.members.jonathan.agents = []; // Owner retains visible job access by central rule.
  expect(f.read('j').ok).toBe(true);
  f.sharing.projects.other.agents = ['art']; expect(f.read('project', agent).ok).toBe(true);
  f.sharing.projects.other.agents = []; expect(f.read('project', agent)).toMatchObject({ ok: false, code: 'denied' });
  f.sharing.services.svc.operations = []; expect(f.read('j', svc)).toMatchObject({ ok: false, code: 'denied' });
});
it('denies output writes from off-assignment, private, missing/revoked-box jobs and nonrunner collisions', async () => {
  const f = await setup();
  f.put('j'); f.put('private', { member: 'jonathan' }); f.put('other', { runner: 'b' }); f.put('mismatch', { box: 'b' });
  for (const name of ['reportJob', 'finishJob']) {
    const state = name === 'reportJob' ? 'running' : 'done';
    for (const job of ['private', 'other', 'mismatch', 'missing']) expect(f.call(name, { job, state, log: 'forged', exit: 0 })).toMatchObject({ ok: false, code: 'denied' });
    for (const viewer of [{ kind: 'member', id: 'a' }, { kind: 'agent', id: 'a' }, { kind: 'service', id: 'a' }] as Viewer[])
      expect(f.call(name, { job: 'j', state, log: 'forged' }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  }
  f.app.db.transaction(() => { const { changedAt: _, ...box } = f.store.read('box', 'a')!; f.store.put('box', { ...box, revokedAt: 1 }, 1); })();
  expect(f.call('reportJob', { job: 'j', state: 'running', log: 'forged' })).toMatchObject({ ok: false, code: 'denied' });
  expect(f.app.db.prepare('SELECT * FROM runtime_results').all()).toEqual([]);
});
it('rolls back output, completion, credentials and notifications on output/metadata/receipt failures', async () => {
  const f = await setup(); f.put('j'); const body = f.mint('agent:art@j');
  const changed = vi.spyOn(f.app.live, 'changed');
  for (const table of ['runtime_results', 'runtime_jobs', 'core_operations']) {
    f.app.db.exec(`CREATE TRIGGER abort_output BEFORE ${table === 'runtime_jobs' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'abort'); END`);
    expect(f.call('finishJob', { job: 'j', state: 'failed', exit: 3, log: 'lost' }, undefined, 'stable')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(jobResults(f.app.db).read('j')).toBeNull(); expect(f.store.read('job', 'j')?.state).toBe('running');
    expect(signin(f.app).resolve({ headers: { authorization: `Bearer ${body}` } } as IncomingMessage)?.valid()).toBe(true);
    expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='stable'").get()).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
    f.app.db.exec('DROP TRIGGER abort_output');
  }
  expect(f.call('finishJob', { job: 'j', state: 'failed', exit: 3, log: 'kept' }, undefined, 'stable').ok).toBe(true);
  expect(jobResults(f.app.db).read('j')).toEqual({ exit: 3, log: 'kept' });
});
it('preserves current output on old receipt replay across restart and signals only committed job ids for output changes', async () => {
  const f = await setup(); f.put('j');
  const changed = vi.spyOn(f.app.live, 'changed'), input = { job: 'j', state: 'running', log: 'first', exit: 0 };
  expect(f.call('reportJob', input, undefined, 'old')).toEqual({ ok: true, value: { job: 'j', state: 'running' } });
  expect(changed.mock.calls.flat(2)).not.toContain('first');
  expect(changed.mock.calls.some(([refs]) => refs.some(r => r.type === 'runtime.job' && r.id === 'j'))).toBe(true);
  const unchanged = f.store.read('job', 'j');
  changed.mockClear(); f.clock.advance(10);
  expect(f.call('reportJob', input).ok).toBe(true);
  expect(f.store.read('job', 'j')).toEqual(unchanged);
  expect(changed.mock.calls.flatMap(([refs]) => refs).filter(r => r.type === 'runtime.job')).toEqual([]);
  f.call('reportJob', { job: 'j', state: 'waiting', log: 'new' });
  await f.restart();
  expect(f.call('reportJob', input, undefined, 'old').ok).toBe(true);
  expect(jobResults(f.app.db).read('j')).toEqual({ exit: 0, log: 'new' }); expect(f.store.read('job', 'j')?.state).toBe('waiting');
  const before = f.app.db.prepare('SELECT count(*) AS n FROM core_operations').get(), readsChanged = vi.spyOn(f.app.live, 'changed');
  f.read(); f.read('missing'); f.read('j', { kind: 'member', id: 'pollock' });
  expect(readsChanged).not.toHaveBeenCalled(); expect(f.app.db.prepare('SELECT count(*) AS n FROM core_operations').get()).toEqual(before);
});
it('rejects malformed output, unknown authority and invalid progress builds without committing result words', async () => {
  const f = await setup(); f.put('j');
  for (const name of ['reportJob', 'finishJob']) {
    const base = { job: 'j', state: name === 'reportJob' ? 'running' : 'done' };
    for (const fields of [{ exit: 1.5 }, { exit: '0' }, { exit: Number.MAX_SAFE_INTEGER + 1 }, { log: 42 }, { log: 'x'.repeat(1_000_001) }, { log: null }, { result: 'words' }, { member: 'jonathan' }])
      expect(f.call(name, { ...base, ...fields })).toMatchObject({ ok: false, code: 'invalid' });
  }
  expect(f.call('jobResult', { job: 'j', member: 'jonathan' }, { kind: 'member', id: 'jonathan' })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.call('reportJob', { job: 'j', state: 'running', log: 'rollback', build: 'wrong' })).toMatchObject({ ok: false, code: 'invalid' });
  expect(jobResults(f.app.db).read('j')).toBeNull();
});
it('upgrades metadata-only storage, survives interrupted migration and remains inside the staging process', async () => {
  const f = await setup(true); f.put('j'); const before = f.store.read('job', 'j');
  f.app.db.prepare('INSERT INTO runtime_inputs (job,brief,needs) VALUES (?,?,?)').run('j', 'private input', JSON.stringify(['gpu']));
  const inputs = f.app.db.prepare('SELECT * FROM runtime_inputs').all();
  expect(() => jobResults(f.app.db).put('j', { log: 'outside' })).toThrow('transaction');
  f.app.db.exec("DROP TABLE runtime_clock_turns; DROP TABLE runtime_body_policy; DROP TABLE runtime_import_chunks; DROP TABLE runtime_start_attempts; DROP TABLE runtime_import_meta; DROP TABLE runtime_import_sources; DROP TABLE runtime_import_documents; DROP TABLE runtime_import_revisions; DROP TABLE runtime_deliveries; DROP TABLE runtime_provenance_sources; DROP TABLE runtime_provenance; DROP TABLE runtime_owner_requests; DROP TABLE runtime_job_heartbeats; DROP TABLE runtime_bridge_turns; DROP TABLE runtime_bridge_stops; DROP TABLE runtime_results; DELETE FROM core_migrations WHERE piece='runtime' AND number>=3");
  f.app.db.exec("CREATE TRIGGER abort_migration BEFORE INSERT ON core_migrations WHEN NEW.piece='runtime' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
  expect(() => migrate(f.app.db, 'runtime', schema)).toThrow('interrupted');
  expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name='runtime_results'").get()).toBeUndefined();
  expect(f.store.read('job', 'j')).toEqual(before);
  expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toEqual(inputs);
  f.app.db.exec('DROP TRIGGER abort_migration');
  await f.restart(); expect(f.store.read('job', 'j')).toEqual(before); expect(f.read()).toMatchObject({ value: { result: null } });
  expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toEqual(inputs);
  expect(() => f.app.db.transaction(() => { jobResults(f.app.db).put('j', { log: 'interrupted' }); throw Error('interrupted'); })()).toThrow('interrupted');
  expect(f.read()).toMatchObject({ value: { result: null } });
  expect(f.call('finishJob', { job: 'j', state: 'done', log: 'staged' }).ok).toBe(true);
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
});

it('creates no output row for successful progress and completion when both fields are omitted', async () => {
  const f = await setup(); f.put('j');
  expect(f.call('reportJob', { job: 'j', state: 'waiting' }).ok).toBe(true);
  expect(f.read()).toEqual({ ok: true, value: { job: 'j', result: null } });
  expect(f.app.db.prepare('SELECT * FROM runtime_results').all()).toEqual([]);
  expect(f.call('finishJob', { job: 'j', state: 'done' }).ok).toBe(true);
  expect(f.read()).toEqual({ ok: true, value: { job: 'j', result: null } });
  expect(f.app.db.prepare('SELECT * FROM runtime_results').all()).toEqual([]);
});
it('sends metadata-only live updates for output-only changes, and never private job output', async () => {
  const f = await setup(); f.put('j'); f.put('private', { member: 'jonathan' });
  const token = f.mint('agent:art');
  const ws = new WebSocket(f.app.url.replace('http:', 'ws:') + '/live', { headers: { authorization: `Bearer ${token}` } });
  cleanups.push(() => ws.terminate());
  const queue: unknown[] = [], waiters: Array<(value: unknown) => void> = [];
  ws.on('message', raw => { const value = JSON.parse(raw.toString()), waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
  await once(ws, 'open'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'runtime.job', scope: 'art' }));
  expect(await next()).toMatchObject({ kind: 'set', records: [{ id: 'j' }] });
  expect(f.call('reportJob', { job: 'j', state: 'running', exit: 0, log: 'not on the socket' }).ok).toBe(true);
  const message = await next();
  expect(message).toMatchObject({ kind: 'put', type: 'runtime.job', record: { id: 'j', state: 'running' } });
  expect(JSON.stringify(message)).not.toContain('not on the socket'); expect((message as { record: unknown }).record).not.toHaveProperty('exit');
  expect(f.read('j', { kind: 'agent', id: 'art' })).toMatchObject({ value: { result: { exit: 0, log: 'not on the socket' } } });
});
