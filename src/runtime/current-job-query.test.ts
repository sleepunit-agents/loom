import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { GraphQLString } from 'graphql/index.js';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { agents, jobs, members, memberAgents, projects, projectMembers, projectAgents, tokens, boxes, agentModels, agentBoxes, agentRunSettings, modelAccounts, modelAccountBoxes, modelAccountWindows } from '../core/data/schema.js';
import { httpWorkerControl } from './worker-http.js';
import { sharedRoot } from '../shared-root.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const keys = { alice: 'a'.repeat(64), bob: 'b'.repeat(64), house: 'h'.repeat(64), guest: 'g'.repeat(64), art: 'x'.repeat(64), worker: 'w'.repeat(64) };
function fixture(fields?: Parameters<typeof sharedRoot>[0]['fields']) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  for (const id of ['alice', 'bob', 'house', 'guest']) db.insert(members).values({ id, role: id === 'house' ? 'owner' : 'member', joinedAt: now() }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values([{ member: 'alice', agent: 'art' }, { member: 'house', agent: 'art' }]).run();
  db.insert(projects).values({ id: 'p', name: 'Project' }).run();
  db.insert(projectMembers).values({ project: 'p', member: 'bob' }).run();
  db.insert(projectAgents).values({ project: 'p', agent: 'art' }).run();
  db.insert(boxes).values({ id: 'worker', owner: 'house', name: 'Worker', sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: now() }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  db.insert(agentBoxes).values({ agent: 'art', box: 'worker', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'house', provider: 'provider', label: 'Account', hasRoom: true }).run();
  db.insert(modelAccountBoxes).values({ account: 'account', box: 'worker' }).run();
  db.insert(modelAccountWindows).values({ account: 'account', window: 'week', usage: 0.2, usageReadAt: now(), resetsAt: new Date(clock.now()+3.5*86400000).toISOString(), durationMs: 7*86400000 }).run();
  for (const [id, key] of Object.entries(keys)) db.insert(tokens).values({ fingerprint: createHash('sha256').update(key).digest('hex'), label: id,
    kind: id === 'art' ? 'agent' : id === 'worker' ? 'runner' : 'owner', box: id === 'worker' ? id : null, agent: id === 'art' ? id : null, member: id === 'art' || id === 'worker' ? null : id, createdAt: now() }).run();
  const add = (id: string, extra: Partial<typeof jobs.$inferInsert> = {}) => db.insert(jobs).values({ id, agent: 'art', state: 'queued', title: 'Title '+id, brief: 'Never query these private words', model: 'model',
    startedByKind: 'agent', startedBy: 'art', houseRepository: 'private repo', houseFile: 'Housefile', houseBranch: 'next', queuedAt: now(), ...extra }).run();
  add('owned'); add('project', { agent: 'mark', project: 'p' }); add('private-alice', { project: 'p', member: 'alice' }); add('private-bob', { project: 'p', member: 'bob' }); add('private-house', { member: 'house' });
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {}, fields, modelRoles: () => [{ model: 'model', provider: 'provider', harness: 'fake', series: 's' }] }); cleanup.push(() => root.close());
  const query = (agent = 'art') => `{ currentJobs(agent:${JSON.stringify(agent)}) { id agent title state box queuedAt } }`;
  const post = (who: keyof typeof keys, source = query()) => root.http.request('/graphql', { method: 'POST', headers: { authorization: 'Bearer '+keys[who], 'content-type': 'application/json' }, body: JSON.stringify({ query: source }) });
  const control = httpWorkerControl({ url: 'https://loom.example', token: keys.worker, signal: new AbortController().signal, fetch: async (input, init) => root.http.fetch(new Request(input, init)) });
  return { client, db, root, post, query, now, control };
}
it('mounts current jobs through the real root with canonical private-member precedence', async () => {
  const f = fixture();
  // A member's private conversation is that member's alone: the household owner sees the job of their own
  // private thread and not Alice's or Bob's.
  for (const [who, ids] of [['alice', ['owned', 'private-alice']], ['bob', ['private-bob']], ['house', ['owned', 'private-house']], ['guest', []], ['art', ['owned']]] as const) {
    const response = await f.post(who); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.errors).toBeUndefined(); expect(body.data.currentJobs.map((row: { id: string }) => row.id)).toEqual(ids);
    expect(JSON.stringify(body)).not.toMatch(/Never query|private repo|Housefile/);
  }
  for (const who of ['bob', 'art'] as const) expect((await (await f.post(who, f.query('mark'))).json()).data.currentJobs.map((row: {id:string}) => row.id)).toEqual(['project']);
});
for (const revoked of ['project', 'owned-agent', 'household-owner'] as const) it(`rechecks ${revoked} after a public await and never releases stale titles`, async () => {
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ hold: { type: GraphQLString, resolve: async () => { began(); await held; return 'ready'; } } });
  const who = revoked === 'project' ? 'bob' : revoked === 'owned-agent' ? 'alice' : 'house';
  const agent = revoked === 'project' ? 'mark' : 'art';
  const pending = f.post(who, `{ currentJobs(agent:"${agent}") { title } hold }`); await started;
  f.root.writes.run(() => {
    if (revoked === 'project') f.db.delete(projectMembers).run();
    else if (revoked === 'owned-agent') f.db.delete(memberAgents).where(eq(memberAgents.member, 'alice')).run();
    else f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'house')).run();
  });
  release(); const response = await pending; expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('Title');
  const fresh = (await (await f.post(who, f.query(agent))).json()).data.currentJobs.map((row: { id: string }) => row.id);
  expect(fresh).toEqual(revoked === 'project' ? [] : revoked === 'owned-agent' ? ['private-alice'] : ['owned', 'private-house']);
});
it('reads placement on a visible job and keeps private decisions with their jobs', async () => {
  const f = fixture(), decision = [{box: 'worker', outcome: 'taken' as const, reason: 'Preferred facts matched'}];
  f.db.update(jobs).set({prefers: ['fast'], placementDecision: decision}).where(eq(jobs.id, 'private-bob')).run();
  const query = '{ jobHistory(agent:"art", id:"private-bob", first:1) { id prefers placementDecision { box outcome reason } } }';
  expect(await (await f.post('bob', query)).json()).toEqual({data: {jobHistory: [{id: 'private-bob', prefers: ['fast'], placementDecision: decision}]}});
  expect(await (await f.post('alice', query)).json()).toEqual({data: {jobHistory: []}});
  const older = '{ jobHistory(agent:"art", id:"owned", first:1) { id prefers placementDecision { box } } }';
  expect(await (await f.post('alice', older)).json()).toEqual({data: {jobHistory: [{id: 'owned', prefers: null, placementDecision: null}]}});
});
it('offers only Home summary columns and does not accept raw execution fields', async () => {
  const f = fixture(), body = await (await f.post('house', '{ __type(name:"CurrentJobSummary") { fields { name } } }')).json();
  expect(body.data.__type.fields.map((field: { name: string }) => field.name).sort()).toEqual(['agent', 'box', 'id', 'kind', 'queuedAt', 'state', 'title']);
  const invalid = await (await f.post('house', '{ currentJobs(agent:"art") { brief logTail account build } }')).json();
  expect(invalid.errors).toHaveLength(4); expect(invalid.data).toBeUndefined();
});
it('updates a real live selection as jobs start, run and finish', async () => {
  const f = fixture(), ws = await openSocket(f, 'alice'); let next: ReturnType<typeof once>;
  next = once(ws, 'message'); ws.send(JSON.stringify({type:'subscribe',id:'jobs',payload:{query:`subscription { observe(query:${JSON.stringify('{ currentJobs(agent:"art") { id state } }')}) { revision patches { path value removed } } }`}}));
  expect(String((await next)[0])).toContain('owned');
  for (const state of ['starting', 'running', 'done'] as const) {
    next = once(ws, 'message');
    if (state === 'starting') expect((await f.control.next())?.id).toBe('owned');
    else if (state === 'running') await f.control.started('owned', 'image');
    else await f.control.finish('owned', 0, '');
    const patches = JSON.parse(String((await next)[0])).payload.data.observe.patches;
    if (state === 'done') expect(patches).toEqual([
      { path: ['currentJobs', 0, 'id'], removed: false, value: 'private-alice' },
      { path: ['currentJobs', 0, 'state'], removed: false, value: 'queued' },
      { path: ['currentJobs', 1], removed: true, value: null },
    ]);
    else expect(patches).toEqual([{ path: ['currentJobs', 0, 'state'], removed: false, value: state }]);
  }
});

