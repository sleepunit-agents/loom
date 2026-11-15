import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, sessions, tokens, tasks } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { serveShared } from './shared-serve.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'a'.repeat(64), cookie = 'b'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(approvedOperations?: Parameters<typeof sharedRoot>[0]['approvedOperations']) {
  const client = new Database(':memory:'); cleanup.push(() => client.close());
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(token), label: 'Sam', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(sessions).values({ id: hash(cookie), token: hash(token), device: 'Browser', via: 'token', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  const errors: unknown[] = [];
  const root = sharedRoot({ db, clock, originAllowed: () => true, approvedOperations, reportError: error => errors.push(error) });
  cleanup.push(() => root.close());
  // A trusted producer installs a typed operation. The root never accepts a
  // registry or caller identity from an HTTP request.
  root.operations.register({ name: 'tasks.make', write: true, recheckPolicy: true,
    input: z.object({ title: z.string().min(1) }).strict(), output: z.object({ id: z.string() }),
    may: viewer => viewer.kind === 'member' && db.select().from(members).where(eq(members.id, viewer.id)).get()?.role === 'owner',
    run(ctx, input) {
      if (ctx.viewer.kind !== 'member') throw new Error('Member required');
      const task = root.services.tasks.create({ title: input.title, goal: 'Pump works', why: 'Pond needs it', owner: { kind: 'member', id: ctx.viewer.id } }, ctx.viewer);
      ctx.changed('task', task.id);
      return { id: task.id };
    },
  });
  const command = (input: unknown = { title: 'Pump' }, headers: Record<string, string> = { authorization: 'Bearer ' + token }, id = 'make') => root.http.request('http://loom/api/tasks/make', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ input, id }),
  });
  return { client, db, clock, root, errors, command };
}

it('uses actual shared services and receipts for cookie/bearer commands and generated reads', async () => {
  const f = fixture();
  const first = await f.command();
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, value: { id: 't-1' } });
  expect(await (await f.command({ title: 'Pump' }, { cookie: 'loom_ui=' + cookie })).json()).toEqual({ ok: true, value: { id: 't-1' } });
  expect(f.db.select().from(tasks).all()).toHaveLength(1);
  const read = await f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui=' + cookie }, body: JSON.stringify({ query: '{ tasks { id title } }' }) });
  expect(await read.json()).toEqual({ data: { tasks: [{ id: 't-1', title: 'Pump' }] } });
  expect((await f.command({ title: 'Changed' })).status).toBe(409);
  expect(f.client.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'core_*'").all()).toEqual([]);
  f.root.writes.run(() => f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'sam')).run());
  expect((await f.command()).status).toBe(403); // current policy before receipt replay
  f.root.writes.run(() => f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).run());
  expect((await f.command()).status).toBe(401);
});

it('publishes a command commit through the same real GraphQL socket and closes before SQLite', async () => {
  const f = fixture();
  const http = createServer(getRequestListener(request => f.root.http.fetch(request)));
  const detach = f.root.attach(http);
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
  cleanup.push(async () => { detach(); await f.root.close(); await new Promise<void>(ok => http.close(() => ok())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { authorization: 'Bearer ' + token } });
  cleanup.push(() => ws.terminate());
  await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'tasks', payload: { query: 'subscription { observe(query:"{ tasks { id title } }") { revision patches { path value removed } } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({ tasks: [] });
  next = once(ws, 'message');
  expect((await f.command()).status).toBe(200);
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['tasks', 0], removed: false, value: { id: 't-1', title: 'Pump' } }]);
  const closed = once(ws, 'close');
  const close = f.root.close(); expect(f.root.close()).toBe(close);
  expect((await f.command()).status).toBe(503);
  await close; await closed;
  expect(() => f.root.attach(createServer())).toThrow('Loom is closing');
  expect(f.client.open).toBe(true);
  expect(f.errors).toEqual([]);
});

it('rejects cross-origin, malformed and identity-smuggling commands without effects', async () => {
  const f = fixture();
  expect((await f.command({ title: 'Pump' }, { authorization: 'Bearer ' + token, origin: 'https://elsewhere.test' })).status).toBe(403);
  expect((await f.command({ title: 'Pump', actor: { kind: 'member', id: 'owner' } })).status).toBe(400);
  expect((await f.command({}, {})).status).toBe(401);
  expect((await f.command({ title: 'Pump' }, { authorization: 'Bearer ' + hash(token) })).status).toBe(401);
  expect(f.db.select().from(tasks).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});

it('withholds a committed result when its credential ends before the final HTTP release', async () => {
  const f = fixture();
  f.root.operations.register({ name: 'tasks.revoke', write: true, input: z.object({}).strict(), output: z.string(), may: () => true,
    run() { f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).run(); return 'private acknowledgement'; },
  });
  const response = await f.root.http.request('http://loom/api/tasks/revoke', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ input: {}, id: 'revoke' }) });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('private acknowledgement');
  expect(f.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 1 });
  expect(f.db.select().from(tokens).get()?.revokedAt).not.toBeNull();
});

