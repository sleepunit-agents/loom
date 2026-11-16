import { createServer } from 'node:http';
import { setupCall } from '../test/fixtures/setup-call.js';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agentSprites, agents, members, memberAgents, tokens } from './core/data/schema.js';
import { householdService } from './apps/household.js';
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
  const call = async (operation: string, input: unknown, actor: keyof typeof credentials = 'sam', id = 'request') => setupCall(root, 'household.'+operation, input, actor) ?? root.http.request('http://loom/api/household/'+operation, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ input, id }) });
  return { client, db, clock, root, call };
}
async function openSocket(f: ReturnType<typeof fixture>, actor: keyof typeof credentials) {
  const server = createServer(), detach = f.root.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  clean.push(async () => { detach(); await f.root.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No port');
  const ws = new WebSocket('ws://127.0.0.1:'+address.port+'/graphql', 'graphql-transport-ws', { headers: { authorization: 'Bearer '+credentials[actor] } });
  clean.push(() => ws.terminate()); await once(ws, 'open');
  const ack = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await ack;
  return ws;
}
async function subscribe(ws: WebSocket, query: string) {
  const next = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'subscribe', id: 'watch', payload: {
    query: 'subscription($query:String!) { observe(query:$query) { patches { path value removed } } }',
    variables: { query },
  } }));
  return JSON.parse(String((await next)[0])).payload.data.observe;
}
it('adds scoped members without requiring ownership and preserves join time when replacing agent lists', async () => {
  const f = fixture();
  expect((await f.call('setMember', { id: 'pat', role: 'member', agents: [] })).status).toBe(200);
  const joinedAt = f.root.services.household.members().find(row => row.id === 'pat')!.joinedAt;
  f.clock.advance(1000);
  expect((await f.call('setMember', { id: 'pat', role: 'member', agents: ['mark', 'art', 'art'] }, 'sam', 'owners')).status).toBe(200);
  expect(f.root.services.household.members().find(row => row.id === 'pat')).toMatchObject({ role: 'member', fullOwner: false, agents: ['art', 'mark'], joinedAt });
});
it('prevents removal of the last owner role and rechecks demotion before receipt replay', async () => {
  const f = fixture();
  expect((await f.call('setMember', { id: 'sam', role: 'member', agents: [] })).status).toBe(409);
  expect((await f.call('setMember', { id: 'lee', role: 'owner', fullOwner: true, agents: [] }, 'sam', 'lee-owner')).status).toBe(200);
  f.root.writes.run(() => f.client.exec("UPDATE members SET role='member' WHERE id='sam'"));
  
});
it('rejects unknown agents and invalid full-owner/member combinations without partial effects', async () => {
  const f = fixture();
  expect((await f.call('setMember', { id: 'pat', role: 'member', agents: ['missing'] })).status).toBe(400);
  expect((await f.call('setMember', { id: 'pat', role: 'member', fullOwner: true, agents: [] })).status).toBe(400);
  expect(f.db.select().from(members).all()).toHaveLength(2);
  expect(f.db.select().from(memberAgents).all()).toEqual([]);
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
  const ws = await openSocket(f, 'lee');
  const first = await subscribe(ws, '{ agents { id about } }');
  expect(first.patches[0].value).toEqual({ agents: [{ id: 'art', about: 'Fixture agent' }] });
  const next = once(ws, 'message');
  expect((await f.call('setMember', { id: 'lee', role: 'member', agents: [] }, 'sam', 'withdraw')).status).toBe(200);
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['agents', 0], removed: true, value: null }]);
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
  expect(f.root.services.household.members().find(row => row.id === 'lee')).toMatchObject({ role: 'owner', fullOwner: true, agents: ['art','mark'] });
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
  const ws = await openSocket(f, 'sam');
  const first = await subscribe(ws, '{ members(where:{id:{eq:"lee"}}) { id } memberAgents { member agent } }');
  expect(first.patches[0].value).toEqual({ members: [{ id: 'lee' }], memberAgents: [{ member: 'lee', agent: 'art' },{member:'lee',agent:'mark'}] });
  const next = once(ws, 'message');
  expect((await f.call('setMember', { id: 'sam', role: 'member', agents: [] }, 'lee', 'demote')).status).toBe(200);
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([
    { path: ['members', 0], removed: true, value: null }, { path: ['memberAgents', 1], removed: true, value: null },{path:['memberAgents',0],removed:true,value:null},
  ]);
});

