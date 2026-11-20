import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock, failure, type Viewer } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { installAttentionMaintenance } from './daemon.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
const owner: Viewer = { kind: 'member', id: 'jonathan' }, service: Viewer = { kind: 'service', id: 'attention' };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'unattended-waits-')); fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const grants = { taskType: true, taskRead: true, approvalType: true, approvalRead: true, inventoryRead: true, askType: true, checkRead: true, resolveRead: true };
  let database: SharingDatabase;
  const app = await startLoom({ home, next: true, staging: true, clock, stdout: () => {}, install: app => { database = new SharingDatabase(app.db, home); }, sharing: () => {
    const snapshot = database.sharing();
    const attention = snapshot.services.attention;
    if (attention) snapshot.services = { ...snapshot.services, attention: { types: attention.types.filter(type => (type !== 'attention.ask' || grants.askType) && (type !== 'task' || grants.taskType) && (type !== 'approval' || grants.approvalType)), operations: attention.operations.filter(op => (op !== 'attention.pendingWaits' || grants.inventoryRead) && (op !== 'attention.checkWait' || grants.checkRead) && (op !== 'attention.resolve' || grants.resolveRead) && (!['tasks.show', 'tasks.readMany'].includes(op) || grants.taskRead) && (op !== 'approvals.check' || grants.approvalRead)) } };
    return snapshot;
  } });
  cleanups.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  let seq = 0;
  const call = (name: string, input: unknown, viewer = owner) => app.operations.call('direct', viewer, name, input, `unattended-${++seq}`);
  const raise = (id: string, waits_on: { task: string } | { approval: string }, extra = {}) => {
    expect(call('attention.raise', { id, agent: 'art', ask: 'Check this work?', source: { kind: 'conversation', id: 'cv-test' }, waits_on, ...extra })).toMatchObject({ ok: true });
  };
  const read = (id: string) => call('attention.get', { id });
  const close = () => expect(call('tasks.close', { id: 't-1', actor: 'jonathan', at: '2026-11-13T12:00:00Z' })).toMatchObject({ value: { result: { ok: true } } });
  return { app, clock, grants, call, raise, read, close, home };
}
it('resolves public task waits without a page, preserves answers and leaves private/missing waits open', async () => {
  const { app, clock, call, raise, read, close } = await setup();
  raise('public', { task: 't-1' }); raise('private', { task: 't-1' }, { member: 'jonathan' }); raise('missing', { task: 't-999' });
  raise('answered', { task: 't-1' }); call('attention.answer', { id: 'answered', answer: { kind: 'no' } });
  const calls = vi.spyOn(app.operations, 'call');
  clock.advance(0); expect(read('public')).toMatchObject({ value: { state: 'open' } });
  close(); clock.advance(59_999); expect(read('public')).toMatchObject({ value: { state: 'open' } });
  clock.advance(1);
  expect(read('public')).toMatchObject({ value: { state: 'resolved', resolution: 't-1 is closed' } });
  expect(read('private')).toMatchObject({ value: { state: 'open' } });
  expect(read('missing')).toMatchObject({ value: { state: 'open' } });
  expect(read('answered')).toMatchObject({ value: { state: 'answered', answer: { kind: 'no' } } });
  const checks = calls.mock.calls.filter(c => c[2] === 'attention.sweepWaits');
  expect(checks.every(c => JSON.stringify(c[1]) === JSON.stringify(service))).toBe(true);
  const ids = checks.map(c => c[4]); expect(new Set(ids).size).toBe(ids.length);
});
it.each(['taskType', 'taskRead'] as const)('requires %s on every sweep, with no task mutation grants', async grant => {
  const { clock, grants, call, raise, read, close } = await setup();
  raise('public', { task: 't-1' }); close(); grants[grant] = false;
  clock.advance(0); expect(read('public')).toMatchObject({ value: { state: 'open' } });
  grants[grant] = true; clock.advance(60_000); expect(read('public')).toMatchObject({ value: { state: 'resolved' } });
  for (const op of ['tasks.close', 'tasks.comment', 'tasks.list']) expect(call(op, { id: 't-1' }, service)).toMatchObject({ ok: false, code: 'denied' });
});
it('uses actual public Approval terminal facts without spending them; private approval state remains hidden', async () => {
  const { app, clock, grants, call, raise, read } = await setup();
  const requested = call('approvals.request', { kind: 'merge', target: `github:acme/app#12@${'a'.repeat(40)}`, ask: 'Merge the fix?', why: 'Fix it.', if_yes: 'I merge it.', if_no: 'I leave it.' }, { kind: 'agent', id: 'art' });
  expect(requested).toMatchObject({ ok: true });
  const id = (requested as { ok: true; value: { id: string } }).value.id;
  raise('approval', { approval: id });
  clock.advance(0); expect(read('approval')).toMatchObject({ value: { state: 'open' } });
  expect(call('approvals.answer', { id, action: 'allow' })).toMatchObject({ ok: true });
  grants.approvalType = false; clock.advance(60_000); expect(read('approval')).toMatchObject({ value: { state: 'open' } });
  grants.approvalType = true; grants.approvalRead = false; clock.advance(60_000); expect(read('approval')).toMatchObject({ value: { state: 'open' } });
  expect(call('approvals.check', { id }, service)).toMatchObject({ code: 'denied' });
  grants.approvalRead = true; clock.advance(60_000); expect(read('approval')).toMatchObject({ value: { state: 'resolved', resolution: 'the approval was allowed' } });
  expect(call('approvals.open', { id }, service)).toMatchObject({ code: 'denied' });
  expect(call('approvals.check', { id }, { kind: 'agent', id: 'art' })).toMatchObject({ value: { state: 'allowed' } });
  // A member-private approval can be read only by that member, even when the ask is public.
  const privateAsk = call('approvals.request', { kind: 'merge', target: `github:acme/app#13@${'b'.repeat(40)}`, ask: 'Merge private work?', why: 'Fix it.', if_yes: 'I merge it.', if_no: 'I leave it.' }, { kind: 'agent', id: 'art' });
  expect(privateAsk).toMatchObject({ ok: true });
  const privateId = (privateAsk as { ok: true; value: { id: string } }).value.id;
  // Seed retained private filing as owning-piece fixture metadata, never through Attention.
  const row = app.db.prepare('SELECT record FROM approvals_approvals WHERE id=?').get(privateId) as { record: string };
  const record = { ...JSON.parse(row.record), member: 'jonathan' };
  app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify(record), privateId);
  expect(await app.operations.callAsync('socket', owner, 'approvals.answer', { id: privateId, action: 'allow' }, 'private-answer', true)).toMatchObject({ ok: true });
  expect(call('approvals.answer', { id, action: 'deny' }, service)).toMatchObject({ ok: false, code: 'denied' });
  raise('private-dependency', { approval: privateId });
  clock.advance(60_000); expect(read('private-dependency')).toMatchObject({ value: { state: 'open' } });
  expect(call('attention.checkWait', { id: 'private-dependency' })).toMatchObject({ value: { state: 'resolved' } });
});

