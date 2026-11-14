import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import { DataLive } from './live.js';
import { dataSocket } from './socket.js';
import { GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString } from 'graphql/index.js';
import type { Authentication } from '../live/index.js';
import { FakeClock } from '../clock.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
async function setup(authenticate?: (request: IncomingMessage) => Authentication | undefined) {
  const client = new Database(':memory:'); clean.push(() => { client.close(); });
  createDataSchema(client);
  client.exec(`INSERT INTO members (id,role,joined_at) VALUES ('sam','member','2026-11-14T00:00:00Z');
    INSERT INTO tasks (id,title,owner_kind,owner,created_by_kind,created_by,created_at,changed_at)
    VALUES ('t-1','Pump','member','sam','member','sam','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z');`);
  const live = new DataLive(); clean.push(() => live.close());
  const clock = new FakeClock(); let valid = true;
  let schema = (viewer: import('../../policy.js').Viewer) => dataQueries(client, { tables: ['tasks'], visibility: taskVisibility(viewer) });
  const socket = dataSocket({ live, clock,
    authenticate: authenticate ?? (req => req.headers.authorization === 'Bearer test' ? { viewer: { kind: 'member', id: 'sam' }, valid: () => valid, expiresAt: clock.now() + 1000 } : undefined),
    schema: viewer => schema(viewer),
    originAllowed: req => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`,
  });
  const http = createServer(); socket.attach(http);
  await new Promise<void>(resolve => http.listen(0,'127.0.0.1', resolve));
  clean.push(() => new Promise<void>(resolve => http.close(() => resolve())));
  clean.push(() => socket.close());
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const url = `ws://127.0.0.1:${address.port}/graphql`;
  const open = async (headers = { authorization: 'Bearer test' }, params?: Record<string, unknown>) => {
    const ws = new WebSocket(url, 'graphql-transport-ws', { headers }); clean.push(() => { ws.terminate(); });
    await once(ws, 'open');
    const ack = once(ws,'message'); ws.send(JSON.stringify({ type: 'connection_init', payload: params })); await ack;
    return ws;
  };
  return { client, live, clock, socket, url, open, setSchema: (value: typeof schema) => { schema = value; }, invalidate: () => { valid = false; }, revoke: () => { valid = false; socket.refreshAccess(); live.changed(); } };
}
const selection = { type: 'subscribe', id: 'tasks', payload: {
  query: 'subscription($query: String!) { observe(query: $query) { revision patches { path removed value } } }', variables: { query: '{ tasks { id title } }' },
} };
async function read(ws: WebSocket, action: () => void) { const message = once(ws, 'message'); action(); return JSON.parse(String((await message)[0])); }

it('multiplexes generated selections and delivers only changed paths over graphql-transport-ws', async () => {
  const f = await setup(), ws = await f.open();
  const initial = await read(ws, () => ws.send(JSON.stringify(selection)));
  expect(initial).toEqual({ id: 'tasks', type: 'next', payload: { data: { observe: { revision: 1, patches: [{ path: [], removed: false, value: { tasks: [{ id: 't-1', title: 'Pump' }] } }] } } } });
  const second = await read(ws, () => ws.send(JSON.stringify({ ...selection, id: 'another' })));
  expect(second.id).toBe('another');
  ws.send(JSON.stringify({ type: 'complete', id: 'another' }));
  const changed = await read(ws, () => { f.client.exec("UPDATE tasks SET title='Fits'"); f.live.changed(); });
  expect(changed.payload.data.observe).toEqual({ revision: 2, patches: [{ path: ['tasks', 0, 'title'], removed: false, value: 'Fits' }] });
});

it('closes an idle connection at token expiry using the owned clock', async () => {
  const f = await setup(), ws = await f.open();
  const closed = once(ws, 'close'); f.clock.advance(1000);
  expect((await closed)[0]).toBe(4403);
});

it('closes idle revoked connections without waiting for a new operation', async () => {
  const f = await setup(), ws = await f.open();
  const closed = once(ws, 'close'); f.revoke();
  expect((await closed)[0]).toBe(4403);
});

it('bounds uninitialised connections with the owned clock', async () => {
  const f = await setup();
  // This test gives its token a longer life so only the init timer can win.
  const separate = dataSocket({ live: f.live, clock: f.clock, authenticate: () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => true }), schema: () => dataQueries(f.client, { tables: ['tasks'], visibility: taskVisibility({kind:'member',id:'sam'}) }), originAllowed: () => true });
  const http = createServer(); separate.attach(http); await new Promise<void>(ok => http.listen(0,'127.0.0.1',ok));
  clean.push(() => new Promise<void>(ok => http.close(() => ok()))); clean.push(() => separate.close());
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws'); clean.push(() => { ws.terminate(); }); await once(ws,'open');
  const closed = once(ws, 'close'); f.clock.advance(10000); expect((await closed)[0]).toBe(4408);
});

