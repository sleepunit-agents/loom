import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation, type Foundation } from './app.js';
import { FakeClock } from './clock.js';
import { migrateHouseholdTables } from './household/schema.js';
import { SharingDatabase } from './household/sharing.js';
import { builtinServices } from './services.js';
import { mayAct, maySee } from '../policy.js';
import { installChanges } from '../pieces/changes/index.js';
import { installTasks } from '../pieces/tasks/index.js';
import { installApprovals } from '../pieces/approvals/index.js';
import { installAttention } from '../pieces/attention/index.js';
import { installBridges } from '../pieces/bridges/index.js';
import { installClock } from '../pieces/clock/index.js';
import { installExample } from '../pieces/example/index.js';
import { installMindKnowledge } from '../pieces/mind/index.js';
import { installRuntime } from '../pieces/runtime/index.js';
import { installSecrets } from '../pieces/secrets/index.js';
import { installSharing } from '../pieces/sharing/index.js';
import { startChangesJob } from '../pieces/changes/jobs.js';

const homes: string[] = [], apps: Foundation[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(home = mkdtempSync(join(tmpdir(), 'loom-services-'))) {
  if (!homes.includes(home)) homes.push(home);
  const app = createFoundation({ home, clock: new FakeClock() }); apps.push(app);
  migrateHouseholdTables(app.db);
  const store = new SharingDatabase(app.db, home);
  return { app, store, home };
}
it('registers only installed built-ins, isolates homes and rebuilds authority on restart', () => {
  const { app, store, home } = fixture();
  const sharing = () => store.sharing();
  expect(sharing().services).toEqual({});
  installChanges(app.db, app.operations, app.live, sharing);
  expect(sharing().services.changes.types).toEqual(['change', 'change-sync']);
  expect(sharing().services.changes.operations).toContain('changes.list');
  expect(fixture().store.sharing().services).toEqual({});
  // openDb leases share a connection; use a real independent connection here.
  const secondConnection = new Database(join(home, 'loom.db'));
  try { expect(new SharingDatabase(secondConnection, home).sharing().services).toEqual({}); }
  finally { secondConnection.close(); }
  const sharingServices = sharing().services;
  app.close();
  const reopened = fixture(home);
  expect(reopened.store.sharing().services).toEqual({});
  installChanges(reopened.app.db, reopened.app.operations, reopened.app.live, () => reopened.store.sharing());
  expect(reopened.store.sharing().services).toEqual(sharingServices);
});
it('keeps own types narrow, private records closed, household actions closed, and cross-piece calls ungranted', () => {
  const { app, store } = fixture(), sharing = () => store.sharing();
  installChanges(app.db, app.operations, app.live, sharing);
  installTasks(app.db, app.operations, app.live, sharing);
  const changes = { kind: 'service' as const, id: 'changes' };
  const snapshot = sharing();
  expect(maySee(changes, { type: 'change', project: 'any', agent: 'any' }, snapshot)).toBe(true);
  expect(mayAct(changes, { type: 'change' }, snapshot, 'act', 'changes.list')).toBe(true);
  expect(maySee(changes, { type: 'change', member: 'jonathan' }, snapshot)).toBe(false);
  expect(maySee(changes, { type: 'task' }, snapshot)).toBe(false);
  expect(mayAct(changes, { type: 'change' }, snapshot, 'act', 'tasks.list')).toBe(false);
  expect(mayAct(changes, { type: 'change' }, snapshot, 'household', 'changes.refresh')).toBe(false);
  expect(mayAct(changes, { type: 'change' }, snapshot, 'answer-person', 'changes.answer')).toBe(false);
  expect(maySee({ kind: 'service', id: 'uninstalled' }, { type: 'change' }, snapshot)).toBe(false);
  expect(app.operations.call('direct', changes, 'changes.list', {})).toMatchObject({ ok: true });
  expect(app.operations.call('direct', changes, 'tasks.list', {})).toMatchObject({ code: 'denied' });
  expect(() => snapshot.services.changes.types.push('task')).toThrow(TypeError);
  expect(() => snapshot.services.changes.operations.push('tasks.list')).toThrow(TypeError);
  expect(() => { snapshot.services.changes.types = ['task']; }).toThrow(TypeError);
  expect(() => { snapshot.services.changes.operations = ['tasks.list']; }).toThrow(TypeError);
  expect(() => { snapshot.services.changes = { types: ['task'], operations: ['tasks.list'] }; }).toThrow(TypeError);
  expect(() => { snapshot.services.intruder = { types: ['task'], operations: ['tasks.list'] }; }).toThrow(TypeError);
  expect(builtinServices(app.db).changes.types).not.toContain('task');
  expect(builtinServices(app.db).changes.operations).not.toContain('tasks.list');
});
it('includes direct-only job operations registered after the piece without granting another namespace', () => {
  const { app, store } = fixture(), sharing = () => store.sharing();
  installChanges(app.db, app.operations, app.live, sharing);
  expect(sharing().services.changes.operations).not.toContain('changes.commit-sync');
  const job = startChangesJob(app, { clock: app.operations.clock, sharing,
    viewer: { kind: 'service', id: 'changes' }, projects: { list: () => [] },
    attribution: () => ({ agents: {}, ownerLogins: [] }), knownAgents: () => [], read: async () => [],
  }); app.onClose(job.close);
  expect(sharing().services.changes.operations).toContain('changes.commit-sync');
  // Registration does not turn a job's existing household check into owner authority.
  expect(mayAct({ kind: 'service', id: 'changes' }, { type: 'change' }, sharing(), 'household', 'changes.commit-sync')).toBe(false);
});

it('registers the own types and exact namespace operations for every in-repo installer', () => {
  const { app, store, home } = fixture(), sharing = () => store.sharing();
  installSharing(app, home);
  for (const install of [installChanges, installTasks, installApprovals, installAttention, installExample, installRuntime, installSecrets]) install(app.db, app.operations, app.live, sharing);
  installBridges(app, sharing);
  app.onClose(installClock(app.db, app.operations, app.live, sharing).close);
  app.onClose(installMindKnowledge(app.operations, app.live, { path: join(home, 'absent.db'), sharing }).close);
  const types = {
    changes: ['change', 'change-sync'], tasks: ['task'], approvals: ['approval', 'approval-rule'],
    attention: ['attention.ask', 'attention.agent', 'attention.conversation', 'attention.turn', 'attention.digest', 'attention.day', 'attention.finding', 'task', 'approval'],
    example: ['example.record'], runtime: ['runtime.box', 'runtime.job', 'runtime.settings', 'runtime.binding'],
    secrets: ['secret.name', 'secret.grant', 'secret.request', 'secret.policy', 'secret.change'],
    bridges: ['bridges.venue', 'bridges.route', 'bridges.link', 'bridges.send'],
    clock: ['wake', 'schedule', 'clock', 'approval', 'runtime.job'], mind: ['knowledge'], sharing: ['household.project', 'household.sharing'],
  };
  const snapshot = sharing();
  expect(Object.keys(snapshot.services).sort()).toEqual(Object.keys(types).sort());
  for (const [id, ownTypes] of Object.entries(types)) {
    expect(snapshot.services[id].types).toEqual(ownTypes);
    const namespace = id === 'sharing' ? 'household' : id;
    const ownOperations = app.operations.offered('direct').map(op => op.name).filter(name => name.startsWith(namespace + '.') || id==='attention' && ['tasks.show','approvals.check'].includes(name) || id==='clock' && ['runtime.acceptClock','approvals.piece-request','approvals.piece-use-local','approvals.piece-standing-local','approvals.piece-standing-local-check'].includes(name));
    expect(ownOperations.length).toBeGreaterThan(0);
    expect(snapshot.services[id].operations).toEqual(ownOperations);
    for (const type of ownTypes) expect(maySee({ kind: 'service', id }, { type }, snapshot)).toBe(true);
    for (const [other, otherTypes] of Object.entries(types)) if (other !== id) {
      for (const type of otherTypes.filter(type=>!ownTypes.includes(type))) expect(maySee({ kind: 'service', id }, { type }, snapshot)).toBe(false);
    }
  }
});

it('supports multiple operation registries leasing one database and removes only closed installations', () => {
  const first = fixture(), second = fixture(first.home);
  expect(second.app.db).toBe(first.app.db);
  installChanges(first.app.db, first.app.operations, first.app.live, () => first.store.sharing());
  installChanges(second.app.db, second.app.operations, second.app.live, () => second.store.sharing());
  first.app.close();
  expect(second.store.sharing().services.changes.operations).toContain('changes.list');
  second.app.operations.close();
  expect(second.store.sharing().services).toEqual({});
});

it('composes only the exact Clock local lifecycle calls across the Approvals boundary',()=>{
 const {app,store}=fixture(),sharing=()=>store.sharing();
 installApprovals(app.db,app.operations,app.live,sharing);
 const jobs=installClock(app.db,app.operations,app.live,sharing);app.onClose(jobs.close);
 const v={kind:'service' as const,id:'clock'},s=sharing();
 for(const name of ['approvals.piece-request','approvals.piece-use-local','approvals.piece-standing-local','approvals.piece-standing-local-check'])
  expect(mayAct(v,{type:'approval'},s,'act',name)).toBe(true);
 for(const name of ['approvals.answer','approvals.grant','approvals.piece-use','approvals.standing','approvals.piece-withdraw'])
  expect(mayAct(v,{type:'approval'},s,'act',name)).toBe(false);
 expect(maySee(v,{type:'approval',member:'jonathan'},s)).toBe(false);
});