it('installs one sweep and cancels it before database shutdown', async () => {
  const { app, clock, raise } = await setup();
  raise('pending', { task: 't-1' });
  const calls = vi.spyOn(app.operations, 'call');
  installAttentionMaintenance(app); installAttentionMaintenance(app);
  clock.advance(0);
  expect(calls.mock.calls.filter(c => c[2] === 'attention.sweepWaits')).toHaveLength(1);
  const closeDb = app.db.close.bind(app.db);
  vi.spyOn(app.db, 'close').mockImplementation(() => {
    const count = calls.mock.calls.length; clock.advance(120_000); expect(calls).toHaveBeenCalledTimes(count); return closeDb();
  });
  await app.close();
});

it.each(['inventoryRead', 'askType'] as const)('holds all unattended work when %s is revoked, then recovers', async grant => {
  const { clock, grants, raise, read, close, call } = await setup();
  raise('public', { task: 't-1' }); raise('private', { task: 't-1' }, { member: 'jonathan' }); close();
  expect(call('attention.pendingWaits', {}, service)).toMatchObject({ value: ['public'] });
  grants[grant] = false;
  expect(call('attention.pendingWaits', {}, service)).toMatchObject({ code: 'denied' });
  clock.advance(0); expect(read('public')).toMatchObject({ value: { state: 'open' } });
  grants[grant] = true; clock.advance(60_000);
  expect(read('public')).toMatchObject({ value: { state: 'resolved' } });
  expect(read('private')).toMatchObject({ value: { state: 'open' } });
});

