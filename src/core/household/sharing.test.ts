import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import type { Foundation } from '../app.js';
import { FakeClock } from '../clock.js';
import { HouseholdDatabase } from './document.js';
import { migrateHouseholdTables } from './schema.js';
import { HouseholdRows } from './rows.js';
import { SharingDatabase } from './sharing.js';
import { installHouseholdProjects } from './operations.js';
import { parseHouseholdDocument, firstOwner } from '../../household.js';
import { maySee, mayAct, type Viewer } from '../../policy.js';
import { installExample } from '../../pieces/example/index.js';

const homes: string[] = [];
const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() { const h = mkdtempSync(join(tmpdir(), 'loom-sharing-')); homes.push(h); return h; }
const raw = () => ({ v: 1, agents: ['art', 'mark', 'pond-bot'], members: [
  { person: 'jonathan', role: 'owner', agents: '*' },
  { person: 'pollock', role: 'member', agents: ['pond-bot'] },
  { person: 'guest', role: 'member', agents: [] },
] });
const pond = { slug: 'pond', name: 'Pond', repositories: ['sleepunit-agents/pond'], members: ['pollock'], agents: ['pond-bot', 'art'] };
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const pollock: Viewer = { kind: 'member', id: 'pollock' };
const bot: Viewer = { kind: 'agent', id: 'pond-bot' };
function seed(app: Foundation, h: string) {
  migrateHouseholdTables(app.db);
  app.db.transaction(() => new HouseholdDatabase(app.db).replace(h, raw()))();
  const store = new SharingDatabase(app.db, h);
  installHouseholdProjects(app, h);
  return store;
}
async function fixture() {
  const h = home();
  let store!: SharingDatabase;
  const app = await startLoom({ home: h, clock: new FakeClock(), install(app) { store = seed(app, h); } }); closes.push(app.close);
  return { h, app, store };
}

it('keeps legacy scoped ownership, supports members with no owned agents, and forbids member wildcard authority', () => {
  const h = home();
  const legacy = parseHouseholdDocument(h, { v: 1, agents: ['art'], owner: 'Jonathan' });
  expect(firstOwner(legacy)).toEqual({ person: 'jonathan', role: 'owner', agents: '*' });
  const doc = raw();
  doc.members[1].role = 'owner';
  const scoped = parseHouseholdDocument(h, doc);
  expect(scoped.members[1]).toEqual({ person: 'pollock', role: 'owner', agents: ['pond-bot'] });
  expect(parseHouseholdDocument(h, raw()).members[2]).toEqual({ person: 'guest', role: 'member', agents: [] });
  for (const role of ['admin', 'member']) expect(() => parseHouseholdDocument(h, { ...raw(), members: [{ person: 'guest', role, agents: '*' }] })).toThrow();
  expect(() => parseHouseholdDocument(h, { ...raw(), members: [{ person: 'guest', role: 'owner', agents: [] }] })).toThrow();
  expect(() => parseHouseholdDocument(h, { ...raw(), members: [raw().members[1]] })).toThrow('at least one');
});

it('reads persisted sharing, preserves raw fields, and applies the owner example with central policy', async () => {
  const { app, store, h } = await fixture();
  const doc = { ...raw(), custom: { untouched: true } };
  app.db.transaction(() => {
    new HouseholdDatabase(app.db).replace(h, doc);
    store.create(pond);
    store.create({ ...pond, slug: 'other', members: [], agents: ['art'] });
  })();
  expect(new HouseholdDatabase(app.db).document()).toEqual(doc);
  const sharing = store.sharing();
  expect(sharing.members).toEqual({ jonathan: { owner: true, agents: ['art', 'mark', 'pond-bot'] }, pollock: { owner: false, agents: ['pond-bot'] }, guest: { owner: false, agents: [] } });
  for (const viewer of [pollock, bot]) {
    expect(maySee(viewer, { project: 'pond', agent: 'art' }, sharing)).toBe(true);
    expect(maySee(viewer, { project: 'other', agent: 'pond-bot' }, sharing)).toBe(false);
    expect(maySee(viewer, { agent: 'pond-bot' }, sharing)).toBe(true);
    expect(maySee(viewer, { member: 'jonathan', project: 'pond' }, sharing)).toBe(false);
    expect(mayAct(viewer, {}, sharing, 'household')).toBe(false);
  }
  expect(mayAct(pollock, { agent: 'pond-bot' }, sharing, 'give-work')).toBe(true);
  expect(mayAct(pollock, { project: 'pond', agent: 'art' }, sharing, 'give-work')).toBe(false);
  expect(mayAct(bot, { agent: 'pond-bot' }, sharing, 'give-work')).toBe(false);
  expect(maySee(pollock, { member: 'pollock' }, sharing)).toBe(true);
  expect(maySee(owner, { member: 'pollock' }, sharing)).toBe(false);
  expect(mayAct(owner, {}, sharing, 'household')).toBe(true);
  expect(readdirSync(h).filter(n => n.endsWith('.json'))).toEqual([]);
});

