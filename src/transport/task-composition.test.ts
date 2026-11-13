import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/index.js';
import { parseHouseholdDocument, type Household } from '../household.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { HouseholdRows } from '../core/household/rows.js';
import { installHouseholdTasks } from './task-composition.js';

const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
it('composes project operations with file household authority and shares tasks without importing household data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-task-composition-'));
  closes.push(() => rmSync(home, { recursive: true, force: true }));
  const raw = { v: 1, agents: ['art', 'mark'], members: [
    { person: 'jonathan', role: 'owner', agents: '*' },
    { person: 'second', role: 'member', agents: ['mark'] },
  ] };
  let household: Household | undefined = parseHouseholdDocument(home, raw);
  const app = await startLoom({ home, clock: new FakeClock(), install(app) { installHouseholdTasks(app, () => household); } });
  closes.push(app.close);
  const owner = { kind: 'member', id: 'jonathan' } as const;
  const second = { kind: 'member', id: 'second' } as const;
  const art = { kind: 'agent', id: 'art' } as const;
  const project = { slug: 'shared', name: 'Shared', repositories: [], members: ['second'], agents: ['art'] };
  const call = (viewer: typeof owner | typeof second | typeof art, name: string, input: unknown, id?: string) => app.operations.call('direct', viewer, name, input, id);
  expect(call(second, 'household.createProject', project, 'denied')).toMatchObject({ code: 'denied' });
  expect(call(art, 'household.createProject', project, 'agent-denied')).toMatchObject({ code: 'denied' });
  expect(call(owner, 'household.createProject', { ...project, agents: ['missing'] }, 'invalid')).toMatchObject({ code: 'invalid' });
  expect(app.db.prepare("SELECT value FROM tasks_meta WHERE key='source-checksum'").get()).toBeUndefined();
  expect(call(owner, 'household.createProject', project, 'project')).toEqual({ ok: true, value: project });
  expect(call(owner, 'tasks.create', { title: 'Shared task', project: 'shared', cli: true }, 'task')).toMatchObject({ ok: true, value: { result: { id: 't-1' } } });
  expect(call(second, 'tasks.show', { id: 't-1' })).toMatchObject({ ok: true, value: { result: { task: { id: 't-1' } } } });
  expect(call(art, 'tasks.show', { id: 't-1' })).toMatchObject({ ok: true, value: { result: { task: { id: 't-1' } } } });
  expect(new HouseholdDatabase(app.db).document()).toBeUndefined();
  // Conflicting database metadata must not replace current file authority.
  new HouseholdRows(app.db, 'settings').put('household-envelope', { fields: { v: 1 }, agents: [], members: [] });
  expect(call(owner, 'household.setProjectMembers', { slug: 'shared', members: [] }, 'remove')).toMatchObject({ ok: true });
  expect(call(second, 'tasks.show', { id: 't-1' })).toMatchObject({ ok: false, code: 'denied' });
  expect(call(owner, 'household.setProjectMembers', { slug: 'shared', members: ['second'] }, 'restore-member')).toMatchObject({ ok: true });
  household = parseHouseholdDocument(home, { ...raw, members: [raw.members[0]] });
  expect(call(second, 'tasks.show', { id: 't-1' })).toMatchObject({ ok: false, code: 'denied' });
  household = parseHouseholdDocument(home, { ...raw, members: [raw.members[0]], agents: ['mark'] });
  expect(call(art, 'tasks.show', { id: 't-1' })).toMatchObject({ ok: false, code: 'denied' });
  expect(call(owner, 'household.setProjectAgents', { slug: 'shared', agents: ['art'] }, 'removed-agent')).toMatchObject({ code: 'invalid' });
  household = parseHouseholdDocument(home, { ...raw, members: [
    { person: 'jonathan', role: 'member', agents: ['mark'] },
    { person: 'second', role: 'owner', agents: '*' },
  ] });
  expect(call(owner, 'household.setProjectAgents', { slug: 'shared', agents: [] }, 'former-owner')).toMatchObject({ code: 'denied' });
  expect(call(second, 'household.setProjectAgents', { slug: 'shared', agents: [] }, 'new-owner')).toMatchObject({ ok: true });
  household = undefined;
  expect(call(owner, 'household.setProjectAgents', { slug: 'shared', agents: [] }, 'no-household')).toMatchObject({ code: 'denied' });
});