it('stops inventory work while empty, resumes on a new ask and stops its observer on close', async () => {
  const { app, clock, call, raise, close, read } = await setup();
  const calls = vi.spyOn(app.operations, 'call');
  clock.advance(5 * 60_000);
  expect(calls.mock.calls.filter(c => c[2] === 'attention.sweepWaits')).toHaveLength(1);
  raise('later', { task: 't-1' }); close(); clock.advance(0);
  expect(read('later')).toMatchObject({ value: { state: 'resolved' } });
  clock.advance(0);
  const count = calls.mock.calls.filter(c => c[2] === 'attention.sweepWaits').length;
  clock.advance(5 * 60_000);
  expect(calls.mock.calls.filter(c => c[2] === 'attention.sweepWaits')).toHaveLength(count);
  const closeDb = app.db.close.bind(app.db);
  vi.spyOn(app.db, 'close').mockImplementation(() => {
    app.live.changed([{ type: 'attention.ask', id: 'after-close' }]);
    const before = calls.mock.calls.length; clock.advance(60_000);
    expect(calls).toHaveBeenCalledTimes(before); return closeDb();
  });
  await app.close();
});

it.each([10, 1000].flatMap(count => ['closed', 'open', 'answered'].map(state => [count, state] as const)))('checks %i %s task waits with a constant number of operation calls', async (count, state) => {
  const { app, clock, home } = await setup();
  new HouseholdDatabase(app.db).change(home, raw => { raw.owner = 'jonathan'; });
  const putTask = app.db.prepare('INSERT INTO tasks_tasks (ord,id,record,changed_at) VALUES (?,?,?,?)');
  const putAsk = app.db.prepare('INSERT INTO attention_asks VALUES (?,?)');
  app.db.transaction(() => {
    for (let n = 0; n < count; n++) {
      const id = `t-batch-${n}`;
      putTask.run(100 + n, id, JSON.stringify({ id, status: state === 'closed' ? 'closed' : 'open', comments: state === 'answered' ? [{ actor: 'jonathan', at: new Date(clock.now()).toISOString(), text: 'Yes, to: Check?' }] : [] }), clock.now());
      putAsk.run(`batch-${n}`, JSON.stringify({ id: `batch-${n}`, agent: 'art', ask: 'Check?', source: { kind: 'conversation', id: 'cv-fixture' }, waits_on: { task: id }, state: 'open', createdAt: clock.now(), changedAt: clock.now() }));
    }
  })();
  const calls = vi.spyOn(app.operations, 'call');
  clock.advance(0);
  const names = calls.mock.calls.map(c => c[2]);
  expect(names.filter(name => name === 'tasks.readMany')).toHaveLength(1);
  expect(calls.mock.calls.find(args => args[2] === 'tasks.readMany')?.[1]).toEqual(service);
  expect(names).not.toContain('tasks.show');
  // Retention, sweep, one Tasks batch, then the empty follow-up woken by live changes.
  expect(names).toEqual(['attention.retain', 'attention.sweepWaits', 'tasks.readMany', ...(state === 'open' ? [] : ['attention.sweepWaits'])]);
  expect((app.db.prepare("SELECT count(*) AS n FROM attention_asks WHERE json_extract(record, '$.state')='resolved'").get() as { n: number }).n).toBe(state === 'open' ? 0 : count);
});

it('keeps task batches under the original viewer and does not infer missing or hidden tasks are closed', async () => {
  const { call, raise, read } = await setup();
  // t-2 is pond-scoped in the fixture; pollock has no pond membership.
  expect(call('tasks.readMany', { ids: ['t-1', 't-2', 't-missing'] }, { kind: 'member', id: 'pollock' })).toMatchObject({ value: [{ id: 't-1' }] });
  expect(call('tasks.readMany', { ids: ['t-2'] }, { kind: 'agent', id: 'unknown' })).toMatchObject({ value: [] });
  raise('hidden-batch', { task: 't-2' });
  expect(call('attention.sweepWaits', {}, { kind: 'member', id: 'pollock' })).toMatchObject({ code: 'denied' });
  expect(read('hidden-batch')).toMatchObject({ value: { state: 'open' } });
});

