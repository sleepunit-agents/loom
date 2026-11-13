import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { HouseholdDatabase } from './document.js';
import { HouseholdRows } from './rows.js';
import { SharingDatabase } from './sharing.js';
import { fixture, installFixture } from '../../fixture.js';
import type { Viewer } from '../../policy.js';

const homes: string[] = [], closes: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const owner: Viewer = { kind: 'member', id: 'jonathan' }, member: Viewer = { kind: 'member', id: 'pollock' };
function home() { const h = mkdtempSync(join(tmpdir(), 'member-projects-')); homes.push(h); fixture(h); return h; }
async function setup() {
  const h = home(), clock = new FakeClock();
  const app = await startLoom({ next: true, home: h, clock, install: installFixture }); closes.push(app.close);
  return { h, clock, app, store: new SharingDatabase(app.db, h) };
}

it('replaces a member project list through owner policy on every door, preserving ownership and other metadata', async () => {
  const { app, h, store } = await setup();
  const household = new HouseholdDatabase(app.db).document();
  const rows = new HouseholdRows<Record<string, unknown>>(app.db, 'projects');
  rows.put('other', { ...store.project('other'), name: 'Other retained name', repositories: ['sleepunit-agents/other'], extra: { retain: true }, members: ['jonathan'] });
  rows.put('pond', { ...store.project('pond'), name: 'Pond retained name', repositories: ['sleepunit-agents/pond'], members: ['pollock', 'jonathan'], extra: { retain: 'pond' } });
  const before = rows.entries();
  const input = { person: 'pollock', projects: ['other', 'other'] };
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
    for (const viewer of [member, { kind: 'agent', id: 'art' }, { kind: 'member', id: 'missing' }, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'sharing' }] as Viewer[]) {
      expect(app.operations.call(door, viewer, 'household.setMemberProjects', input, `${door}:${viewer.id}`)).toMatchObject({ code: 'denied' });
    }
  }
  expect(rows.entries()).toEqual(before);
  for (const [person, projects, code] of [['missing', [], 'not-found'], ['pollock', ['absent'], 'invalid'], ['pollock', ['../pond'], 'invalid']] as const) {
    expect(app.operations.call('direct', owner, 'household.setMemberProjects', { person, projects }, 'invalid')).toMatchObject({ code });
  }
  expect(rows.entries()).toEqual(before);
  expect(() => store.setMemberProjects('pollock', [])).toThrow('transaction');
  expect(app.operations.call('http', owner, 'household.setMemberProjects', input, 'assign')).toEqual({ ok: true, value: ['other'] });
  expect(rows.entries()).toEqual(before.map(([id, row]) => [id, { ...row, members: id === 'pond' ? ['jonathan'] : ['jonathan', 'pollock'] }]));
  expect(new HouseholdDatabase(app.db).document()).toEqual(household);
  expect(store.sharing().members.pollock).toEqual({ owner: false, agents: ['pond-bot'] });
  expect(app.operations.call('mcp', owner, 'household.setMemberProjects', { person: 'pollock', projects: [] }, 'clear')).toEqual({ ok: true, value: [] });
  expect(store.project('other')?.members).toEqual(['jonathan']);
  // Household owners can have explicit project membership without changing their authority.
  expect(app.operations.call('socket', owner, 'household.setMemberProjects', { person: 'jonathan', projects: ['pond'] }, 'owner')).toEqual({ ok: true, value: ['pond'] });
  expect(store.sharing().members.jonathan.owner).toBe(true);
});

