import Database from 'better-sqlite3';
import { runtimeAccountsQuery } from '../../web/src/pieces/runtime/model-query.js';
import { deskTimeFields } from '../desk-time.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { GraphQLString } from 'graphql/index.js';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { accountWeekReadings, conversations, inbox, inboxRefs, triggers, jobs, jobUsage, agents, boxes, members, memberAgents, modelAccounts, modelAccountBoxes, modelAccountLogins, modelAccountWindows, tokens } from '../core/data/schema.js';
import { nextData } from '../next-data.js';
import { modelAccountQueries } from './account-query.js';
import { readModelAccounts } from '../core/data/model-account-read.js';
import type { Viewer } from '../policy.js';
import { GraphQLNonNull, GraphQLList, GraphQLUnionType } from 'graphql/index.js';
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const keys = { alice: 'a'.repeat(64), bob: 'b'.repeat(64), guest: 'g'.repeat(64), house: 'h'.repeat(64), agent: 'x'.repeat(64) };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const selection = `modelAccounts { ... on RuntimeAccount { label level }
  ... on RuntimeAccountDetail { id owner provider usage usageReadAt resetsAt hasRoom signedInOn { id name } windows { window usage resetsAt } } }`;
function fixture(fields?: Parameters<typeof nextData>[4]) {
  const statements: string[] = [];
  const client = new Database(':memory:', { verbose: value => statements.push(String(value)) }); clean.push(() => { if (client.open) client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  for (const id of ['alice', 'bob', 'guest', 'house']) db.insert(members).values({ id, role: id === 'house' ? 'owner' : 'member', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'agent', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'house', agent: 'agent' }).run();
  for (const [id, key] of Object.entries(keys)) db.insert(tokens).values({ fingerprint: hash(key), label: id, kind: id === 'agent' ? 'agent' : 'owner', agent: id === 'agent' ? id : null, member: id === 'agent' ? null : id, createdAt: now() }).run();
  db.insert(boxes).values({ id: 'private-box-id', name: 'Private worker name', owner: 'house', sameMachineAsLoom: false, hostsAny: false, reportOnly: false, alwaysOn: false, enrolledAt: now() }).run();
  const reset = new Date(clock.now() + 3.5 * 86400_000).toISOString();
  for (const [id, owner, usage] of [['private-a', 'alice', 0.2], ['private-b', 'bob', 0.58]] as const) {
    db.insert(modelAccounts).values({ id, owner, label: id === 'private-a' ? 'Main subscription' : 'Other subscription', provider: 'private-provider', usage, usageReadAt: now(), resetsAt: reset, hasRoom: true }).run();
    db.insert(modelAccountWindows).values({ account: id, window: 'week', usage, usageReadAt: now(), resetsAt: reset, durationMs: 7 * 86400_000 }).run();
    db.insert(modelAccountBoxes).values({ account: id, box: 'private-box-id' }).run();
  }
  const data = nextData(db, clock, () => true, undefined, { ...deskTimeFields(db, clock), ...fields }); clean.push(() => data.close());
  const post = (who: keyof typeof keys, query = `{ ${selection} }`, variables?: unknown) => data.http.request('/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + keys[who] }, body: JSON.stringify({ query, variables }),
  });
  return { client, clock, now, db, data, post, statements };
}
const coarse = [{ label: 'Main subscription', level: 'plenty' }, { label: 'Other subscription', level: 'getting full' }];
it('projects only label and coarse level for unrelated members and agents, even agents owned by household owners', async () => {
  const f = fixture();
  for (const who of ['guest', 'agent'] as const) {
    const response = await f.post(who); expect(response.status).toBe(200);
    const body = await response.json(); expect(body).toEqual({ data: { modelAccounts: coarse } });
    expect(JSON.stringify(body)).not.toMatch(/private-provider|private-box|Private worker|usageReadAt|hasRoom|owner/);
  }
});
it('shows full account data only to its actual member owner or a household owner', async () => {
  const f = fixture();
  const alice = await (await f.post('alice')).json();
  expect(alice.data.modelAccounts[0]).toEqual({ ...coarse[0], id: 'private-a', owner: 'alice', provider: 'private-provider', usage: 0.2,
    usageReadAt: f.now(), resetsAt: new Date(f.clock.now() + 3.5 * 86400_000).toISOString(), hasRoom: true, signedInOn: [{ id: 'private-box-id', name: 'Private worker name' }],
    windows: [{window:'week',usage:.2,resetsAt:new Date(f.clock.now()+3.5*86400_000).toISOString()}] });
  expect(alice.data.modelAccounts[1]).toEqual(coarse[1]);
  const house = await (await f.post('house')).json(); expect(house.data.modelAccounts.map((row: { id: string }) => row.id)).toEqual(['private-a', 'private-b']);
  expect(house.data.modelAccounts[1]).toMatchObject({ owner: 'bob', provider: 'private-provider', usage: 0.58 });
  const bob = await (await f.post('bob')).json(); expect(bob.data.modelAccounts[0]).toEqual(coarse[0]); expect(bob.data.modelAccounts[1].owner).toBe('bob');
});
it('uses current shared capacity for coarse levels without fabricating a fresh reading at reset', async () => {
  const f = fixture();
  f.data.writes.run(() => f.db.update(modelAccountWindows).set({ usage: 0.9 }).where(eq(modelAccountWindows.account, 'private-a')).run());
  expect((await (await f.post('guest')).json()).data.modelAccounts[0].level).toBe('almost full');
  f.data.writes.run(() => f.db.update(modelAccounts).set({ hasRoom: false }).where(eq(modelAccounts.id, 'private-b')).run());
  expect((await (await f.post('guest')).json()).data.modelAccounts[1].level).toBe('almost full');
  const readAt = f.now(), resetAt = new Date(f.clock.now() + 3.5 * 86400_000).toISOString(); f.clock.advance(3.5 * 86400_000);
  const detail = (await (await f.post('alice')).json()).data.modelAccounts[0];
  expect(detail).toMatchObject({ level: 'almost full', usage: 0.2, usageReadAt: readAt, resetsAt: resetAt, hasRoom: false });
});
it('does not accept caller-selected authority or private-column filter arguments', async () => {
  const f = fixture();
  expect(await (await f.post('guest', `{ ${selection} }`, { viewer: { kind: 'member', id: 'house' }, owner: 'alice' })).json()).toEqual({ data: { modelAccounts: coarse } });
  const filtered = await (await f.post('guest', '{ modelAccounts(owner:"alice") { ... on RuntimeAccount { label level } } }')).json();
  expect(filtered.errors).toHaveLength(1); expect(filtered.data).toBeUndefined();
});
for (const revoke of ['household-role', 'account-owner'] as const) it(`fences buffered private fields after ${revoke} changes during an async sibling`, async () => {
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(yes => { begin = yes; }), held = new Promise<void>(yes => { release = yes; });
  const f = fixture({ hold: { type: GraphQLString, resolve: async () => { begin(); await held; return 'ready'; } } });
  const who = revoke === 'household-role' ? 'house' : 'alice';
  const pending = f.post(who, `{ ${selection} hold }`); await started;
  f.data.writes.run(() => revoke === 'household-role'
    ? f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'house')).run()
    : f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run());
  release(); const response = await pending; expect(response.status).toBe(401);
  expect(await response.text()).not.toMatch(/private-provider|private-box|Private worker|0\.58/);
  expect(await (await f.post(who)).json()).toEqual({ data: { modelAccounts: coarse } });
});
it('rechecks account authority before live socket delivery and clears the authenticated read on revocation', async () => {
  const f = fixture(), ws = await openSocket(f, 'alice'); let next: ReturnType<typeof once>;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'accounts', payload: { query: `subscription { observe(query:${JSON.stringify(`{ ${selection} }`)}) { revision patches { path value removed } } }` } }));
  expect(String((await next)[0])).toContain('private-provider');
  const after: string[] = []; ws.on('message', raw => after.push(String(raw))); const closed = once(ws, 'close');
  f.data.writes.run(() => f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run());
  expect((await closed)[0]).toBe(4403); expect(after.join('\n')).not.toContain('private-provider');
});