it.each(['checkRead', 'resolveRead'] as const)('holds sweep work when per-ask %s is revoked', async grant => {
  const { grants, call, raise, read, close } = await setup();
  raise('held-grant', { task: 't-1' }); close(); grants[grant] = false;
  expect(call('attention.sweepWaits', {}, service)).toMatchObject({ value: { resolved: 0 } });
  expect(read('held-grant')).toMatchObject({ value: { state: 'open' } });
  grants[grant] = true;
  expect(call('attention.sweepWaits', {}, service)).toMatchObject({ value: { resolved: 1 } });
});
it.each(['unavailable', 'throw'] as const)('holds every task wait on a %s batch read, then recovers on a new sweep', async mode => {
  const { app, call, raise, read, close } = await setup();
  raise('failed-batch', { task: 't-1' }); close();
  const original = app.operations.call.bind(app.operations);
  vi.spyOn(app.operations, 'call').mockImplementation((...args) => {
    if (args[2] === 'tasks.readMany') {
      if (mode === 'throw') throw new Error('unavailable fixture');
      return failure('unavailable', 'unavailable fixture');
    }
    return original(...args);
  });
  expect(call('attention.sweepWaits', {}, service)).toMatchObject({ value: { resolved: 0 } });
  expect(read('failed-batch')).toMatchObject({ value: { state: 'open' } });
  vi.restoreAllMocks();
  expect(call('attention.sweepWaits', {}, service)).toMatchObject({ value: { resolved: 1 } });
});
it('rolls back all sweep updates, receipts and publication on a later failure, then retries and replays once', async () => {
  const { app, call, raise, close } = await setup();
  raise('rollback-a', { task: 't-1' }); raise('rollback-b', { task: 't-1' }); close();
  app.db.exec("CREATE TRIGGER fail_later_wait BEFORE UPDATE ON attention_asks WHEN NEW.id='rollback-b' BEGIN SELECT RAISE(ABORT, 'fixture later update'); END");
  const changed = vi.spyOn(app.live, 'changed');
  const before = app.db.prepare('SELECT * FROM core_operations').all();
  const sweep = () => app.operations.call('direct', service, 'attention.sweepWaits', {}, 'rollback-sweep');
  expect(sweep()).toMatchObject({ code: 'unavailable' });
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  expect(app.db.prepare("SELECT id FROM attention_asks WHERE json_extract(record,'$.state')='open'").all()).toHaveLength(2);
  expect(changed).not.toHaveBeenCalled();
  app.db.exec('DROP TRIGGER fail_later_wait');
  const answer = sweep(); expect(answer).toMatchObject({ value: { resolved: 2 } });
  expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'attention.ask', id: 'rollback-a' }, { type: 'attention.ask', id: 'rollback-b' }]);
  const batch = vi.spyOn(app.operations, 'call');
  expect(sweep()).toEqual(answer);
  expect(batch.mock.calls.filter(args => args[2] === 'tasks.readMany')).toHaveLength(0);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('excludes source-managed and private-question asks even with otherwise eligible public scopes and terminal tasks', async () => {
  const { app, call, raise, read, close } = await setup();
  raise('managed-exclusion', { task: 't-1' }); raise('private-exclusion', { task: 't-1' }); close();
  const readRow = app.db.prepare('SELECT record FROM attention_asks WHERE id=?');
  const put = app.db.prepare('UPDATE attention_asks SET record=? WHERE id=?');
  for (const [id, extra] of [['managed-exclusion', { sourceManaged: true }], ['private-exclusion', { privateQuestion: { thread: 'fixture', seq: 1 } }]] as const) {
    const row = readRow.get(id) as { record: string };
    put.run(JSON.stringify({ ...JSON.parse(row.record), ...extra }), id);
  }
  expect(call('attention.sweepWaits', {}, service)).toMatchObject({ value: { resolved: 0 } });
  expect(read('managed-exclusion')).toMatchObject({ value: { state: 'open' } });
  expect(read('private-exclusion')).toMatchObject({ value: { state: 'open' } });
});