it('refuses missing authentication and cross-origin browser upgrades before opening a socket', async () => {
  const f = await setup();
  for (const headers of [{}, { authorization: 'Bearer test', origin: 'https://evil.invalid' }]) {
    const ws = new WebSocket(f.url, 'graphql-transport-ws', { headers }); ws.on('error', () => {});
    const status = await new Promise<number>(ok => ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); ok(response.statusCode!); }));
    expect(status).toBe(401);
  }
});


it('refuses invalid, runner, service and cookie-without-Origin callers at upgrade', async () => {
  for (const auth of [
    { viewer: { kind: 'member', id: 'sam' }, valid: () => false },
    { viewer: { kind: 'runner', id: 'box' }, valid: () => true },
    { viewer: { kind: 'service', id: 'installed' }, valid: () => true },
    { viewer: { kind: 'member', id: 'sam' }, valid: () => true, window: true },
  ] as Authentication[]) {
    const f = await setup(() => auth);
    const ws = new WebSocket(f.url, 'graphql-transport-ws'); ws.on('error', () => {});
    const status = await new Promise<number>(ok => ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); ok(response.statusCode!); }));
    expect(status).toBe(401);
  }
});

it('ignores connectionParams identity and reads only as the upgrade principal', async () => {
  const f = await setup();
  f.client.exec("INSERT INTO members (id,role,joined_at) VALUES ('owner','owner','2026-11-14T00:00:00Z'); INSERT INTO tasks (id,title,owner_kind,owner,created_by_kind,created_by,created_at,changed_at) VALUES ('private','Secret','member','owner','member','owner','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')");
  const ws = await f.open(undefined, { viewer: { kind: 'member', id: 'owner' }, authorization: 'Bearer owner' });
  const message = await read(ws, () => ws.send(JSON.stringify(selection)));
  expect(message.payload.data.observe.patches[0].value.tasks).toEqual([{ id: 't-1', title: 'Pump' }]);
});

it.each(['revoke','expire'])('blocks buffered result release when authority ends during serialisation: %s', async how => {
  const f = await setup(), ws = await f.open();
  const secret = new GraphQLScalarType({ name: 'BufferedSecret', serialize: () => ({ toJSON() { if (how === 'revoke') f.invalidate(); else f.clock.advance(1000); return 'must not leave'; } }) });
  f.setSchema(() => new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { secret: { type: secret, resolve: () => 'secret' } } }) }));
  const messages: string[] = []; ws.on('message', data => messages.push(String(data)));
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ ...selection, payload: { ...selection.payload, variables: { query: '{ secret }' } } }));
  expect((await closed)[0]).toBe(4403);
  expect(messages).toEqual([]);
});

it('serves ordinary generated GraphQL reads on the same authenticated websocket', async () => {
  const f = await setup(), ws = await f.open();
  f.client.exec("INSERT INTO members (id,role,joined_at) VALUES ('other','member','2026-11-14T00:00:00Z'); INSERT INTO tasks (id,title,owner_kind,owner,created_by_kind,created_by,created_at,changed_at) VALUES ('private','Secret','member','other','member','other','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')");
  const result = await read(ws, () => ws.send(JSON.stringify({ type: 'subscribe', id: 'read', payload: { query: '{ tasks { id title } }' } })));
  expect(result).toEqual({ type: 'next', id: 'read', payload: { data: { tasks: [{ id: 't-1', title: 'Pump' }] } } });
});

it('uses the upgrade viewer for context-based reads and observe reruns despite client identity claims', async () => {
  const f = await setup();
  let title = 'First';
  f.setSchema(() => new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    title: { type: GraphQLString, resolve: (_source, _args, context) => `${context.viewer.id}:${title}` },
  } }) }));
  const ws = await f.open(undefined, { viewer: { kind: 'member', id: 'owner' } });
  const direct = await read(ws, () => ws.send(JSON.stringify({ type: 'subscribe', id: 'direct', payload: {
    query: '{ title }', variables: { viewer: { kind: 'member', id: 'owner' } },
  } })));
  expect(direct.payload).toEqual({ data: { title: 'sam:First' } });
  const observed = { ...selection, payload: { ...selection.payload, variables: { query: '{ title }', viewer: { kind: 'member', id: 'owner' } } } };
  const initial = await read(ws, () => ws.send(JSON.stringify(observed)));
  expect(initial.payload.data.observe.patches[0].value).toEqual({ title: 'sam:First' });
  const changed = await read(ws, () => { title = 'Second'; f.live.changed(); });
  expect(changed.payload.data.observe).toEqual({ revision: 2, patches: [{ path: ['title'], removed: false, value: 'sam:Second' }] });
});
