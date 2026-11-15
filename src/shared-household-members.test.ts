import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, memberAgents, tokens } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const credentials = { sam: 'a'.repeat(64), lee: 'b'.repeat(64), art: 'c'.repeat(64) };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const visual = { about: 'Fixture agent', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble' as const, faceEyes: 'dot' as const };
function fixture() {
  const client = new Database(':memory:'); clean.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values([{ id: 'sam', role: 'owner', joinedAt: at }, { id: 'lee', role: 'member', joinedAt: at }]).run();
  db.insert(agents).values([{ id: 'art', ...visual, spriteVersion: 'old-png' }, { id: 'mark', ...visual }]).run();
  for (const member of ['sam', 'lee'] as const) db.insert(tokens).values({ fingerprint: hash(credentials[member]), label: member, kind: 'owner', member, createdAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(credentials.art), label: 'Art', kind: 'agent', agent: 'art', createdAt: at }).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {} }); clean.push(() => root.close());
  const call = (operation: string, input: unknown, actor: keyof typeof credentials = 'sam', id = 'request') => root.http.request('http://loom/api/household/'+operation, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ input, id }) });
  return { client, db, clock, root, call };
}
it('adds scoped members without requiring ownership and preserves join time when replacing agent lists', async () => {
  const f = fixture();
  expect((await f.call('setMember', { id: 'pat', role: 'member', agents: [] })).status).toBe(200);
  const joinedAt = f.root.services.household.members().find(row => row.id === 'pat')!.joinedAt;
  f.clock.advance(1000);
  expect((await f.call('setMember', { id: 'pat', role: 'member', agents: ['mark', 'art', 'art'] }, 'sam', 'owners')).status).toBe(200);
  expect(f.root.services.household.members().find(row => row.id === 'pat')).toMatchObject({ role: 'member', fullOwner: false, agents: ['art', 'mark'], joinedAt });
});
it('requires a current household owner and rejects caller identity injection', async () => {
  const f = fixture(), input = { id: 'pat', role: 'owner', fullOwner: true, agents: [] };
  for (const actor of ['lee', 'art'] as const) expect((await f.call('setMember', input, actor)).status).toBe(403);
  expect((await f.call('setMember', { ...input, actor: 'sam' })).status).toBe(400);
  expect(f.db.select().from(members).all()).toHaveLength(2);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});