it('rolls back all project rows, retry receipts and events on failure, and replays after restart without reverting newer lists', async () => {
  const h = home(), clock = new FakeClock();
  const app = await startLoom({ next: true, home: h, clock, install: installFixture });
  const rows = new HouseholdRows(app.db, 'projects'), before = rows.entries();
  const events: unknown[] = [];
  app.live.observe(changes => { if (changes.length) events.push({ changes, inTransaction: app.db.inTransaction }); });
  const input = { person: 'pollock', projects: ['other'] };
  app.db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON household_projects WHEN NEW.id='pond' BEGIN SELECT RAISE(ABORT, 'row failed'); END`);
  expect(app.operations.call('direct', owner, 'household.setMemberProjects', input, 'assign')).toMatchObject({ code: 'unavailable' });
  expect(rows.entries()).toEqual(before);
  expect(events).toEqual([]);
  expect(app.db.prepare("SELECT * FROM core_operations WHERE id='assign'").get()).toBeUndefined();
  app.db.exec('DROP TRIGGER fail_second');
  app.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON core_operations WHEN NEW.id='assign' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`);
  expect(app.operations.call('direct', owner, 'household.setMemberProjects', input, 'assign')).toMatchObject({ code: 'unavailable' });
  expect(rows.entries()).toEqual(before);
  expect(events).toEqual([]);
  app.db.exec('DROP TRIGGER fail_receipt');
  const result = app.operations.call('direct', owner, 'household.setMemberProjects', input, 'assign');
  expect(result).toEqual({ ok: true, value: ['other'] });
  expect(events).toEqual([{ inTransaction: false, changes: [
    { type: 'household.project', id: 'other' }, { type: 'household.project', id: 'pond' }, { type: 'core.access', id: 'household' },
  ] }]);
  await app.close();
  const reopened = await startLoom({ next: true, home: h, clock, install: installFixture }); closes.push(reopened.close);
  const store = new SharingDatabase(reopened.db, h);
  expect(store.project('other')?.members).toContain('pollock');
  expect(store.project('pond')?.members).toEqual([]);
  expect(reopened.operations.call('direct', owner, 'household.setMemberProjects', { person: 'pollock', projects: ['pond'] }, 'newer')).toMatchObject({ ok: true });
  const replayEvents: unknown[] = []; reopened.live.observe(changes => { if (changes.length) replayEvents.push(changes); });
  expect(reopened.operations.call('mcp', owner, 'household.setMemberProjects', input, 'assign')).toEqual(result);
  expect(store.project('other')?.members).toEqual([]);
  expect(store.project('pond')?.members).toEqual(['pollock']);
  expect(replayEvents).toEqual([]);
});

it('refreshes subscribed project records synchronously after commit when a member moves projects', async () => {
  const h = home();
  const app = await startLoom({ next: true, home: h, clock: new FakeClock(), install: installFixture, authenticate: () => ({ viewer: member, valid: () => true }) }); closes.push(app.close);
  const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live'); closes.push(() => ws.terminate());
  const messages: unknown[] = [], pending: ((v: unknown) => void)[] = [];
  ws.on('message', raw => { const v: unknown = JSON.parse(raw.toString()); const receive = pending.shift(); if (receive) receive(v); else messages.push(v); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>(resolve => pending.push(resolve));
  await once(ws, 'open');
  ws.send(JSON.stringify({ kind: 'subscribe', type: 'example.record' }));
  expect(await next()).toMatchObject({ kind: 'set', records: expect.arrayContaining([expect.objectContaining({ id: 'pond-task' })]) });
  const refreshed: boolean[] = [], refresh = app.live.refreshAccess.bind(app.live);
  app.live.refreshAccess = () => { refreshed.push(app.db.inTransaction); refresh(); };
  expect(app.operations.call('direct', owner, 'household.setMemberProjects', { person: 'pollock', projects: ['other'] }, 'move')).toMatchObject({ ok: true });
  expect(refreshed).toEqual([false]);
  const result = await next();
  expect(result).toMatchObject({ kind: 'set', records: expect.arrayContaining([expect.objectContaining({ id: 'other-task' }), expect.objectContaining({ id: 'bot-task' })]) });
  expect(result).not.toMatchObject({ records: expect.arrayContaining([expect.objectContaining({ id: 'pond-task' })]) });
});
