import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture, installFixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { HouseholdDatabase } from './document.js';
import { HouseholdRows } from './rows.js';
import { SharingDatabase } from './sharing.js';
import { addHouseholdAgent } from './agents.js';
import type { Viewer } from '../../policy.js';

const homes: string[] = [], closes: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const owner: Viewer = { kind: 'member', id: 'jonathan' };
function home() { const h = mkdtempSync(join(tmpdir(), 'household-agent-')); homes.push(h); fixture(h); return h; }
function context(h: string, agent: string) {
  const dir = join(h, 'agents', agent); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# ${agent}\nPrivate creed\n`); return dir;
}
async function setup() {
  const h = home(), clock = new FakeClock();
  const app = await startLoom({ next: true, home: h, clock, install: installFixture }); closes.push(app.close);
  return { h, clock, app };
}

it('registers existing contexts only for household owners on every door, preserving all other metadata', async () => {
  const { app, h } = await setup();
  const household = new HouseholdDatabase(app.db);
  app.db.transaction(() => household.change(h, raw => { raw.extra = { retained: ['unknown'] }; raw.default = 'mark'; }))();
  const before = household.document()!, projects = new HouseholdRows(app.db, 'projects').entries();
  const tokens = new HouseholdRows(app.db, 'tokens').entries();
  const dir = context(h, 'new-agent'), creed = readFileSync(join(dir, 'IDENTITY.md'));
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
    for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'member', id: 'missing' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'sharing' }] as Viewer[]) {
      expect(app.operations.call(door, viewer, 'household.addAgent', { agent: 'new-agent' }, `${door}:${viewer.id}`)).toMatchObject({ code: 'denied' });
    }
  }
  // A scoped owner still cannot administer the household.
  app.db.transaction(() => household.change(h, raw => {
    (raw.members as Array<{ person: string; role: string }>).find(m => m.person === 'pollock')!.role = 'owner';
  }))();
  expect(app.operations.call('direct', { kind: 'member', id: 'pollock' }, 'household.addAgent', { agent: 'new-agent' }, 'scoped')).toMatchObject({ code: 'denied' });
  app.db.transaction(() => household.replace(h, before))();
  expect(household.document()).toEqual(before);
  expect(() => addHouseholdAgent(app.db, h, 'new-agent')).toThrow('transaction');
  const agents = [...before.agents as string[], 'new-agent'];
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
    expect(app.operations.call(door, owner, 'household.addAgent', { agent: 'new-agent' }, `owner:${door}`)).toEqual({ ok: true, value: agents });
  }
  expect(household.document()).toEqual({ ...before, agents });
  expect(new HouseholdRows(app.db, 'projects').entries()).toEqual(projects);
  const sharing = new SharingDatabase(app.db, h).sharing();
  expect(sharing.members.jonathan.agents).toContain('new-agent');
  expect(sharing.members.pollock.agents).toEqual(['pond-bot']);
  expect(readFileSync(join(dir, 'IDENTITY.md'))).toEqual(creed);
  expect(readdirSync(dir)).toEqual(['IDENTITY.md']);
  expect(new HouseholdRows(app.db, 'tokens').entries()).toEqual(tokens);
  // Existing agents keep legacy idempotent behavior even if their directory is offline.
  expect(app.operations.call('direct', owner, 'household.addAgent', { agent: 'art' }, 'existing')).toEqual({ ok: true, value: agents });
});

it('refuses invalid names, missing directories, files and aliases without creating household state', async () => {
  const { app, h } = await setup(), before = new HouseholdDatabase(app.db).document();
  for (const agent of ['../outside', 'Uppercase', '', 'a'.repeat(41), 'missing']) {
    expect(app.operations.call('direct', owner, 'household.addAgent', { agent }, `invalid:${agent}`)).toMatchObject({ code: 'invalid' });
  }
  const real = context(h, 'real');
  symlinkSync(real, join(h, 'agents', 'alias'));
  symlinkSync(join(h, 'absent'), join(h, 'agents', 'broken'));
  writeFileSync(join(h, 'agents', 'file'), 'not a context');
  for (const agent of ['alias', 'broken', 'file']) expect(app.operations.call('direct', owner, 'household.addAgent', { agent }, agent)).toMatchObject({ code: 'invalid' });
  expect(new HouseholdDatabase(app.db).document()).toEqual(before);
  expect(readdirSync(join(h, 'agents')).sort()).toEqual(['alias', 'broken', 'file', 'real']);
  rmSync(join(h, 'agents'), { recursive: true });
  const outside = join(h, 'outside'); mkdirSync(join(outside, 'linked'), { recursive: true });
  symlinkSync(outside, join(h, 'agents'));
  expect(app.operations.call('direct', owner, 'household.addAgent', { agent: 'linked' }, 'parent-alias')).toMatchObject({ code: 'invalid' });
  expect(new HouseholdDatabase(app.db).document()).toEqual(before);
});

