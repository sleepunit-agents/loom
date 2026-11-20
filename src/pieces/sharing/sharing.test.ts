import { once } from 'node:events';
import { WebSocket } from 'ws';
import { HouseholdDatabase } from '../../core/household/document.js';
import { HouseholdRows } from '../../core/household/rows.js';
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
  const document = new HouseholdDatabase(app.db).document();
  const agentRows = new HouseholdRows(app.db, 'agents').entries();
  const input = { agent: 'art', accounts: { github: ['Art-Bot', 'art-bot'] } };
  for (const viewer of [member, { kind: 'agent' as const, id: 'art' }, { kind: 'service' as const, id: 'sharing' }]) {
    expect(app.operations.call('direct', viewer, 'household.setAgentAccounts', input, `deny-${viewer.kind}`)).toMatchObject({ code: 'denied' });
  }
  expect(app.operations.call('direct', owner, 'household.setAgentAccounts', input, 'set')).toMatchObject({ ok: true, value: { github: ['art-bot'] } });
  expect(app.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'mark', accounts: { github: ['ART-BOT'] } }, 'duplicate')).toMatchObject({ code: 'conflict' });
  expect(app.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'unknown', accounts: { github: [] } }, 'unknown')).toMatchObject({ code: 'invalid' });
  expect(app.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'art', accounts: { github: ['https://github.com/art'] } }, 'invalid')).toMatchObject({ ok: false });
  expect(new SharingDatabase(app.db, h).sharing().members['art-bot']).toBeUndefined();
  expect(new HouseholdDatabase(app.db).document()).toEqual(document);
  expect(new HouseholdRows(app.db, 'agents').entries()).toEqual(agentRows);
  await app.close();
  const reopened = await startLoom({ home: h, clock: new FakeClock() }); closes.push(reopened.close);
  const { HouseholdAccounts } = await import('../../core/household/accounts.js');
  const accounts = new HouseholdAccounts(reopened.db, h);
  expect(accounts.get('art')).toEqual({ github: ['art-bot'] });
  expect(accounts.get('mark')).toEqual({ github: [] });
  expect(reopened.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'art', accounts: { github: [] } }, 'clear')).toMatchObject({ ok: true });
  expect(accounts.get('art')).toEqual({ github: [] });
  expect(new HouseholdDatabase(reopened.db).document()).toEqual(document);
  expect(new HouseholdRows(reopened.db, 'agents').entries()).toEqual(agentRows);
});


it('publishes account assignment and clearing to a subscribed owner after commit', async () => {
  const h = home(); fixture(h);
  const app = await startLoom({ home: h, clock: new FakeClock(), authenticate: () => ({ viewer: owner, valid: () => true }) }); closes.push(app.close);
  const socket = new WebSocket(app.url.replace('http', 'ws') + '/live');
  await once(socket, 'open');
  const next = () => once(socket, 'message').then(([raw]) => JSON.parse(raw.toString()));
  try {
    const initial = next(); socket.send(JSON.stringify({ kind: 'subscribe', type: 'household.sharing' }));
    expect(await initial).toMatchObject({ kind: 'set', records: [{ agentAccounts: { art: { github: [] } } }] });
    const document = new HouseholdDatabase(app.db).document();
    for (const [id, github] of [['assign', ['art-bot']], ['clear', []]] as const) {
      const update = next();
      expect(app.operations.call('direct', owner, 'household.setAgentAccounts', { agent: 'art', accounts: { github: [...github] } }, id)).toMatchObject({ ok: true });
      expect(await update).toMatchObject({ kind: 'put', type: 'household.sharing', record: { agentAccounts: { art: { github: [...github] } } } });
      expect(app.db.inTransaction).toBe(false);
      expect(new HouseholdDatabase(app.db).document()).toEqual(document);
    }
  } finally { socket.terminate(); }
});

it('projects only membership fields to owners and evicts the projection when ownership ends', async () => {
  const h = home(); fixture(h);
  const viewer = { ...owner };
  const app = await startLoom({ home: h, clock: new FakeClock(), authenticate: () => ({ viewer, valid: () => true }) }); closes.push(app.close);
  app.db.transaction(() => new HouseholdDatabase(app.db).change(h, raw => {
    (raw.members as Array<Record<string, unknown>>)[0].privateImportedValue = 'must-not-project';
  }))();
  const socket = new WebSocket(app.url.replace('http', 'ws') + '/live'); await once(socket, 'open');
  const next = () => once(socket, 'message').then(([raw]) => JSON.parse(raw.toString()));
  try {
    const initial = next(); socket.send(JSON.stringify({ kind: 'subscribe', type: 'household.sharing' }));
    const record = (await initial).records[0];
    expect(record.defaultAgent).toBe('art');
    expect(record.membership).toEqual([{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'pollock', role: 'member', agents: ['pond-bot'] }]);
    expect(JSON.stringify(record)).not.toContain('must-not-project');
    const denied = next(); viewer.id = 'pollock'; app.live.refreshAccess();
    const revoked = await denied;
    expect(JSON.stringify(revoked)).not.toContain('membership');
    expect(revoked).toMatchObject({ kind: 'set', records: [] });
  } finally { socket.terminate(); }
});