it('keeps absent metadata empty and fails closed on corrupt project content or a mismatched key', async () => {
  const h = home(), app = await startLoom({ home: h, clock: new FakeClock(), install: app => migrateHouseholdTables(app.db) }); closes.push(app.close);
  const store = new SharingDatabase(app.db, h);
  expect(store.sharing()).toMatchObject({ members: {}, projects: {} });
  expect(Object.keys(store.sharing().services).sort()).toEqual(['approvals', 'sharing', 'tasks']);
  expect(() => store.create(pond)).toThrow('transaction');
  expect(() => app.db.transaction(() => store.create(pond))()).toThrow('not been imported');
  app.db.transaction(() => new HouseholdDatabase(app.db).replace(h, raw()))();
  const rows = new HouseholdRows(app.db, 'projects');
  rows.put('pond', { ...pond, slug: 'wrong' });
  expect(() => store.sharing()).toThrow('key mismatch');
  rows.put('pond', { ...pond, members: '*' });
  expect(() => store.sharing()).toThrow();
});

it('requires an owner on every door, validates references, and rolls back project writes with the enclosing operation', async () => {
  const { app, store } = await fixture();
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
    for (const viewer of [pollock, bot, { kind: 'member', id: 'missing' }, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'keyholder' }] as Viewer[]) {
      expect(app.operations.call(door, viewer, 'household.createProject', pond, `${door}:${viewer.id}`)).toMatchObject({ code: 'denied' });
    }
  }
  expect(store.project('pond')).toBeUndefined();
  for (const input of [{ ...pond, members: ['missing'] }, { ...pond, agents: ['missing'] }, { ...pond, slug: '../pond' }]) {
    expect(app.operations.call('direct', owner, 'household.createProject', input, 'invalid')).toMatchObject({ code: 'invalid' });
  }
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual([]);
  const input = { ...pond, members: ['pollock', 'pollock'], agents: ['pond-bot', 'pond-bot'], repositories: ['a/b', 'a/b'] };
  const result = app.operations.call('direct', owner, 'household.createProject', input, 'create');
  expect(result).toMatchObject({ ok: true, value: { members: ['pollock'], agents: ['pond-bot'], repositories: ['a/b'] } });
  for (const name of ['household.setProjectMembers', 'household.setProjectAgents']) {
    const change = name.endsWith('Members') ? { members: [] } : { agents: [] };
    expect(app.operations.call('direct', pollock, name, { slug: 'pond', ...change }, name)).toMatchObject({ code: 'denied' });
    expect(app.operations.call('direct', owner, name, { slug: 'absent', ...change }, name)).toMatchObject({ code: 'not-found' });
    const bad = name.endsWith('Members') ? { members: ['missing'] } : { agents: ['missing'] };
    expect(app.operations.call('direct', owner, name, { slug: 'pond', ...bad }, 'bad:' + name)).toMatchObject({ code: 'invalid' });
  }
  expect(app.operations.call('direct', owner, 'household.createProject', pond, 'duplicate')).toMatchObject({ code: 'conflict' });
  expect(() => app.db.transaction(() => { store.setMembers('pond', []); throw new Error('abort'); })()).toThrow('abort');
  expect(store.project('pond')?.members).toEqual(['pollock']);
  expect(app.operations.call('mcp', owner, 'household.createProject', input, 'create')).toEqual(result);
  expect(app.operations.call('socket', owner, 'household.createProject', pond, 'create')).toMatchObject({ code: 'conflict' });
});