it.each(['facts', 'policy', 'inventory', 'stop'] as const)('yields after 1000 raw waits and refreshes %s before continuing', async mode => {
  const { app, clock, grants, close } = await setup();
  close();
  const put = app.db.prepare('INSERT INTO attention_asks VALUES (?,?)');
  app.db.transaction(() => {
    for (let n = 0; n < 2001; n++) {
      const id = `slice-${n}`;
      put.run(id, JSON.stringify({ id, agent: 'art', ask: 'Check?', source: { kind: 'conversation', id: 'cv-fixture' }, waits_on: { task: 't-1' }, state: 'open', createdAt: clock.now(), changedAt: clock.now() }));
    }
  })();
  const resolved = () => (app.db.prepare("SELECT count(*) AS n FROM attention_asks WHERE json_extract(record, '$.state')='resolved'").get() as { n: number }).n;
  const calls = vi.spyOn(app.operations, 'call');
  let stopClose: Promise<void> | undefined;
  let closing = false;
  clock.at(clock.now(), () => {
    // Already queued work runs between slices, after exactly one committed page.
    expect(resolved()).toBe(1000);
    if (mode === 'facts') {
      const row = app.db.prepare('SELECT record FROM tasks_tasks WHERE id=?').get('t-1') as { record: string };
      app.db.prepare('UPDATE tasks_tasks SET record=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.record), status: 'open' }), 't-1');
    } else if (mode === 'policy') grants.resolveRead = false;
    else if (mode === 'inventory') grants.inventoryRead = false;
    else { closing = true; stopClose = app.close(); }
  });
  const cancellations: ReturnType<typeof vi.fn>[] = [];
  const at = clock.at.bind(clock);
  vi.spyOn(clock, 'at').mockImplementation((time, fn) => {
    const cancel = vi.fn(at(time, fn));
    if (!closing && time === clock.now()) cancellations.push(cancel);
    return cancel;
  });
  clock.advance(0);
  if (stopClose) {
    await stopClose;
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toHaveBeenCalledTimes(1);
  } else expect(resolved()).toBe(1000);
  const sweeps = calls.mock.calls.filter(c => c[2] === 'attention.sweepWaits');
  expect(sweeps.length).toBe(mode === 'stop' ? 1 : mode === 'inventory' ? 2 : 6);
  // First pass visits three pages; live resolutions request one fresh pass from the start.
  if (mode === 'facts' || mode === 'policy') {
    expect(sweeps.map(c => c[3])).toEqual([{}, { after: 1000 }, { after: 2000 }, {}, { after: 1000 }, { after: 2000 }]);
    expect(new Set(sweeps.map(c => c[4])).size).toBe(6);
  }
});

it('bounds raw ask scans even when every record is invisible or already resolved', async () => {
  const { app, call, clock } = await setup();
  const put = app.db.prepare('INSERT INTO attention_asks VALUES (?,?)');
  app.db.transaction(() => {
    for (let n = 0; n < 1002; n++) put.run(`hidden-${n}`, JSON.stringify({ id: `hidden-${n}`, agent: 'art', member: 'jonathan', state: 'open', waits_on: { task: 't-1' }, createdAt: clock.now() }));
  })();
  const fetched: number[] = [];
  const prepare = app.db.prepare.bind(app.db);
  vi.spyOn(app.db, 'prepare').mockImplementation(sql => {
    const query = prepare(sql);
    if (sql.startsWith('SELECT rowid AS cursor, record FROM attention_asks')) {
      const all = query.all.bind(query);
      vi.spyOn(query, 'all').mockImplementation((...args: unknown[]) => {
        const rows = all(...args); fetched.push(rows.length); return rows;
      });
    }
    return query;
  });
  expect(call('attention.sweepWaits', {}, service)).toEqual({ ok: true, value: { pending: 0, resolved: 0, next: 1000 } });
  expect(call('attention.sweepWaits', { after: 1000 }, service)).toEqual({ ok: true, value: { pending: 0, resolved: 0 } });
  expect(fetched).toEqual([1001, 2]);
});

it('revisits asks inserted behind the cursor during a multi-page pass', async () => {
  const { app, clock, raise, read, close } = await setup();
  close();
  const put = app.db.prepare('INSERT INTO attention_asks VALUES (?,?)');
  app.db.transaction(() => {
    for (let n = 0; n < 1001; n++) put.run(`resolved-${n}`, JSON.stringify({ id: `resolved-${n}`, agent: 'art', state: 'resolved' }));
  })();
  clock.at(clock.now(), () => {
    // Reusing an earlier row position models an update of a row already visited.
    app.db.prepare('DELETE FROM attention_asks WHERE id=?').run('resolved-0');
    raise('behind-cursor', { task: 't-1' });
    app.db.prepare('UPDATE attention_asks SET rowid=1 WHERE id=?').run('behind-cursor');
  });
  clock.advance(0);
  expect(read('behind-cursor')).toMatchObject({ value: { state: 'resolved', resolution: 't-1 is closed' } });
});