it('rolls back rows and notifications with retry receipt failure and replays a stored result after restart', async () => {
  const { app, h, clock } = await setup(); context(h, 'new-agent');
  const household = new HouseholdDatabase(app.db), before = household.document()!;
  const events: unknown[] = [];
  app.live.observe(changes => { if (changes.length) events.push({ changes, inTransaction: app.db.inTransaction }); });
  app.db.exec(`CREATE TRIGGER fail_agent_row BEFORE INSERT ON household_agents WHEN NEW.id='new-agent' BEGIN SELECT RAISE(ABORT, 'row failed'); END`);
  expect(app.operations.call('direct', owner, 'household.addAgent', { agent: 'new-agent' }, 'row')).toMatchObject({ code: 'unavailable' });
  expect(household.document()).toEqual(before); expect(events).toEqual([]);
  app.db.exec('DROP TRIGGER fail_agent_row');
  app.db.exec(`CREATE TRIGGER fail_agent_retry BEFORE INSERT ON core_operations WHEN NEW.id='register' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`);
  expect(app.operations.call('http', owner, 'household.addAgent', { agent: 'new-agent' }, 'register')).toMatchObject({ code: 'unavailable' });
  expect(household.document()).toEqual(before); expect(events).toEqual([]);
  expect(app.db.prepare("SELECT * FROM core_operations WHERE id IN ('row', 'register')").all()).toEqual([]);
  app.db.exec('DROP TRIGGER fail_agent_retry');
  const result = app.operations.call('direct', owner, 'household.addAgent', { agent: 'new-agent' }, 'register');
  expect(result).toEqual({ ok: true, value: [...before.agents as string[], 'new-agent'] });
  expect(events).toEqual([{ inTransaction: false, changes: [{ type: 'household.sharing', id: 'household' }, { type: 'core.access', id: 'household' }] }]);
  await app.close();
  const reopened = await startLoom({ next: true, home: h, clock, install: installFixture }); closes.push(reopened.close);
  const nextStore = new HouseholdDatabase(reopened.db);
  expect(nextStore.household(h)?.agents).toContain('new-agent');
  context(h, 'later-agent');
  expect(reopened.operations.call('direct', owner, 'household.addAgent', { agent: 'later-agent' }, 'later')).toMatchObject({ ok: true });
  const newer = nextStore.document();
  const replayEvents: unknown[] = []; reopened.live.observe(changes => { if (changes.length) replayEvents.push(changes); });
  rmSync(join(h, 'agents', 'new-agent'), { recursive: true });
  expect(reopened.operations.call('mcp', owner, 'household.addAgent', { agent: 'new-agent' }, 'register')).toEqual(result);
  expect(nextStore.document()).toEqual(newer); expect(replayEvents).toEqual([]);
});

it('publishes newly registered agents to an open owner window and refreshes access after commit', async () => {
  const h = home(); context(h, 'new-agent');
  const app = await startLoom({ next: true, home: h, clock: new FakeClock(), install: installFixture,
    authenticate: () => ({ viewer: owner, valid: () => true }) }); closes.push(app.close);
  const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live'); closes.push(() => ws.terminate());
  const messages: unknown[] = [], pending: ((v: unknown) => void)[] = [];
  ws.on('message', raw => { const v: unknown = JSON.parse(raw.toString()); const receive = pending.shift(); if (receive) receive(v); else messages.push(v); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>(resolve => pending.push(resolve));
  await once(ws, 'open'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'household.sharing' }));
  expect(await next()).toMatchObject({ kind: 'set', records: [{ agents: ['art', 'mark', 'pond-bot'] }] });
  const refreshes: boolean[] = [], refresh = app.live.refreshAccess.bind(app.live);
  app.live.refreshAccess = () => { refreshes.push(app.db.inTransaction); refresh(); };
  const response = await fetch(`${app.url}/api/household/addAgent`, { method: 'POST', body: JSON.stringify({ input: { agent: 'new-agent' }, id: 'http-add' }) });
  expect(await response.json()).toEqual({ ok: true, value: ['art', 'mark', 'pond-bot', 'new-agent'] });
  expect(refreshes).toEqual([false]);
  expect(await next()).toMatchObject({ kind: 'set', records: [{ agents: ['art', 'mark', 'pond-bot', 'new-agent'] }] });
  expect(await next()).toMatchObject({ kind: 'put', record: { agents: ['art', 'mark', 'pond-bot', 'new-agent'] } });
});