it('drops stale removed member and agent references and preserves legacy scoped owner limits', async () => {
  const { app, h, store } = await fixture();
  app.db.transaction(() => store.create(pond))();
  const doc = raw(); doc.members[1].role = 'owner';
  app.db.transaction(() => new HouseholdDatabase(app.db).replace(h, doc))();
  expect(store.sharing().members.pollock).toEqual({ owner: false, agents: ['pond-bot'] });
  expect(mayAct(pollock, { agent: 'pond-bot' }, store.sharing(), 'give-work')).toBe(true);
  expect(mayAct(pollock, { agent: 'art', project: 'pond' }, store.sharing(), 'give-work')).toBe(false);
  expect(mayAct(pollock, {}, store.sharing(), 'household')).toBe(false);
  doc.members = doc.members.filter(m => m.person !== 'pollock'); doc.agents = ['art', 'mark'];
  app.db.transaction(() => new HouseholdDatabase(app.db).replace(h, doc))();
  expect(store.sharing().projects.pond).toEqual({ members: [], agents: ['art'] });
  expect(maySee(bot, { project: 'pond' }, store.sharing())).toBe(false);
  expect(maySee(pollock, { project: 'pond' }, store.sharing())).toBe(false);
});

it('preserves unknown project metadata through both list changes and operation retries', async () => {
  const { app, store } = await fixture();
  const project = { ...pond, extra: { color: 'blue', nested: [1, { label: 'unchanged' }] } };
  const create = app.operations.call('direct', owner, 'household.createProject', project, 'with-metadata');
  expect(create).toEqual({ ok: true, value: project });
  expect(app.operations.call('http', owner, 'household.setProjectMembers', { slug: 'pond', members: ['guest'] }, 'members')).toEqual({ ok: true, value: { ...project, members: ['guest'] } });
  expect(app.operations.call('socket', owner, 'household.setProjectAgents', { slug: 'pond', agents: ['mark'] }, 'agents')).toEqual({ ok: true, value: { ...project, members: ['guest'], agents: ['mark'] } });
  expect(store.project('pond')).toEqual({ ...project, members: ['guest'], agents: ['mark'] });
  expect(store.sharing().projects.pond).toEqual({ members: ['guest'], agents: ['mark'] });
  expect(app.operations.call('mcp', owner, 'household.createProject', project, 'with-metadata')).toEqual(create);
});

it('persists project changes across restart and rolls back retry state and notifications on a failed write', async () => {
  const h = home(), clock = new FakeClock();
  let store!: SharingDatabase;
  const first = await startLoom({ home: h, clock, install(app) { store = seed(app, h); } });
  const result = first.operations.call('direct', owner, 'household.createProject', pond, 'create');
  expect(result.ok).toBe(true);
  expect(() => store.setAgents('pond', [])).toThrow('transaction');
  expect(() => store.setMembers('pond', [])).toThrow('transaction');
  await first.close();
  const app = await startLoom({ home: h, clock, install: app => installHouseholdProjects(app, h) }); closes.push(app.close);
  const reopened = new SharingDatabase(app.db, h);
  expect(reopened.project('pond')).toEqual(pond);
  expect(app.operations.call('http', owner, 'household.createProject', pond, 'create')).toEqual(result);
  const changes: unknown[] = [];
  const changed = app.live.changed.bind(app.live);
  app.live.changed = events => { changes.push({ inTransaction: app.db.inTransaction, events }); changed(events); };
  app.db.exec(`CREATE TRIGGER fail_project AFTER UPDATE ON household_projects BEGIN SELECT RAISE(ABORT, 'failed project'); END`);
  expect(app.operations.call('direct', owner, 'household.setProjectMembers', { slug: 'pond', members: [] }, 'fail')).toMatchObject({ code: 'unavailable' });
  expect(reopened.project('pond')).toEqual(pond);
  expect(changes).toEqual([]);
  expect(app.db.prepare("SELECT * FROM core_operations WHERE id='fail'").get()).toBeUndefined();
  app.db.exec('DROP TRIGGER fail_project');
  // This fails after the operation has queued both notifications, during retry-result insertion.
  app.db.exec(`CREATE TRIGGER fail_retry BEFORE INSERT ON core_operations WHEN NEW.id='fail-after-change' BEGIN SELECT RAISE(ABORT, 'failed retry'); END`);
  expect(app.operations.call('direct', owner, 'household.setProjectMembers', { slug: 'pond', members: [] }, 'fail-after-change')).toMatchObject({ code: 'unavailable' });
  expect(reopened.project('pond')).toEqual(pond);
  expect(changes).toEqual([]);
  expect(app.db.prepare("SELECT * FROM core_operations WHERE id='fail-after-change'").get()).toBeUndefined();
  app.db.exec('DROP TRIGGER fail_retry');
  expect(app.operations.call('direct', owner, 'household.setProjectMembers', { slug: 'pond', members: [] }, 'fail')).toMatchObject({ ok: true });
  expect(reopened.project('pond')?.members).toEqual([]);
  expect(changes).toEqual([{ inTransaction: false, events: [{ type: 'household.project', id: 'pond' }, { type: 'core.access', id: 'household' }] }]);
  clock.advance(30 * 86400_000);
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual([]);
});