it('orders public views by the visible label instead of hidden account identifiers', async () => {
  const f = fixture();
  f.data.writes.run(() => {
    f.db.update(modelAccounts).set({ label: 'Zulu' }).where(eq(modelAccounts.id, 'private-a')).run();
    f.db.update(modelAccounts).set({ label: 'Alpha' }).where(eq(modelAccounts.id, 'private-b')).run();
  });
  expect((await (await f.post('guest')).json()).data.modelAccounts).toEqual([{ label: 'Alpha', level: 'getting full' }, { label: 'Zulu', level: 'plenty' }]);
});

async function openSocket(f: ReturnType<typeof fixture>, who: keyof typeof keys) {
  const server = createServer(), detach = f.data.attach(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  clean.push(async () => { detach(); await f.data.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { authorization: 'Bearer ' + keys[who] } }); clean.push(() => ws.terminate());
  await once(ws, 'open'); const ack = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await ack; return ws;
}
function nextPayload(ws: WebSocket, id: string) {
  return new Promise<{ data: Record<string, unknown> }>((resolve, reject) => {
    const message = (raw: unknown) => { const value = JSON.parse(String(raw)); if (value.id === id && value.type === 'next') { ws.off('message', message); ws.off('close', close); resolve(value.payload); } };
    const close = () => { ws.off('message', message); reject(new Error('Unexpected selection close')); };
    ws.on('message', message); ws.once('close', close);
  });
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
it('rejects a held socket response after direct ownership transfer without a refresh notification', async () => {
  const began = deferred(), gate = deferred();
  const f = fixture({ hold: { type: GraphQLString, resolve: async () => { began.resolve(); await gate.promise; return 'ready'; } } });
  const ws = await openSocket(f, 'alice'), closed = once(ws, 'close'), frames: string[] = []; ws.on('message', raw => frames.push(String(raw)));
  ws.send(JSON.stringify({ type: 'subscribe', id: 'held', payload: { query: `{ ${selection} hold }` } })); await began.promise;
  f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run(); gate.resolve();
  expect((await closed)[0]).toBe(4403); expect(frames.join('\n')).not.toContain('private-provider');
});
it('keeps concurrent public requests and a second root independent of one private read witness', async () => {
  const privateBegan = deferred(), publicBegan = deferred(), privateGate = deferred(), publicGate = deferred(), otherBegan = deferred(), otherGate = deferred();
  const f = fixture({ hold: { type: GraphQLString, args: { slot: { type: GraphQLString } }, resolve: async (_source, args) => {
    const privateRead = args.slot === 'private'; (privateRead ? privateBegan : publicBegan).resolve(); await (privateRead ? privateGate : publicGate).promise; return 'ready';
  } } });
  const g = fixture({ hold: { type: GraphQLString, resolve: async () => { otherBegan.resolve(); await otherGate.promise; return 'ready'; } } });
  g.db.update(modelAccounts).set({ provider: 'other-root-provider' }).where(eq(modelAccounts.id, 'private-a')).run();
  const privateRead = f.post('alice', `{ ${selection} hold(slot:"private") }`), publicRead = f.post('alice', '{ __typename hold(slot:"public") }'), otherRead = g.post('alice', `{ ${selection} hold }`);
  await Promise.all([privateBegan.promise, publicBegan.promise, otherBegan.promise]);
  f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run();
  privateGate.resolve(); publicGate.resolve(); otherGate.resolve();
  expect((await privateRead).status).toBe(401); expect((await publicRead).status).toBe(200);
  const other = await otherRead; expect(other.status).toBe(200); expect((await other.json()).data.modelAccounts[0].provider).toBe('other-root-provider');
});
it('keeps unrelated sockets for the same member valid when one account selection loses access', async () => {
  const f = fixture(), privateWS = await openSocket(f, 'alice'), publicWS = await openSocket(f, 'alice');
  let first = nextPayload(privateWS, 'private'); privateWS.send(JSON.stringify({ type: 'subscribe', id: 'private', payload: { query: `{ ${selection} }` } })); expect(JSON.stringify(await first)).toContain('private-provider');
  first = nextPayload(publicWS, 'public'); publicWS.send(JSON.stringify({ type: 'subscribe', id: 'public', payload: { query: '{ __typename }' } })); expect((await first).data.__typename).toBeTruthy();
  const closed = once(privateWS, 'close'); f.data.writes.run(() => f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run());
  expect((await closed)[0]).toBe(4403); expect(publicWS.readyState).toBe(WebSocket.OPEN);
  first = nextPayload(publicWS, 'still-public'); publicWS.send(JSON.stringify({ type: 'subscribe', id: 'still-public', payload: { query: '{ __typename }' } })); expect((await first).data.__typename).toBeTruthy();
});
it('honors delegate credential revocation during a pending private response', async () => {
  const began = deferred(), gate = deferred();
  const f = fixture({ hold: { type: GraphQLString, resolve: async () => { began.resolve(); await gate.promise; return 'ready'; } } });
  const pending = f.post('alice', `{ ${selection} hold }`); await began.promise;
  f.db.update(tokens).set({ revokedAt: f.now() }).where(eq(tokens.fingerprint, hash(keys.alice))).run(); gate.resolve();
  const response = await pending; expect(response.status).toBe(401); expect(await response.text()).not.toContain('private-provider'); expect((await f.post('alice')).status).toBe(401);
});
it('preserves socket credential expiry metadata without requiring another request or write', async () => {
  const f = fixture(); f.db.update(tokens).set({ expiresAt: new Date(f.clock.now() + 1000).toISOString() }).where(eq(tokens.fingerprint, hash(keys.alice))).run();
  const ws = await openSocket(f, 'alice'), first = nextPayload(ws, 'accounts'); ws.send(JSON.stringify({ type: 'subscribe', id: 'accounts', payload: { query: `{ ${selection} }` } })); expect(JSON.stringify(await first)).toContain('private-provider');
  const closed = once(ws, 'close'); f.clock.advance(1000); expect((await closed)[0]).toBe(4403);
});

it('rechecks authority before sending a result whose sibling read changes account ownership', async () => {
  const changed = deferred();
  const f = fixture({ probe: { type: GraphQLString, resolve: () => {
    f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run(); changed.resolve(); return 'probe';
  } } }), ws = await openSocket(f, 'alice');
  const closed = once(ws, 'close'), frames: string[] = []; ws.on('message', raw => frames.push(String(raw)));
  ws.send(JSON.stringify({ type: 'subscribe', id: 'changed', payload: { query: `{ ${selection} probe }` } }));
  await changed.promise; expect((await closed)[0]).toBe(4403); expect(frames.join('\n')).not.toContain('private-provider');
});

it('keeps public-only account selections valid across ownership transfer without a private witness', async () => {
  const began = deferred(), gate = deferred(), publicSelection = 'modelAccounts { ... on RuntimeAccount { label level } }';
  const f = fixture({ hold: { type: GraphQLString, resolve: async () => { began.resolve(); await gate.promise; return 'ready'; } } });
  const pending = f.post('alice', `{ ${publicSelection} hold }`); await began.promise;
  f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run(); gate.resolve();
  const response = await pending; expect(response.status).toBe(200); expect((await response.json()).data.modelAccounts).toEqual(coarse);
  f.db.update(modelAccounts).set({ owner: 'alice' }).where(eq(modelAccounts.id, 'private-a')).run();
  const ws = await openSocket(f, 'alice'); let next = nextPayload(ws, 'public-only'); ws.send(JSON.stringify({ type: 'subscribe', id: 'public-only', payload: { query: `{ ${publicSelection} }` } })); expect((await next).data.modelAccounts).toEqual(coarse);
  f.data.writes.run(() => f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run());
  await new Promise<void>(resolve => setImmediate(resolve)); expect(ws.readyState).toBe(WebSocket.OPEN);
  next = nextPayload(ws, 'public-again'); ws.send(JSON.stringify({ type: 'subscribe', id: 'public-again', payload: { query: `{ ${publicSelection} }` } })); expect((await next).data.modelAccounts).toEqual(coarse);
});
it('declares exactly the permitted summary columns and rejects private fields on its fragment', async () => {
  const f = fixture(), shape = await (await f.post('guest', '{ __type(name:"RuntimeAccountSummary") { fields { name } } }')).json();
  expect(shape.data.__type.fields.map((field: { name: string }) => field.name).sort()).toEqual(['label', 'level']);
  const result = await (await f.post('guest', '{ modelAccounts { ... on RuntimeAccountSummary { provider } } }')).json();
  expect(result.errors).toHaveLength(1); expect(result.data).toBeUndefined();
});
it('refuses buffered private data when a selected account disappears without a refresh', async () => {
  const began = deferred(), gate = deferred();
  const f = fixture({ hold: { type: GraphQLString, resolve: async () => { began.resolve(); await gate.promise; return 'ready'; } } });
  const pending = f.post('house', `{ ${selection} hold }`); await began.promise;
  f.db.transaction(() => {
    f.db.delete(modelAccountBoxes).where(eq(modelAccountBoxes.account, 'private-a')).run();
    f.db.delete(modelAccountWindows).where(eq(modelAccountWindows.account, 'private-a')).run();
    f.db.delete(modelAccounts).where(eq(modelAccounts.id, 'private-a')).run();
  }); gate.resolve();
  const response = await pending; expect(response.status).toBe(401); expect(await response.text()).not.toContain('private-provider');
});
for (const args of ['viewer:"house"', 'orderBy:"provider"', 'caller:{kind:"member",id:"house"}']) it(`refuses untrusted authority or private ordering arguments: ${args}`, async () => {
  const f = fixture(), result = await (await f.post('guest', `{ modelAccounts(${args}) { ... on RuntimeAccount { label level } } }`)).json();
  expect(result.errors).toHaveLength(1); expect(result.data).toBeUndefined();
});

it.each([{}, {fieldNodes: []}])('checks current permission and exact Viewer independently at private column access with root info %j', async info => {
  const f = fixture(), viewer: Viewer = { kind: 'member', id: 'alice' };
  const projection = modelAccountQueries(f.db, f.now), field = projection.fields.modelAccounts;
  const rows = await field.resolve!({}, {}, { viewer }, info as never) as unknown[];
  const union = (field.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLUnionType>>>).ofType.ofType.ofType;
  const privateField = union.getTypes().find(type => type.name === 'RuntimeAccountDetail')!.getFields().provider;
  const read = (actor: Viewer) => privateField.resolve!(rows[0], {}, { viewer: actor }, {} as never);
  expect(await read(viewer)).toBe('private-provider');
  expect(() => read({ kind: 'member', id: 'alice' })).toThrow('Account access ended');
  f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run();
  await expect(read(viewer)).rejects.toThrow('Account access ended');
});
it('does not establish ownership for a retained Viewer whose member no longer exists', async () => {
  const f = fixture(), viewer: Viewer = { kind: 'member', id: 'alice' };
  // Deliberately bypass credential admission to isolate the projection's own check.
  f.client.pragma('foreign_keys = OFF');
  f.db.delete(members).where(eq(members.id, 'alice')).run();
  const projection = modelAccountQueries(f.db, f.now);
  const rows = await projection.fields.modelAccounts.resolve!({}, {}, { viewer }, {} as never) as unknown[];
  // Not the detail, and not the summary either: that is for someone in the household now (rules.accountSummary).
  expect(rows).toEqual([]);
});
it('registers a private witness when only account locations are selected', async () => {
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(yes => { begin = yes; }), held = new Promise<void>(yes => { release = yes; });
  const f = fixture({ hold: { type: GraphQLString, resolve: async () => { begin(); await held; return 'ready'; } } });
  const pending = f.post('alice', '{ modelAccounts { ... on RuntimeAccountDetail { signedInOn { id name } } } hold }');
  await started;
  f.db.update(modelAccounts).set({ owner: 'bob' }).where(eq(modelAccounts.id, 'private-a')).run();
  release(); const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toMatch(/private-box|Private worker/);
});

it.each(['http', 'socket', 'observe'])('keeps the shipped model-account page SQL count fixed as accounts grow via %s', async door => {
  const counts: number[] = [];
  for (const size of [2, 10]) {
    const f = fixture();
    for (let n = 2; n < size; n++) {
      const id = `private-${n}`;
      f.db.insert(modelAccounts).values({ id, owner: 'alice', label: `Subscription ${n}`, provider: 'private-provider', usage: 0.2, usageReadAt: f.now(), resetsAt: new Date(f.clock.now() + 86400000).toISOString(), hasRoom: true }).run();
      f.db.insert(modelAccountWindows).values({ account: id, window: 'day', usage: 0.2, usageReadAt: f.now(), resetsAt: new Date(f.clock.now() + 86400000).toISOString(), durationMs: 86400000 }).run();
      f.db.insert(modelAccountBoxes).values({ account: id, box: 'private-box-id' }).run();
    }
    const socket = door === 'http' ? undefined : await openSocket(f, 'house');
    f.statements.length = 0;
    let result: { errors?: unknown; data: {modelAccounts: {signedInOn: unknown[]}[]} };
    if (!socket) result = await (await f.post('house', runtimeAccountsQuery)).json();
    else {
      const next = nextPayload(socket, 'growth');
      const payload = door === 'socket' ? {query: runtimeAccountsQuery} : {query: 'subscription($query:String!){observe(query:$query){revision patches{path value}}}', variables: {query: runtimeAccountsQuery}};
      socket.send(JSON.stringify({type: 'subscribe', id: 'growth', payload}));
      const value = await next;
      result = door === 'socket' ? value as typeof result : {data: (value.data.observe as {patches: {value: typeof result.data}[]}).patches[0].value};
    }
    expect(result.errors).toBeUndefined(); expect(result.data.modelAccounts).toHaveLength(size);
    expect(result.data.modelAccounts.every(row => row.signedInOn.length === 1)).toBe(true);
    counts.push(f.statements.filter(statement => /^select\b/i.test(statement)).length);
  }
  expect(counts).toEqual([counts[0], counts[0]]);
});

it('shows an account\'s name and level to whoever is in the household now, by a rule, and to nobody else', () => {
  const f = fixture(), labels = (viewer: Viewer) => readModelAccounts(f.db, viewer).rows.map(row => row.label);
  const all = ['Main subscription', 'Other subscription'];
  for (const viewer of [{ kind: 'member', id: 'guest' }, { kind: 'agent', id: 'agent' }, { kind: 'agent', id: 'agent', workingFor: 'guest' }] as const) expect(labels(viewer)).toEqual(all);
  for (const viewer of [{ kind: 'runner', id: 'private-box-id' }, { kind: 'service', id: 'tasks' }, { kind: 'member', id: 'nobody' }, { kind: 'agent', id: 'nobody' }] as const) expect(labels(viewer)).toEqual([]);
  // A removed member, and a body whose member has been removed, are nobody (rules.accountSummary).
  f.db.update(members).set({ removedAt: new Date(f.clock.now()).toISOString() }).where(eq(members.id, 'guest')).run();
  for (const viewer of [{ kind: 'member', id: 'guest' }, { kind: 'agent', id: 'agent', workingFor: 'guest' }] as const) expect(labels(viewer)).toEqual([]);
});

it('offers sign-in only for a reporting machine the viewer may manage',async()=>{
  const f=fixture();
  f.db.update(boxes).set({lastSeenAt:f.now()}).run();
  f.db.insert(modelAccountLogins).values({account:'private-a',box:'private-box-id',harness:'codex',place:'containers',state:'signed-out',since:f.now(),checkedAt:f.now(),learnedFrom:'check'}).run();
  const query='{ modelAccounts { ... on RuntimeAccountDetail { logins { reporting needsSignIn canRequest } } } }';
  const login=async(who:'alice'|'house')=>(await (await f.post(who,query)).json()).data.modelAccounts[0].logins[0];
  expect(await login('house')).toEqual({reporting:true,needsSignIn:true,canRequest:true});
  expect(await login('alice')).toEqual({reporting:true,needsSignIn:true,canRequest:false});
  f.clock.advance(121_000);
  expect(await login('house')).toEqual({reporting:false,needsSignIn:false,canRequest:false});
});

it.each([
  {offset:2000,expected:.2},
  {offset:2001,expected:0},
])('uses contiguous weekly readings within reset tolerance ($offset ms)', async ({offset,expected}) => {
  const f=fixture(), end=f.clock.now(), iso=(at:number)=>new Date(at).toISOString();
  const reset=end+3.5*86400_000, start=iso(end-60_000);
  f.db.insert(accountWeekReadings).values([
    {account:'private-a',window:'week',readAt:start,resetsAt:iso(reset),usage:0},
    {account:'private-a',window:'week',readAt:iso(end-30_000),resetsAt:iso(reset+offset),usage:0},
  ]).run();
  f.db.insert(jobs).values({id:'measured',agent:'agent',member:'alice',account:'private-a',title:'Measured job',
    state:'done',model:'m',brief:'',startedByKind:'member',startedBy:'alice',houseRepository:'r',houseFile:'f',houseBranch:'b',
    queuedAt:start,claimedAt:start,endedAt:iso(end)}).run();
  f.db.insert(jobUsage).values({job:'measured',source:'report',tokensIn:1,tokensOut:1}).run();
  const result=await (await f.post('alice','{modelAccounts {... on RuntimeAccountDetail { weeklyUsage {unattributed agents {share}}}}}')).json();
  expect(result.data.modelAccounts[0].weeklyUsage).toEqual([{
    agents:expected ? [{share:expected}] : [],unattributed:.2-expected,
  }]);
});

it('shows only the account owner’s readable conversations and keeps hidden work in the unassigned share', async () => {
  const gate = Promise.withResolvers<void>(), began = Promise.withResolvers<void>();
  const f=fixture({hold:{type:GraphQLString,resolve:async()=>{began.resolve();await gate.promise;return 'ready';}}});
  const end=f.now(), start=new Date(f.clock.now()-60000).toISOString();
  const reset=new Date(f.clock.now()+3.5*86400_000).toISOString();
  // The provider's reset estimate moved by a fraction of a second between polls.
  f.db.insert(accountWeekReadings).values({account:'private-a',window:'week',readAt:start,resetsAt:new Date(Date.parse(reset)-650).toISOString(),usage:0}).run();
  for(const member of ['alice','bob']){
    f.db.insert(conversations).values({id:member,agent:'agent',member,venue:'loom',place:'th:'+member,label:member+' discussion',
      direct:true,startedAt:start,lastAt:end,turnCount:1}).run();
    f.db.insert(jobs).values({id:member,agent:'agent',account:'private-a',member,conversation:member,title:member,state:'done',
      brief:'',model:'m',startedByKind:'member',startedBy:member,houseRepository:'r',houseFile:'f',houseBranch:'b',
      queuedAt:start,claimedAt:start,endedAt:end}).run();
    f.db.insert(jobUsage).values({job:member,source:'report',tokensIn:10,tokensOut:10}).run();
  }
  const query='{modelAccounts {... on RuntimeAccountDetail { weeklyUsage {unattributed agents {title share} conversations {title share href}}}}}';
  const response=await (await f.post('alice',query)).json();
  expect(response).toEqual({data:{modelAccounts:[{weeklyUsage:[{unattributed:.1,agents:[{title:'agent',share:.1}],
    conversations:[{title:'alice discussion',share:.1,href:'/p/comms-preview/thread/alice'}]}]},{}]}});
  expect(await (await f.post('guest',query)).json()).toEqual({data:{modelAccounts:[{},{}]}});
  const ws = await openSocket(f,'alice');
  const first = nextPayload(ws,'week');
  ws.send(JSON.stringify({type:'subscribe',id:'week',payload:{query:
    `subscription { observe(query:${JSON.stringify(query)}) { revision patches { path value } } }`}}));
  expect(JSON.stringify(await first)).toContain('alice discussion');
  const renamed = nextPayload(ws,'week');
  f.data.writes.run(()=>f.db.update(conversations).set({label:'New discussion title'}).where(eq(conversations.id,'alice')).run());
  expect(JSON.stringify(await renamed)).toContain('New discussion title');
  const pending = f.post('alice',query.replace('{modelAccounts','{hold modelAccounts'));
  await began.promise;
  await new Promise(resolve=>setImmediate(resolve));
  f.db.update(conversations).set({member:'bob'}).where(eq(conversations.id,'alice')).run();
  gate.resolve();
  const revoked = await pending;
  expect(revoked.status).toBe(401);
  expect(await revoked.text()).not.toContain('New discussion title');
});

it('rechecks a retry on another account when it supplied the trigger for a buffered report',async()=>{
  const gate=deferred(), began=deferred();
  const f=fixture({hold:{type:GraphQLString,resolve:async()=>{began.resolve();await gate.promise;return 'ready';}}});
  const end=f.now(), start=new Date(f.clock.now()-60000).toISOString();
  const resetsAt=new Date(f.clock.now()+3.5*86400_000).toISOString();
  f.db.insert(accountWeekReadings).values({account:'private-a',window:'week',readAt:start,resetsAt,usage:0}).run();
  f.db.insert(conversations).values({id:'room',agent:'agent',member:'alice',venue:'loom',place:'th:test',label:'Test',
    startedAt:start,lastAt:end,turnCount:1}).run();
  const attempt={agent:'agent',member:'alice',conversation:'room',title:'Run',state:'done' as const,brief:'',model:'m',
    startedByKind:'member',startedBy:'alice',houseRepository:'r',houseFile:'f',houseBranch:'b',claimedAt:start,endedAt:end};
  f.db.insert(jobs).values({id:'original',account:'private-a',queuedAt:start,...attempt}).run();
  f.db.insert(jobs).values({id:'retry',account:'private-b',queuedAt:end,retryOf:'original',...attempt}).run();
  f.db.insert(jobUsage).values({job:'original',source:'report',tokensIn:10,tokensOut:10}).run();
  f.db.insert(triggers).values({id:'timer',ownerKind:'member',owner:'alice',sourceKind:'time',lifespan:'until-stopped',
    targetKind:'inbox',toKind:'agent',to:'agent',note:'Private association',enabled:true,state:'standing',createdAt:start,changedAt:start}).run();
  f.db.insert(inbox).values({id:'mail',source:'trigger',sourceId:'timer:1',toKind:'agent',to:'agent',fromKind:'schedule',
    conversation:'room',seq:1,job:'retry',at:end,changedAt:end,state:'done'}).run();
  f.db.insert(inboxRefs).values({item:'mail',ref:'timer'}).run();
  const selection='modelAccounts {... on RuntimeAccountDetail { weeklyUsage {triggers {title share}}}}';
  expect(JSON.stringify(await (await f.post('alice','{'+selection+'}')).json())).toContain('Private association');
  const buffered=f.post('alice','{hold '+selection+'}');
  await began.promise;
  await new Promise(resolve=>setImmediate(resolve));
  f.db.update(jobs).set({member:'bob'}).where(eq(jobs.id,'retry')).run();
  gate.resolve();
  const response=await buffered;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('Private association');
});
