import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, memberAgents, projects, projectMembers, projectAgents, tokens, tasks, taskComments, taskLinks } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const raw = { owner: 'a'.repeat(64), sam: 'b'.repeat(64), lee: 'c'.repeat(64), art: 'd'.repeat(64) };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values(['owner','sam','lee'].map(id => ({ id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: at }))).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'sam', agent: 'art' }).run();
  db.insert(projects).values(['pond', 'other'].map(id => ({ id, name: id }))).run();
  db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run();
  db.insert(projectAgents).values({ project: 'pond', agent: 'art' }).run();
  db.insert(tokens).values(Object.entries(raw).map(([id, value]) => ({ fingerprint: hash(value), label: id, kind: id === 'art' ? 'agent' as const : 'owner' as const, member: id === 'art' ? null : id, agent: id === 'art' ? id : null, createdAt: at }))).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {} }); cleanup.push(() => root.close());
  const input = { title: 'Pump', goal: 'Works', why: 'Pond', owner: { kind: 'member' as const, id: 'sam' } };
  const call = (command: unknown, who: keyof typeof raw = 'sam', id = 'command') => root.http.request('http://loom/api/tasks/command', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+raw[who] }, body: JSON.stringify({ input: command, id }),
  });
  return { client, db, clock, root, input, call };
}
it('mounts the typed command, derives actors from current credentials and replays exactly one effect', async () => {
  const f = fixture(), command = { action: 'create', input: f.input };
  const first = await (await f.call(command)).json();
  expect(first).toEqual({ ok: true, value: { id: 't-1' } });
  expect(await (await f.call(command)).json()).toEqual(first);
  expect(f.db.select().from(tasks).all()).toHaveLength(1);
  expect(f.db.select().from(tasks).get()).toMatchObject({ createdByKind: 'member', createdBy: 'sam' });
  expect((await f.call({ ...command, actor: { kind: 'member', id: 'owner' } }, 'sam', 'forged')).status).toBe(400);
  expect((await f.call({ ...command, input: { ...f.input, title: 'Changed' } })).status).toBe(409);
  const agent = f.root.services.tasks.create({ ...f.input, owner: { kind: 'agent', id: 'art' } }, { kind: 'member', id: 'owner' });
  expect((await f.call({ action: 'comment', id: agent.id, text: 'Ready' }, 'art', 'comment')).status).toBe(200);
  expect(f.db.select().from(taskComments).get()).toMatchObject({ actorKind: 'agent', actor: 'art', text: 'Ready' });
});
it('validates both relation ends, proposed sharing and private conversation source before effect or receipt', async () => {
  const f = fixture();
  const own = f.root.services.tasks.create(f.input, { kind: 'member', id: 'owner' });
  const hidden = f.root.services.tasks.create({ ...f.input, owner: { kind: 'member', id: 'lee' } }, { kind: 'member', id: 'owner' });
  const cv = f.root.services.conversations.open({ agent: 'art', member: 'lee', project: 'pond', venue: 'loom', place: 'private', label: 'Private' });
  for (const command of [
    { action: 'create', input: { ...f.input, parent: hidden.id } },
    { action: 'create', input: { ...f.input, source: { kind: 'conversation', id: cv.id } } },
    { action: 'link', id: own.id, dependsOn: hidden.id, type: 'blocks' },
    { action: 'unlink', id: hidden.id, dependsOn: own.id, type: 'blocks' },
    { action: 'edit', id: own.id, input: { project: 'other' } },
    { action: 'ask', id: own.id, input: { to: { kind: 'member', id: 'lee' }, ask: 'Spend?', ifYes: 'Buy', ifNo: 'Wait' } },
  ]) expect((await f.call(command)).status).toBe(403);
  expect(f.db.select().from(taskLinks).all()).toEqual([]);
  expect(f.db.select().from(tasks).all()).toHaveLength(2);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  expect((await f.call({ action: 'create', input: { ...f.input, source: { kind: 'conversation', id: cv.id } } }, 'owner')).status).toBe(200);
});
it('checks current sharing before cached receipts, then denies revoked credentials', async () => {
  const f = fixture(), command = { action: 'create', input: { ...f.input, project: 'pond', owner: { kind: 'member', id: 'lee' } } };
  expect((await f.call(command)).status).toBe(200);
  f.root.writes.run(() => f.db.delete(projectMembers).run());
  expect((await f.call(command)).status).toBe(403);
  f.root.writes.run(() => f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(tokens.fingerprint, hash(raw.sam))).run());
  expect((await f.call(command)).status).toBe(401);
  expect(f.db.select().from(tasks).all()).toHaveLength(1);
});
it('rolls task effects back when the shared receipt fails and permits the same-id retry', async () => {
  const f = fixture(), command = { action: 'create', input: f.input };
  f.client.exec("CREATE TRIGGER receipt_failure BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect((await f.call(command)).status).toBe(503);
  expect(f.db.select().from(tasks).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  f.client.exec('DROP TRIGGER receipt_failure');
  expect(await (await f.call(command)).json()).toEqual({ ok: true, value: { id: 't-1' } });
});
it('publishes an actual task command to the same socket query and withdraws project access', async () => {
  const f = fixture();
  const server = createServer(getRequestListener(request => f.root.http.fetch(request))), detach = f.root.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { detach(); await f.root.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const ws = new WebSocket('ws://127.0.0.1:'+address.port+'/graphql', 'graphql-transport-ws', { headers: { authorization: 'Bearer '+raw.sam } });
  cleanup.push(() => ws.terminate()); await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'tasks', payload: { query: 'subscription { observe(query:"{ tasks { id title } }") { patches { path value removed } } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({ tasks: [] });
  next = once(ws, 'message');
  expect((await f.call({ action: 'create', input: { ...f.input, project: 'pond', owner: { kind: 'member', id: 'lee' } } })).status).toBe(200);
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['tasks', 0], value: { id: 't-1', title: 'Pump' }, removed: false }]);
  next = once(ws, 'message'); f.root.writes.run(() => f.db.delete(projectMembers).run());
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['tasks',0], value: null, removed: true }]);
});
