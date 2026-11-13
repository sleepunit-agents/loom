import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/clock.js';
import { fixture, installFixture } from '../../fixture.js';
import { SharingDatabase } from '../../core/household/sharing.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const h = mkdtempSync(join(tmpdir(), 'sharing-piece-')); homes.push(h); return h; }
const owner = { kind: 'member' as const, id: 'jonathan' }, member = { kind: 'member' as const, id: 'pollock' };
it('registers project operations on the fixture and shares tasks through their stored lists', async () => {
  const h = home(); fixture(h); const app = await startLoom({ home: h, clock: new FakeClock(), install: installFixture }); closes.push(app.close);
  expect(app.live).toBeDefined();
  expect(app.operations.call('direct', owner, 'household.createProject', { slug: 'garden', name: 'Garden', repositories: [], members: [], agents: [] }, 'create')).toMatchObject({ ok: true });
  const task = app.operations.call('direct', owner, 'tasks.create', { title: 'Garden work', project: 'garden', cli: true }, 'task');
  expect(task).toMatchObject({ ok: true, value: { result: { ok: true } } });
  expect(app.operations.call('direct', member, 'tasks.list', {}, undefined)).toMatchObject({ ok: true, value: { result: { entries: expect.arrayContaining([expect.objectContaining({ title: 'Pond work' })]) } } });
  expect(app.operations.call('direct', member, 'household.setProjectMembers', { slug: 'garden', members: ['pollock'] }, 'deny')).toMatchObject({ code: 'denied' });
  expect(app.operations.call('direct', owner, 'household.setProjectMembers', { slug: 'garden', members: ['pollock'] }, 'members')).toMatchObject({ ok: true });
  expect(app.operations.call('direct', owner, 'household.setProjectAgents', { slug: 'garden', agents: ['mark'] }, 'agents')).toMatchObject({ ok: true });
  expect(new SharingDatabase(app.db, h).sharing().projects.garden).toEqual({ members: ['pollock'], agents: ['mark'] });
  expect(app.operations.call('direct', member, 'tasks.list', {})).toMatchObject({ ok: true, value: { result: { entries: expect.arrayContaining([expect.objectContaining({ title: 'Garden work' })]) } } });
});
it('installs on an empty next home without opening legacy files or requiring an import marker', async () => {
  const h = home(), app = await startLoom({ home: h, clock: new FakeClock(),  }); closes.push(app.close);
  expect(app.operations.has('household.createProject')).toBe(true);
  expect(app.operations.call('direct', owner, 'household.createProject', { slug: 'garden', name: 'Garden', repositories: [], members: [], agents: [] }, 'create')).toMatchObject({ code: 'denied' });
});

it('installs database sharing by default without fixture installation or an import gate', async () => {
  const h = home(); fixture(h);
  const app = await startLoom({ home: h, clock: new FakeClock() }); closes.push(app.close);
  expect(app.operations.call('direct', owner, 'household.createProject', { slug: 'garden', name: 'Garden', repositories: [], members: ['pollock'], agents: ['mark'] }, 'create')).toMatchObject({ ok: true });
  expect(app.operations.call('direct', owner, 'tasks.create', { title: 'Garden work', project: 'garden', cli: true }, 'task')).toMatchObject({ ok: true });
  expect(app.operations.call('direct', member, 'tasks.list', {})).toMatchObject({ ok: true, value: { result: { entries: expect.arrayContaining([expect.objectContaining({ title: 'Garden work' })]) } } });
});

it('keeps GitHub attribution owner-managed, unambiguous and durable without granting access', async () => {
  const h = home(); fixture(h);
  const app = await startLoom({ home: h, clock: new FakeClock() });
  const input = { agent: 'art', accounts: { github: ['Art-Bot', 'art-bot'] } };
  for (const viewer of [member, { kind: 'agent' as const, id: 'art' }, { kind: 'service' as const, id: 'sharing' }]) {
    expect(app.operations.call('direct', viewer, 'household.setAgentAccounts', input, `deny-${viewer.kind}`)).toMatchObject({ code: 'denied' });
  }
  expect(app.operations.call('direct', owner, 'household.setAgentAccounts', input, 'set')).toMatchObject({ ok: true, value: { github: ['art-bot'] } });
  expect(app.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'mark', accounts: { github: ['ART-BOT'] } }, 'duplicate')).toMatchObject({ code: 'conflict' });
  expect(app.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'unknown', accounts: { github: [] } }, 'unknown')).toMatchObject({ code: 'invalid' });
  expect(app.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'art', accounts: { github: ['https://github.com/art'] } }, 'invalid')).toMatchObject({ ok: false });
  expect(new SharingDatabase(app.db, h).sharing().members['art-bot']).toBeUndefined();
  await app.close();
  const reopened = await startLoom({ home: h, clock: new FakeClock() }); closes.push(reopened.close);
  const { HouseholdAccounts } = await import('../../core/household/accounts.js');
  const accounts = new HouseholdAccounts(reopened.db, h);
  expect(accounts.get('art')).toEqual({ github: ['art-bot'] });
  expect(accounts.get('mark')).toEqual({ github: [] });
  expect(reopened.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'art', accounts: { github: [] } }, 'clear')).toMatchObject({ ok: true });
  expect(accounts.get('art')).toEqual({ github: [] });
});
