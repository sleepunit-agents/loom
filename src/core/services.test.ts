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
  app.close();
  expect(fixture(home).store.sharing().services).toEqual({});
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
  snapshot.services.changes.types.push('task'); snapshot.services.changes.operations.push('tasks.list');
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
