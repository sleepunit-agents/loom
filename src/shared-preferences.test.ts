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
import { agents, members, memberPreferences, tokens } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const credentials = { sam: 'a'.repeat(64), lee: 'b'.repeat(64), art: 'c'.repeat(64) };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const query = '{ memberPreferences { member look ground sound pixel icons haptics oneWindow zoom motion contrast changedAt } }';
function fixture(changed?: () => void) {
  const client = new Database(':memory:'); cleanups.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values([{ id: 'sam', role: 'owner', joinedAt: at }, { id: 'lee', role: 'member', joinedAt: at }]).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(tokens).values(Object.entries(credentials).map(([id, raw]) => ({ fingerprint: hash(raw), label: id, kind: id === 'art' ? 'agent' as const : 'owner' as const, member: id === 'art' ? null : id, agent: id === 'art' ? id : null, createdAt: at }))).run();
  const errors: unknown[] = [];
  const root = sharedRoot({ db, clock, originAllowed: () => true, changed, reportError: error => errors.push(error) });
  cleanups.push(() => root.close());
  const call = (input: unknown, member: keyof typeof credentials = 'sam', id = 'save') => root.http.request('http://loom/api/household/setPreferences', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credentials[member] }, body: JSON.stringify({ input, id }),
  });
  const read = async (member: keyof typeof credentials, selection = query) => (await root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credentials[member] }, body: JSON.stringify({ query: selection }) })).json();
  return { db, client, clock, root, errors, call, read };
}
it('uses current member rows and partial updates without importing legacy tables or another member choices', async () => {
  const f = fixture();
  expect(await f.read('sam')).toEqual({ data: { memberPreferences: [] } });
  expect((await f.call({ look: 'daylight' })).status).toBe(200);
  expect((await f.call({ look: 'lowlight', sound: false }, 'lee')).status).toBe(200);
  const before = f.db.select().from(memberPreferences).where(eq(memberPreferences.member, 'sam')).get()!;
  expect(before).toEqual({ member: 'sam', look: 'daylight', ground: 'depth', sound: false, pixel: true, icons: false, haptics: true, oneWindow: false, zoom: false, motion: 'follow', contrast: 'follow', changedAt: new Date(f.clock.now()).toISOString() });
  f.clock.advance(1000);
  const answer = await (await f.call({ ground: 'wash', motion: 'on' }, 'sam', 'ground')).json();
  expect(answer).toEqual({ ok: true, value: { changedAt: new Date(f.clock.now()).toISOString() } });
  expect(await f.read('sam')).toEqual({ data: { memberPreferences: [{ ...before, ground: 'wash', motion: 'on', changedAt: new Date(f.clock.now()).toISOString() }] } });
  expect(await f.read('lee', '{ memberPreferences { member look sound } }')).toEqual({ data: { memberPreferences: [{ member: 'lee', look: 'lowlight', sound: false }] } });
  // Even an owner must select their own Appearance, never a first household row.
  expect(await f.read('sam', '{ memberPreferences(where:{member:{eq:"lee"}}) { member look } }')).toEqual({ data: { memberPreferences: [] } });
  expect(await f.read('art')).toEqual({ data: { memberPreferences: [] } });
  expect(f.client.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'core_*'").all()).toEqual([]);
});
it('rejects member/time injection, invalid choices, empty patches and agent writes without effects or receipts', async () => {
  const f = fixture();
  for (const input of [{ member: 'lee', look: 'daylight' }, { changedAt: '2100-01-01T00:00:00.000Z', look: 'daylight' }, { at: 1, look: 'daylight' }, { look: '000h' }, { sound: 1 }, {}]) expect((await f.call(input)).status).toBe(400);
  expect((await f.call({ look: 'daylight' }, 'art')).status).toBe(403);
  expect(f.db.select().from(memberPreferences).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});
it('replays once, detects changed input and rechecks current credential before replay', async () => {
  let notices = 0;
  const f = fixture(() => { notices++; throw new Error('notify failed'); });
  const first = await (await f.call({ look: 'daylight' })).json();
  f.clock.advance(1000);
  expect(await (await f.call({ look: 'daylight' })).json()).toEqual(first);
  expect(notices).toBe(1); expect(f.errors).toHaveLength(1);
  expect((await f.call({ look: 'lowlight' })).status).toBe(409);
  f.root.writes.run(() => f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(tokens.fingerprint, hash(credentials.sam))).run());
  expect((await f.call({ look: 'daylight' })).status).toBe(401);
  expect(f.db.select().from(memberPreferences).get()?.look).toBe('daylight');
});
it('publishes only the current member preference through the same real socket after commit', async () => {
  const f = fixture();
  const server = createServer(getRequestListener(request => f.root.http.fetch(request)));
  const detach = f.root.attach(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  cleanups.push(async () => { detach(); await f.root.close(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { authorization: 'Bearer ' + credentials.sam } });
  cleanups.push(() => ws.terminate()); await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'prefs', payload: { query: 'subscription { observe(query:"{ memberPreferences { member look } }") { patches { path value removed } } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({ memberPreferences: [] });
  next = once(ws, 'message'); await f.call({ look: 'daylight' });
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['memberPreferences', 0], value: { member: 'sam', look: 'daylight' }, removed: false }]);
  expect(await f.read('sam', '{ memberPreferences { member look } }')).toEqual({ data: { memberPreferences: [{ member: 'sam', look: 'daylight' }] } });
  const closed = once(ws, 'close'); f.root.writes.run(() => f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(tokens.fingerprint, hash(credentials.sam))).run());
  expect((await closed)[0]).toBe(4403);
});

it('checks current member policy before replay even for a retained trusted viewer', async () => {
  const f = fixture();
  expect((await f.call({ look: 'daylight' })).status).toBe(200);
  f.db.transaction(() => {
    f.db.delete(memberPreferences).where(eq(memberPreferences.member, 'sam')).run();
    f.db.delete(tokens).where(eq(tokens.member, 'sam')).run();
    f.db.delete(members).where(eq(members.id, 'sam')).run();
  });
  expect(f.root.operations.call('http', { kind: 'member', id: 'sam' }, 'household.setPreferences', { look: 'daylight' }, 'save')).toEqual({ ok: false, code: 'denied', message: 'Permission denied' });
  expect(f.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 1 });
});