it('uses database sharing over HTTP and evicts project records on member/agent changes without polling', async () => {
  const h = home(), clock = new FakeClock();
  let store: SharingDatabase;
  const app = await startLoom({ home: h, clock, install(app) {
    store = seed(app, h);
    installExample(app.db, app.operations, app.live, () => store.sharing());
  }, authenticate(req) {
    const id = req.headers.authorization?.replace('Bearer ', '');
    if (!id) return;
    const viewer: Viewer = id === 'pond-bot' ? bot : { kind: 'member', id };
    return { viewer, valid: () => viewer.kind === 'agent' || Object.hasOwn(store.sharing().members, viewer.id) };
  } }); closes.push(app.close);
  const post = async (name: string, input: unknown, id: string, member = 'jonathan') => {
    const [piece, operation] = name.split('.');
    return (await fetch(`${app.url}/api/${piece}/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${member}` }, body: JSON.stringify({ input, id }) })).json();
  };
  expect(await post('household.createProject', pond, 'create')).toMatchObject({ ok: true });
  expect(await post('example.put', { id: 'pond-task', title: 'Made by Art', project: 'pond', agent: 'art' }, 'put')).toMatchObject({ ok: true });
  const sockets: { ws: WebSocket; next: () => Promise<unknown> }[] = []; // JSON protocol messages checked below.
  for (const id of ['pollock', 'pond-bot']) {
    const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live', { headers: { authorization: `Bearer ${id}` } });
    closes.push(() => ws.terminate());
    const messages: unknown[] = [], pending: ((v: unknown) => void)[] = [];
    ws.on('message', raw => { const v: unknown = JSON.parse(raw.toString()); const r = pending.shift(); if (r) r(v); else messages.push(v); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>(r => pending.push(r));
    await once(ws, 'open'); sockets.push({ ws, next });
    ws.send(JSON.stringify({ kind: 'subscribe', type: 'example.record' }));
    expect(await next()).toMatchObject({ kind: 'set', records: [{ id: 'pond-task' }] });
    ws.send(JSON.stringify({ kind: 'subscribe', type: 'household.project' }));
    expect(await next()).toMatchObject({ records: [{ id: 'pond', name: 'Pond' }] });
  }
  expect(await post('household.setProjectMembers', { slug: 'pond', members: [] }, 'deny', 'pollock')).toMatchObject({ code: 'denied' });
  expect(await post('household.setProjectMembers', { slug: 'pond', members: [] }, 'remove')).toMatchObject({ ok: true });
  expect(await sockets[0].next()).toMatchObject({ type: 'example.record', kind: 'set', records: [] });
  expect(await sockets[0].next()).toMatchObject({ type: 'household.project', kind: 'set', records: [] });
  // core.access refreshes the whole visible set; the project change also emits a delta.
  expect(await sockets[1].next()).toMatchObject({ type: 'example.record', kind: 'set', records: [{ id: 'pond-task' }] });
  expect(await sockets[1].next()).toMatchObject({ type: 'household.project', kind: 'set' });
  expect(await sockets[1].next()).toMatchObject({ type: 'household.project', kind: 'put' });
  expect(await post('household.setProjectAgents', { slug: 'pond', agents: [] }, 'agents')).toMatchObject({ ok: true });
  expect(await sockets[1].next()).toMatchObject({ type: 'example.record', kind: 'set', records: [] });
  expect(await sockets[1].next()).toMatchObject({ type: 'household.project', kind: 'set', records: [] });
  clock.advance(1);
  expect(store!.sharing().projects.pond).toEqual({ members: [], agents: [] });
  expect(readdirSync(h).filter(n => n.endsWith('.json'))).toEqual([]);
});