it('refuses a credential revoked while request JSON is still arriving without effects or receipt', async () => {
  const f = fixture();
  let writer!: ReadableStreamDefaultController<Uint8Array>, reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
  const bytes = new TextEncoder().encode(JSON.stringify({ input: { title: 'Pump' }, id: 'held' }));
  const request = new Request('http://loom/api/tasks/make', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(bytes.length), authorization: 'Bearer ' + token }, body, duplex: 'half' } as RequestInit);
  const json = request.json.bind(request); request.json = () => { reading(); return json(); };
  const response = f.root.http.fetch(request);
  await started;
  f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).run();
  writer.enqueue(bytes); writer.close();
  expect((await response).status).toBe(403);
  expect(f.db.select().from(tasks).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});

it('rechecks the same credential after async preparation before applying effects', async () => {
  const f = fixture();
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.root.operations.register({ name: 'tasks.prepared', write: true, input: z.object({}), output: z.string(), may: () => true,
    prepare() { began(); return held; }, run() { return f.root.services.tasks.create({ title: 'Prepared', goal: 'Work', why: 'Needed', owner: { kind: 'member', id: 'sam' } }, { kind: 'member', id: 'sam' }).id; },
  });
  const pending = f.root.http.request('http://loom/api/tasks/prepared', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ input: {}, id: 'prepared' }) });
  await started; f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).run(); release();
  expect((await pending).status).toBe(403);
  expect(f.db.select().from(tasks).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});

it('uses the injected clock and static approved handlers for actual conversation and approval services', () => {
  let ran = 0;
  const f = fixture(new Map([['setting.apply', () => { ran++; }]]));
  f.db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  f.clock.advance(1234);
  const at = new Date(f.clock.now()).toISOString();
  const cv = f.root.writes.run(() => f.root.services.conversations.open({ agent: 'art', venue: 'loom', place: 'test', label: 'Pump' })).value;
  expect(cv.startedAt).toBe(at);
  const approval = f.root.writes.run(() => f.root.services.approvals.request({ kind: 'setting', target: 'setting', operation: 'setting.apply', changeSummary: 'Before: off; after: on', what: 'Switch on', why: 'Needed', agent: 'art', askedFrom: 'house', actingFor: 'owner', ask: 'Switch on?', ifYes: 'On', ifNo: 'Off' })).value;
  expect(approval.askedAt).toBe(at);
  f.clock.advance(1000);
  const allowed = f.root.writes.run(() => f.root.services.approvals.allow(approval.id, 'sam')).value;
  expect(allowed.usedAt).toBe(new Date(f.clock.now()).toISOString()); expect(ran).toBe(1);
});

it('fences a socket upgrade synchronously when an earlier listener closes the root', async () => {
  const f = fixture(), http = createServer();
  let close: Promise<void> | undefined;
  http.on('upgrade', () => { close = f.root.close(); });
  const detach = f.root.attach(http);
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
  cleanup.push(async () => { detach(); await f.root.close(); await new Promise<void>(ok => http.close(() => ok())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { authorization: 'Bearer ' + token } });
  cleanup.push(() => ws.terminate());
  const error = once(ws, 'error');
  await error;
  await close;
  expect(ws.readyState).not.toBe(WebSocket.OPEN);
});

it('serves the fresh root through the production listener and shuts down a withheld HTTP connection', async () => {
  const f = fixture();
  // The source-only listener consumes the factory in production code; the
  // connection is caller-owned and remains available after listener shutdown.
  const server = await serveShared({ db: f.db, clock: f.clock, originAllowed: () => true, reportError: error => f.errors.push(error) });
  cleanup.push(() => server.close());
  server.operations.register({ name: 'tasks.make', write: true, input: z.object({}), output: z.string(), may: () => true,
    run() { return server.services.tasks.create({ title: 'Served', goal: 'Work', why: 'Needed', owner: { kind: 'member', id: 'sam' } }, { kind: 'member', id: 'sam' }).id; },
  });
  const result = await fetch(server.url + '/api/tasks/make', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ input: {}, id: 'served' }) });
  expect(await result.json()).toEqual({ ok: true, value: 't-1' });
  const { createConnection } = await import('node:net');
  const url = new URL(server.url), held = createConnection({ host: url.hostname, port: Number(url.port) });
  cleanup.push(() => held.destroy()); await once(held, 'connect');
  held.write('GET /graphql HTTP/1.1\r\nHost: loom\r\n');
  const connectionErrors: string[] = [];
  held.on('error', error => connectionErrors.push((error as NodeJS.ErrnoException).code ?? error.message));
  const ended = new Promise<void>(resolve => held.once('close', () => resolve()));
  const close = server.close(); expect(server.close()).toBe(close);
  await close; await ended;
  expect(connectionErrors.every(code => code === 'ECONNRESET')).toBe(true);
  expect(f.client.open).toBe(true);
});

it('releases the fresh composition when its production listener cannot bind', async () => {
  const f = fixture(), held = createServer();
  await new Promise<void>(resolve => held.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => held.close(() => resolve())));
  const address = held.address(); if (!address || typeof address === 'string') throw new Error('No address');
  await expect(serveShared({ db: f.db, clock: f.clock, originAllowed: () => true, port: address.port, reportError: error => f.errors.push(error) })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(f.client.open).toBe(true);
  expect(f.errors).toEqual([]);
});