it('prevents removal of the last owner role and rechecks demotion before receipt replay', async () => {
  const f = fixture();
  expect((await f.call('setMember', { id: 'sam', role: 'member', agents: [] })).status).toBe(409);
  expect((await f.call('setMember', { id: 'lee', role: 'owner', fullOwner: true, agents: [] }, 'sam', 'lee-owner')).status).toBe(200);
  f.root.writes.run(() => f.client.exec("UPDATE members SET role='member' WHERE id='sam'"));
  expect((await f.call('setMember', { id: 'lee', role: 'owner', fullOwner: true, agents: [] }, 'sam', 'lee-owner')).status).toBe(403);
});
it('rejects unknown agents and invalid full-owner/member combinations without partial effects', async () => {
  const f = fixture();
  expect((await f.call('setMember', { id: 'pat', role: 'member', agents: ['missing'] })).status).toBe(400);
  expect((await f.call('setMember', { id: 'pat', role: 'member', fullOwner: true, agents: [] })).status).toBe(400);
  expect(f.db.select().from(members).all()).toHaveLength(2);
  expect(f.db.select().from(memberAgents).all()).toEqual([]);
});
it('rolls back both role and agent grants if receipt persistence fails', async () => {
  const f = fixture();
  f.client.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect((await f.call('setMember', { id: 'lee', role: 'owner', agents: ['art'] })).status).toBe(503);
  expect(f.root.services.household.members().find(row => row.id === 'lee')).toMatchObject({ role: 'member', agents: [] });
});
it('clears a stale PNG pointer only when agent appearance changes and preserves roster position', async () => {
  const f = fixture();
  f.client.exec("UPDATE agents SET position=7 WHERE id='art'");
  expect((await f.call('setAgent', { id: 'art', ...visual, about: 'New description' })).status).toBe(200);
  expect(f.db.select().from(agents).all().find(row => row.id === 'art')).toMatchObject({ spriteVersion: 'old-png', position: 7 });
  expect((await f.call('setAgent', { id: 'art', ...visual, faceShape: 'drop' }, 'sam', 'appearance')).status).toBe(200);
  expect(f.db.select().from(agents).all().find(row => row.id === 'art')).toMatchObject({ spriteVersion: null, position: 7, faceShape: 'drop' });
});
it('publishes owner administration metadata and withdraws ordinary member agent visibility with current ownership', async () => {
  const f = fixture(), query = '{ members { id role fullOwner memberAgentsByMember { agent } } agents { id } }';
  const read = async (actor: keyof typeof credentials) => (await f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ query }) })).json();
  expect((await read('sam')).data.members).toHaveLength(2);
  expect(await read('lee')).toEqual({ data: { members: [{ id: 'lee', role: 'member', fullOwner: false, memberAgentsByMember: [] }], agents: [] } });
  expect((await f.call('setMember', { id: 'lee', role: 'member', agents: ['art'] })).status).toBe(200);
  expect((await read('lee')).data.agents).toEqual([{ id: 'art' }]);
  expect((await f.call('setMember', { id: 'lee', role: 'member', agents: [] }, 'sam', 'withdraw')).status).toBe(200);
  expect((await read('lee')).data.agents).toEqual([]);
  expect(await read('art')).toEqual({ data: { members: [], agents: [{ id: 'art' }] } });
});