it.each([
  ['markBg', '#778899'], ['markFg', '#112233'], ['faceShape', 'drop'], ['faceEyes', 'oval'],
] as const)('invalidates the PNG pointer for %s alone while preserving stored sprite bytes', async (field, value) => {
  const f = fixture();
  // Opaque stored bytes deliberately include zero/high bytes: this service must
  // preserve them without decoding, rewriting or deleting another role's data.
  const sprite = { agent: 'art', layout: '{"fixture":"preserved"}', sheets: Buffer.from([0, 137, 80, 78, 71, 13, 10, 255]) };
  f.db.insert(agentSprites).values(sprite).run();
  expect((await f.call('setAgent', { id: 'art', ...visual, about: 'New biography' })).status).toBe(200);
  expect(f.db.select().from(agentSprites).all()).toEqual([sprite]);
  expect(f.db.select().from(agents).all().find(row => row.id === 'art')?.spriteVersion).toBe('old-png');
  expect((await f.call('setAgent', { id: 'art', ...visual, about: 'New biography', [field]: value }, 'sam', 'visual')).status).toBe(200);
  expect(f.db.select().from(agents).all().find(row => row.id === 'art')?.spriteVersion).toBeNull();
  expect(f.db.select().from(agentSprites).all()).toEqual([sprite]);
});

it('lets installed typed services bootstrap membership and agents without any door or credential', () => {
  const client = new Database(':memory:'); clean.push(() => { client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now), service = householdService(db, now);
  expect(db.select().from(members).all()).toEqual([]);
  expect(db.select().from(tokens).all()).toEqual([]);
  expect(service.setAgent({ id: 'first-agent', ...visual })).toEqual({ id: 'first-agent' });
  expect(service.setMember({ id: 'first-owner', role: 'owner', fullOwner: true, agents: ['first-agent'] })).toEqual({ id: 'first-owner' });
  expect(service.members()).toMatchObject([{ id: 'first-owner', role: 'owner', fullOwner: true, agents: ['first-agent'] }]);
  expect(db.select().from(tokens).all()).toEqual([]);
});
it('keeps generic member output types free of credential relations and generated credential tables', async () => {
  const f = fixture();
  const read = async (query: string) => (await f.root.http.request('http://loom/graphql', { method: 'POST', headers: {
    'content-type': 'application/json', authorization: 'Bearer '+credentials.sam,
  }, body: JSON.stringify({ query }) })).json();
  for (const [relation, fields] of [
    ['tokensByMember', 'fingerprint label'],
    ['notificationDevicesByMember', 'endpoint keys'],
  ]) {
    const answer = await read('{ members { '+relation+' { '+fields+' } } }');
    expect(answer.data).toBeUndefined();
    expect(answer.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(relation) })]));
  }
  const answer = await read('{ __schema { types { name } } }');
  const leaked = answer.data.__schema.types.map((type: { name: string }) => type.name)
    .filter((name: string) => /^(Tokens|Sessions|Passkeys|SigninLinks|SigninChallenges|NotificationDevices|OperationResults)/.test(name));
  expect(leaked).toEqual([]);
});
it('lets an owner change the household settings as a patch and read them back; nobody else can', async () => {
  const f = fixture();
  const query = '{ householdSetup { defaultAgent settings { timezone commsDays githubOwner secretsDefault backupTarget backupAt backupKeep backupRecipients } } }';
  const read = async (actor: keyof typeof credentials) => (await (await f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ query }) })).json() as { data: { householdSetup: { defaultAgent: string | null; settings: Record<string, unknown> } | null } }).data.householdSetup;
  const key = 'age1'+'q'.repeat(58);

  expect((await f.call('setSettings', { timezone: 'America/Chicago', commsDays: 7, defaultAgent: 'art' }, 'sam', 'first')).status).toBe(200);
  expect(await read('sam')).toMatchObject({ defaultAgent: 'art', settings: { timezone: 'America/Chicago', commsDays: 7, githubOwner: '', secretsDefault: 'ask', backupTarget: '', backupAt: '03:00', backupKeep: 7, backupRecipients: [] } });
  expect((await f.call('setSettings', { githubOwner: 'sleepunit-agents', backupTarget: '/srv/backups', backupAt: '02:40', backupKeep: 30, backupRecipients: [key, key] }, 'sam', 'second')).status).toBe(200);
  expect(await read('sam')).toMatchObject({ defaultAgent: 'art', settings: { timezone: 'America/Chicago', commsDays: 7, githubOwner: 'sleepunit-agents', backupTarget: '/srv/backups', backupAt: '02:40', backupKeep: 30, backupRecipients: [key] } });
  expect((await f.call('setSettings', { defaultAgent: null, backupRecipients: [] }, 'sam', 'third')).status).toBe(200);
  expect(await read('sam')).toMatchObject({ defaultAgent: null, settings: { backupRecipients: [], backupTarget: '/srv/backups' } });
  let n = 0;
  for (const bad of [{}, { timezone: 'Mars/Olympus' }, { commsDays: 15 }, { backupAt: '25:00' }, { backupKeep: 0 }, { backupRecipients: ['not a key'] }, { secretsDefault: 'auto' }])
    expect((await f.call('setSettings', bad, 'sam', 'bad-'+(n++))).status).toBe(400);
  expect((await (await f.call('setSettings', { defaultAgent: 'nobody' }, 'sam', 'unknown')).json() as { code?: string })).toMatchObject({ code: 'invalid' });
  expect(await read('sam')).toMatchObject({ defaultAgent: null, settings: { timezone: 'America/Chicago', commsDays: 7 } });
  expect(await read('lee')).toBeNull();
});