async function openSocket(f: ReturnType<typeof fixture>, who: keyof typeof keys) {
  const server = createServer(); f.root.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { await f.root.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No test listener');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { authorization: 'Bearer '+keys[who] } }); cleanup.push(() => { ws.terminate(); });
  await once(ws, 'open'); const ack = once(ws, 'message'); ws.send(JSON.stringify({type:'connection_init'})); await ack; return ws;
}
it('removes a job from a retained socket selection when project sharing ends', async () => {
  const f = fixture(), ws = await openSocket(f, 'bob'); let next = once(ws, 'message');
  ws.send(JSON.stringify({type:'subscribe',id:'project-jobs',payload:{query:`subscription { observe(query:${JSON.stringify('{ currentJobs(agent:"mark") { id title } }')}) { revision patches { path value removed } } }`}}));
  expect(String((await next)[0])).toContain('Title project');
  next = once(ws, 'message'); f.root.writes.run(() => f.db.delete(projectMembers).run());
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['currentJobs', 0], removed: true, value: null }]);
});

it('keeps public, account and bridge selections mounted and refuses runner reads', async () => {
  const f = fixture();
  const response = await f.post('bob', '{ currentJobs(agent:"mark") { id } projects { id } modelAccounts { ... on RuntimeAccount { label level } } bridgeConnections { id } }');
  expect(await response.json()).toEqual({ data: { currentJobs: [{ id: 'project' }], projects: [{ id: 'p' }], modelAccounts: [{ label: 'Account', level: 'plenty' }], bridgeConnections: [] } });
  const rejected = await f.post('worker'); expect(rejected.status).toBe(403); expect(await rejected.text()).not.toContain('Title');
});
it('rejects a held socket publication when selected project access ends', async () => {
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ hold: { type: GraphQLString, resolve: async () => { began(); await held; return 'ready'; } } }), ws = await openSocket(f, 'bob');
  const frames: string[] = []; ws.on('message', raw => frames.push(String(raw)));
  ws.send(JSON.stringify({type:'subscribe',id:'held',payload:{query:`subscription { observe(query:${JSON.stringify('{ currentJobs(agent:"mark") { title } hold }')}) { revision patches { path value removed } } }`}}));
  await started; const next = once(ws, 'message'); f.root.writes.run(() => f.db.delete(projectMembers).run()); release();
  const frame = JSON.parse(String((await next)[0]));
  expect(frame.payload.data.observe.patches[0].value.currentJobs).toEqual([]);
  expect(frames.join(' ')).not.toContain('Title project');
});

it('withholds titles when a sibling read ends project access before publication', async () => {
  let f!: ReturnType<typeof fixture>, changed = false;
  f = fixture({ frameProbe: { type: GraphQLString, resolve: () => {
    if (!changed) { changed = true; f.root.writes.run(() => f.db.delete(projectMembers).run()); } return 'probe';
  } } });
  const ws = await openSocket(f, 'bob'), frames: string[] = []; ws.on('message', raw => frames.push(String(raw)));
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({type:'subscribe',id:'publication',payload:{query:'{ currentJobs(agent:"mark") { title } frameProbe }'}}));
  expect((await closed)[0]).toBe(1012); expect(changed).toBe(true); expect(frames.join(' ')).not.toContain('Title project');
});