it('withdraws agent ownership through a retained real socket schema after a member edit', async () => {
  const f = fixture();
  await f.call('setMember', { id: 'lee', role: 'member', agents: ['art'] });
  const server = createServer(), detach = f.root.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  clean.push(async () => { detach(); await f.root.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No port');
  const ws = new WebSocket('ws://127.0.0.1:'+address.port+'/graphql', 'graphql-transport-ws', { headers: { authorization: 'Bearer '+credentials.lee } });
  clean.push(() => ws.terminate()); await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'subscribe', id: 'agents', payload: { query: 'subscription { observe(query:"{ agents { id about } }") { revision patches { path value removed } } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({ agents: [{ id: 'art', about: 'Fixture agent' }] });
  next = once(ws, 'message');
  expect((await f.call('setMember', { id: 'lee', role: 'member', agents: [] }, 'sam', 'withdraw')).status).toBe(200);
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['agents', 0], removed: true, value: null }]);
});
it('denies ordinary member and agent appearance writes and rechecks owner demotion before replay', async () => {
  const f = fixture(), input = { id: 'art', ...visual, about: 'Changed by owner' };
  for (const actor of ['lee', 'art'] as const) expect((await f.call('setAgent', input, actor)).status).toBe(403);
  expect((await f.call('setAgent', input)).status).toBe(200);
  f.root.writes.run(() => f.client.exec("UPDATE members SET role='member' WHERE id='sam'; INSERT INTO member_agents(member,agent) VALUES('sam','art')"));
  expect((await f.call('setAgent', input)).status).toBe(403);
  expect((await f.call('setAgent', { ...input, about: 'Unauthorized' }, 'sam', 'fresh')).status).toBe(403);
  expect(f.db.select().from(agents).all().find(row => row.id === 'art')?.about).toBe('Changed by owner');
});
it('exposes populated agent ownership only to current owners in direct and connected selections', async () => {
  const f = fixture();
  await f.call('setMember', { id: 'lee', role: 'member', agents: ['art'] });
  const query = '{ members(where:{id:{eq:"lee"}}) { id memberAgentsByMember { agent } } memberAgents { member agent } }';
  const read = async (actor: keyof typeof credentials) => (await f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ query }) })).json();
  expect(await read('sam')).toEqual({ data: { members: [{ id: 'lee', memberAgentsByMember: [{ agent: 'art' }] }], memberAgents: [{ member: 'lee', agent: 'art' }] } });
  expect(await read('lee')).toEqual({ data: { members: [{ id: 'lee', memberAgentsByMember: [] }], memberAgents: [] } });
  expect(await read('art')).toEqual({ data: { members: [], memberAgents: [] } });
  f.root.writes.run(() => f.client.exec("UPDATE members SET role='member' WHERE id='sam'"));
  expect(await read('sam')).toEqual({ data: { members: [], memberAgents: [] } });
});
it('persists full ownership and permitted demotion without changing member position or join time', async () => {
  const f = fixture(), joinedAt = f.root.services.household.members().find(row => row.id === 'sam')!.joinedAt;
  f.client.exec("UPDATE members SET position=73 WHERE id='sam'");
  expect((await f.call('setMember', { id: 'lee', role: 'owner', fullOwner: true, agents: ['art'] })).status).toBe(200);
  expect(f.root.services.household.members().find(row => row.id === 'lee')).toMatchObject({ role: 'owner', fullOwner: true, agents: ['art'] });
  f.clock.advance(1000);
  expect((await f.call('setMember', { id: 'sam', role: 'member', agents: ['mark'] }, 'lee', 'demote')).status).toBe(200);
  expect(f.root.services.household.members().find(row => row.id === 'sam')).toMatchObject({ role: 'member', fullOwner: false, position: 73, joinedAt, agents: ['mark'] });
});
it('creates agents and updates descriptions colors and eyes without overwriting unrelated metadata', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  const created = { id: 'jun', about: 'New assistant', markBg: '#123456', markFg: '#abcdef', faceShape: 'drop', faceEyes: 'oval' };
  expect((await f.call('setAgent', created)).status).toBe(200);
  expect(f.db.select().from(agents).all().find(row => row.id === 'jun')).toMatchObject({ ...created, spriteVersion: null });
  f.client.prepare("UPDATE agents SET about_asked_at=?,position=7 WHERE id='art'").run(at);
  expect((await f.call('setAgent', { id: 'art', ...visual, about: 'New biography' }, 'sam', 'bio')).status).toBe(200);
  expect(f.db.select().from(agents).all().find(row => row.id === 'art')).toMatchObject({ about: 'New biography', aboutAskedAt: at, position: 7, spriteVersion: 'old-png' });
  expect((await f.call('setAgent', { id: 'art', ...visual, markBg: '#778899', markFg: '#112233', faceEyes: 'oval' }, 'sam', 'visual')).status).toBe(200);
  expect(f.db.select().from(agents).all().find(row => row.id === 'art')).toMatchObject({ markBg: '#778899', markFg: '#112233', faceEyes: 'oval', spriteVersion: null, aboutAskedAt: at, position: 7 });
});
it('withdraws populated owner metadata through an already subscribed socket after permitted demotion', async () => {
  const f = fixture();
  await f.call('setMember', { id: 'lee', role: 'owner', fullOwner: true, agents: ['art'] });
  const server = createServer(), detach = f.root.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  clean.push(async () => { detach(); await f.root.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No port');
  const ws = new WebSocket('ws://127.0.0.1:'+address.port+'/graphql', 'graphql-transport-ws', { headers: { authorization: 'Bearer '+credentials.sam } });
  clean.push(() => ws.terminate()); await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'subscribe', id: 'members', payload: { query: 'subscription { observe(query:"{ members(where:{id:{eq:\\"lee\\"}}) { id } memberAgents { member agent } }") { patches { path value removed } } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({ members: [{ id: 'lee' }], memberAgents: [{ member: 'lee', agent: 'art' }] });
  next = once(ws, 'message');
  expect((await f.call('setMember', { id: 'sam', role: 'member', agents: [] }, 'lee', 'demote')).status).toBe(200);
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([
    { path: ['members', 0], removed: true, value: null }, { path: ['memberAgents', 0], removed: true, value: null },
  ]);
});
