import { guardedResponse, responseAvailability } from './guarded-response.js';
import { afterEach, expect, it } from 'vitest';
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLNonNull, GraphQLScalarType } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { createDataSchema } from './database.js';
import { dataHttp } from './http.js';
import { members, agents, memberAgents, projects, projectMembers, tasks, taskComments, taskLinks } from './schema.js';
const clients: Database.Database[] = [];
const at = '2026-11-14T00:00:00.000Z';
afterEach(() => clients.splice(0).forEach(client => client.close()));
function fixture() {
  const statements: string[] = [];
  const client = new Database(':memory:', { verbose: s => statements.push(s) }); clients.push(client);
  const db = createDataSchema(client);
  db.insert(members).values(['sam', 'other', 'owner'].map(id => ({ id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: at }))).run();
  db.insert(agents).values({ id: 'bot', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'sam', agent: 'bot' }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  for (const [id, ownerKind, owner, project] of [
    ['project', 'agent', 'bot', 'pond'], ['agent', 'agent', 'bot', null],
    ['mine', 'member', 'sam', null], ['private', 'member', 'other', null], ['house', 'household', null, null],
  ] as const) {
    db.insert(tasks).values({ id, title: id, ownerKind, owner, project, createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
    db.insert(taskComments).values({ task: id, seq: 1, actorKind: 'member', actor: 'sam', text: id, at }).run();
  }
  db.insert(taskLinks).values({ task: 'agent', dependsOn: 'private', type: 'blocks' }).run();
  let valid = true;
  const app = dataHttp(db, req => req.headers.get('authorization') === 'Bearer sam' ? { viewer: { kind: 'member', id: 'sam' }, valid: () => valid } : req.headers.get('authorization') === 'Bearer owner' ? { viewer: { kind: 'member', id: 'owner' }, valid: () => valid } : undefined);
  const read = (query: string, token = 'sam') => app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ query }) });
  statements.length = 0;
  return { db, statements, app, read, end: () => { valid = false; } };
}
it('serves authenticated generated fields and connected rows in one SQL with current grants', async () => {
  const { db, statements, read } = fixture();
  const query = '{ tasks(orderBy:{id:{direction:asc,priority:0}}) { id taskCommentsByTask { text } taskLinksByTask { dependsOn } } }';
  let response = await read(query);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ data: { tasks: [
    { id: 'agent', taskCommentsByTask: [{ text: 'agent' }], taskLinksByTask: [] },
    { id: 'mine', taskCommentsByTask: [{ text: 'mine' }], taskLinksByTask: [] },
  ] } });
  expect(statements).toHaveLength(1);
  db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run();
  response = await read('{ tasks(where:{id:{eq:"project"}}) { id } }');
  expect(await response.json()).toEqual({ data: { tasks: [{ id: 'project' }] } });
  db.delete(projectMembers).where(eq(projectMembers.member, 'sam')).run();
  response = await read('{ taskComments(where:{task:{eq:"project"}}) { text taskRow { id } } }');
  expect(await response.json()).toEqual({ data: { taskComments: [] } });
  db.delete(memberAgents).run();
  response = await read('{ tasks(where:{id:{eq:"agent"}}) { id } }');
  expect(await response.json()).toEqual({ data: { tasks: [] } });
});
it('lets household owners see member-private rows and responds to demotion', async () => {
  const { db, read } = fixture();
  const query = '{ tasks(where:{id:{eq:"private"}}) { id } }';
  expect(await (await read(query, 'owner')).json()).toEqual({ data: { tasks: [{ id: 'private' }] } });
  expect(await (await read('{ projects { id } agents { id } }', 'owner')).json()).toEqual({ data: { projects: [{ id: 'pond' }], agents: [{ id: 'bot' }] } });
  db.update(members).set({ role: 'member' }).where(eq(members.id, 'owner')).run();
  expect(await (await read('{ projects { id } agents { id } }', 'owner')).json()).toEqual({ data: { projects: [], agents: [] } });
  expect(await (await read(query, 'owner')).json()).toEqual({ data: { tasks: [] } });
});
it('returns comment counts in the authenticated query and reflects current project grants', async () => {
  const { db, statements, read } = fixture();
  const query = '{ tasks(orderBy:{id:{direction:asc,priority:0}}) { id commentCount } }';
  const first = await (await read(query)).json();
  expect(first).toEqual({ data: { tasks: [{ id: 'agent', commentCount: 1 }, { id: 'mine', commentCount: 1 }] } });
  expect(statements).toHaveLength(1);
  db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run();
  const connected = '{ projects { tasksByProject { id commentCount } } }';
  statements.length = 0;
  expect(await (await read(connected)).json()).toEqual({ data: { projects: [{ tasksByProject: [{ id: 'project', commentCount: 1 }] }] } });
  expect(statements).toHaveLength(1);
  db.delete(projectMembers).run();
  expect(await (await read(connected)).json()).toEqual({ data: { projects: [] } });
});
it('fails closed on missing/ended auth, cross-origin, unsafe content and sensitive fields', async () => {
  const { read, app, end, statements } = fixture();
  expect((await read('{ tasks { id } }', 'nobody')).status).toBe(401);
  expect((await app.request('http://loom/graphql', { method: 'POST', headers: { origin: 'http://evil' } })).status).toBe(403);
  expect((await app.request('http://loom/graphql')).status).toBe(405);
  expect((await app.request('http://loom/graphql', { method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json' } })).status).toBe(406);
  expect((await app.request('http://loom/graphql', { method: 'POST' })).status).toBe(415);
  for (const query of ['{ tokens { fingerprint } }', '{ agents { tokensByAgent { fingerprint } } }', 'mutation { deleteFromTasks { id } }']) {
    const body = await (await read(query)).json();
    expect(body.errors).toBeDefined();
  }
  expect(statements).toHaveLength(0);
  end();
  expect((await read('{ tasks { id } }')).status).toBe(401);
});
it('constrains an agent caller to agents in its own projects, with independent SQL aliases', async () => {
  const { db } = fixture();
  const { projectAgents } = await import('./schema.js');
  db.insert(agents).values(['friend', 'stranger'].map(id => ({ id, about: '', markBg: '', markFg: '', faceShape: 'pebble' as const, faceEyes: 'dot' as const }))).run();
  db.insert(projects).values({ id: 'secret', name: 'Secret' }).run();
  db.insert(projectAgents).values([{ project: 'pond', agent: 'bot' }, { project: 'pond', agent: 'friend' }, { project: 'secret', agent: 'stranger' }]).run();
  const app = dataHttp(db, () => ({ viewer: { kind: 'agent', id: 'bot' }, valid: () => true }));
  const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ agents(orderBy:{id:{direction:asc,priority:0}}) { id } }' }) });
  expect(await response.json()).toEqual({ data: { agents: [{ id: 'bot' }, { id: 'friend' }] } });
});
it('rechecks admission after async parsing, before SQL', async () => {
  const { db, statements } = fixture();
  let admitted = false, valid = true;
  const app = dataHttp(db, () => { admitted = true; return { viewer: { kind: 'member', id: 'sam' }, valid: () => valid }; });
  const bytes = new TextEncoder().encode(JSON.stringify({ query: '{ tasks { title } }' }));
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    expect(admitted).toBe(true);
    valid = false; controller.enqueue(bytes); controller.close();
  } });
  const response = await app.fetch(new Request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) }, body, duplex: 'half' } as RequestInit));
  expect(response.status).toBe(401);
  expect(statements).toHaveLength(0);
});
it('withholds buffered rows when authentication ends during SQL execution', async () => {
  const { db, statements } = fixture();
  const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => statements.length === 0 }));
  const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks { title } }' }) });
  expect(statements).toHaveLength(1);
  expect(response.status).toBe(401);
  expect(JSON.stringify(await response.json())).not.toContain('mine');
});
it('rejects otherwise valid outside service and runner callers before SQL', async () => {
  const { db, statements } = fixture();
  for (const kind of ['service', 'runner'] as const) {
    const app = dataHttp(db, () => ({ viewer: { kind, id: 'external' }, valid: () => true }));
    const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks { id } }' }) });
    expect(response.status).toBe(403);
  }
  expect(statements).toHaveLength(0);
});
it('requires both link endpoints and project precedence for member-owned tasks', async () => {
  const { db, read } = fixture();
  db.insert(taskLinks).values([{ task: 'private', dependsOn: 'agent', type: 'blocks' }, { task: 'mine', dependsOn: 'agent', type: 'blocks' }]).run();
  expect(await (await read('{ taskLinks { task dependsOn } }')).json()).toEqual({ data: { taskLinks: [{ task: 'mine', dependsOn: 'agent' }] } });
  db.update(tasks).set({ project: 'pond' }).where(eq(tasks.id, 'mine')).run();
  expect(await (await read('{ tasks(where:{id:{eq:"mine"}}) { id } }')).json()).toEqual({ data: { tasks: [] } });
  const app = dataHttp(db, () => ({ viewer: { kind: 'agent', id: 'bot' }, valid: () => true }));
  expect(await (await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks(where:{id:{eq:"project"}}) { id } }' }) })).json()).toEqual({ data: { tasks: [] } });
});
it('allows owned-agent metadata and agent-self projectless tasks without project grants', async () => {
  const { db, read } = fixture();
  expect(await (await read('{ agents { id } }')).json()).toEqual({ data: { agents: [{ id: 'bot' }] } });
  const app = dataHttp(db, () => ({ viewer: { kind: 'agent', id: 'bot' }, valid: () => true }));
  const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ agents { id } tasks { id } }' }) });
  expect(await response.json()).toEqual({ data: { agents: [{ id: 'bot' }], tasks: [{ id: 'agent' }] } });
});

it('accepts a configured public HTTPS origin behind a same-host HTTP proxy and rejects other origins', async () => {
  const { db } = fixture();
  const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => true }), 'https://loom');
  const read = (origin: string, host = 'loom') => app.request('http://' + host + '/graphql', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks { id } }' }) });
  expect((await read('https://loom')).status).toBe(200);
  expect((await read('https://evil')).status).toBe(403);
  expect((await read('https://loom', 'different')).status).toBe(403);
});

it('member project grants expose unowned agent metadata and removal hides it', async () => {
  const { db, read } = fixture();
  const { projectAgents } = await import('./schema.js');
  db.delete(memberAgents).run();
  db.insert(projectAgents).values({ project: 'pond', agent: 'bot' }).run();
  db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run();
  expect(await (await read('{ agents { id } }')).json()).toEqual({ data: { agents: [{ id: 'bot' }] } });
  db.delete(projectMembers).run();
  expect(await (await read('{ agents { id } }')).json()).toEqual({ data: { agents: [] } });
});

it('uses the root schema factory per request with the authenticated viewer and execution context', async () => {
  const { db } = fixture();
  const seen: Viewer[] = [];
  const app = dataHttp(db, request => ({ viewer: { kind: 'member', id: request.headers.get('authorization') === 'Bearer owner' ? 'owner' : 'sam' }, valid: () => true }), undefined, viewer => {
    seen.push(viewer);
    return new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Root', fields: {
      who: { type: GraphQLString, args: { viewer: { type: GraphQLString } }, resolve: (_source, _args, context) => `${viewer.id}:${context.viewer.id}` },
    } }) });
  });
  for (const id of ['sam', 'owner', 'sam']) {
    const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + id }, body: JSON.stringify({ query: 'query($viewer:String){ who(viewer:$viewer) }', variables: { viewer: 'impostor' } }) });
    expect(await response.json()).toEqual({ data: { who: `${id}:${id}` } });
  }
  expect(seen).toEqual([{ kind: 'member', id: 'sam' }, { kind: 'member', id: 'owner' }, { kind: 'member', id: 'sam' }]);
});

it('never calls the root schema factory for callers refused at the HTTP door', async () => {
  const { db } = fixture();
  let calls = 0;
  const schemaForViewer = () => { calls++; throw new Error('must not reach root'); };
  for (const kind of ['service', 'runner', 'ended', 'missing'] as const) {
    const app = dataHttp(db, () => kind === 'missing' ? undefined : { viewer: { kind: kind === 'ended' ? 'member' : kind, id: 'sam' }, valid: () => kind !== 'ended' }, undefined, schemaForViewer);
    const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ who }' }) });
    expect(response.status).toBe(kind === 'runner' || kind === 'service' ? 403 : 401);
  }
  expect(calls).toBe(0);
});

it('withholds a custom root result when admission ends during its resolver', async () => {
  const { db } = fixture();
  let valid = true;
  const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => valid }), undefined, () => new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Root', fields: {
    words: { type: GraphQLString, resolve: () => { valid = false; return 'private words'; } },
  } }) }));
  const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ words }' }) });
  expect(response.status).toBe(401);
  expect(JSON.stringify(await response.json())).not.toContain('private words');
});


it('combines caller-specific roots and shared fields without restoring default tables', async () => {
  const { db } = fixture();
  const fields = { memoryWho: { type: GraphQLString, resolve: (_source: unknown, _args: unknown, context: { viewer: Viewer }) => context.viewer.id } };
  const authenticate = () => ({ viewer: { kind: 'member' as const, id: 'sam' }, valid: () => true });
  const root = (viewer: Viewer) => new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Work', fields: {
    workWho: { type: GraphQLString, resolve: () => viewer.id },
  } }) });
  const combined = dataHttp(db, authenticate, undefined, root, fields);
  const read = (app: ReturnType<typeof dataHttp>, query: string) => app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  expect(await (await read(combined, '{ workWho memoryWho }')).json()).toEqual({ data: { workWho: 'sam', memoryWho: 'sam' } });
  expect((await (await read(combined, '{ tasks { id } }')).json()).errors).toBeDefined();
  const fieldOnly = dataHttp(db, authenticate, undefined, fields);
  expect(await (await read(fieldOnly, '{ memoryWho tasks { id } }')).json()).toEqual({ data: { memoryWho: 'sam', tasks: [{ id: 'agent' }, { id: 'mine' }] } });
});


it('preserves recursive custom query roots with and without shared fields', async () => {
  const { db } = fixture();
  const root: GraphQLObjectType = new GraphQLObjectType({ name: 'Recursive', fields: () => ({
    who: { type: GraphQLString, resolve: (_source, _args, context) => context.viewer.id },
    self: { type: root, resolve: () => ({}) },
  }) });
  const schema = new GraphQLSchema({ query: root });
  for (const fields of [{}, { shared: { type: GraphQLString, resolve: () => 'memory' } }]) {
    const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => true }), undefined, () => schema, fields);
    const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ who self { who self { who } } }' }) });
    expect(await response.json()).toEqual({ data: { who: 'sam', self: { who: 'sam', self: { who: 'sam' } } } });
  }
});

it.each(['resolve', 'reject'])('drains actual HTTP %s work beyond an aborted Yoga response', async outcome => {
  const { db } = fixture();
  let began!: () => void, release!: () => void, finished!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const readDone = new Promise<void>(resolve => { finished = resolve; });
  const events: string[] = [];
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    slow: { type: GraphQLString, async resolve() { began(); await held; db.select().from(tasks).all(); events.push('read'); finished(); if (outcome === 'reject') throw Error('private failure'); return 'private words'; } },
  } }) });
  const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => true }), undefined, () => schema);
  const abort = new AbortController();
  const pending = app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ slow }' }), signal: abort.signal });
  await started;
  try {
    app.stop(); const closing = app.drain().then(() => { events.push('closed'); }); abort.abort();
    const response = await pending;
    expect(response.status).toBe(503); expect(events).toEqual([]);
    release(); await readDone; await closing;
    expect(events).toEqual(['read', 'closed']);
  } finally { release(); await readDone; }
});

it('drains a sibling resolver after a non-null error has already returned an HTTP result', async () => {
  const { db } = fixture();
  let release!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const readDone = new Promise<void>(resolve => { finished = resolve; });
  const events: string[] = [];
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    slow: { type: GraphQLString, async resolve() { await held; db.select().from(tasks).all(); events.push('read'); finished(); return 'late'; } },
    broken: { type: new GraphQLNonNull(GraphQLString), async resolve() { throw Error('private error'); } },
  } }) });
  const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => true }), undefined, () => schema);
  try {
    const response = await app.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ slow broken }' }) });
    expect((await response.json()).errors).toBeDefined();
    app.stop(); const closing = app.drain().then(() => { events.push('closed'); });
    await Promise.resolve(); expect(events).toEqual([]);
    release(); await readDone; await closing;
    expect(events).toEqual(['read', 'closed']);
  } finally { release(); await readDone; }
});

it('stops new HTTP admission without calling credential or schema callbacks', async () => {
  const { db } = fixture(); let authenticated = 0, schemas = 0;
  const app = dataHttp(db, () => { authenticated++; return { viewer: { kind: 'member', id: 'sam' }, valid: () => true }; }, undefined, () => { schemas++; throw Error('must not run'); });
  app.stop(); await app.drain();
  const response = await app.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks { id } }' }) });
  expect(response.status).toBe(503); expect(authenticated).toBe(0); expect(schemas).toBe(0);
});

it('retains result serialization and fences credential checks when serialization stops HTTP', async () => {
  const { db } = fixture(); let stopped = false, lateValidity = 0;
  const events: string[] = []; let closing: Promise<void> | undefined;
  const secret = new GraphQLScalarType({ name: 'ClosingHttpValue', serialize: () => ({ toJSON() {
    stopped = true; app.stop(); closing = app.drain().then(() => { events.push('closed'); }); events.push('serialized'); return 'private words';
  } }) });
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { secret: { type: secret, resolve: () => 'secret' } } }) });
  const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => { if (stopped) lateValidity++; return true; } }), undefined, () => schema);
  const response = await app.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ secret }' }) });
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('private words');
  await closing; expect(events).toEqual(['serialized', 'closed']); expect(lateValidity).toBe(0);
});

it('does not admit an HTTP subscription source outside the websocket lifetime', async () => {
  const { db } = fixture(); let subscriptions = 0;
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: { value: { type: GraphQLString } } }),
    subscription: new GraphQLObjectType({ name: 'Subscription', fields: { value: { type: GraphQLString, async *subscribe() { subscriptions++; yield { value: 'not HTTP' }; } } } }),
  });
  const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => true }), undefined, () => schema);
  const response = await app.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query: 'subscription { value }' }) });
  expect((await response.json()).errors).toBeDefined(); expect(subscriptions).toBe(0);
  app.stop(); await app.drain();
});

it.each(['authenticate', 'activity'])('fences reentrant HTTP stop from %s before validity or private release', async from => {
  const { db } = fixture(); let stopped = false, lateValidity = 0;
  const app = dataHttp(db, () => {
    if (from === 'authenticate') { stopped = true; app.stop(); }
    return { viewer: { kind: 'member', id: 'sam' }, valid: () => { if (stopped) lateValidity++; return true; }, activity() { stopped = true; app.stop(); } };
  });
  const response = await app.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks { title } }' }) });
  expect(response.status).toBe(503); expect((await response.json()).data).toBeUndefined();
  expect(lateValidity).toBe(0); await app.drain();
});

it.each(['commit','deadline'])('withholds selected data when %s changes during serialization', async kind => {
  const { db }=fixture(); let version=0,now=0;
  const { keepReadUntil }=await import('./read-lease.js');
  const step=new GraphQLScalarType({name:'PublicationStep',serialize:()=>({toJSON(){if(kind==='commit')version++;else now=1;return 'public';}})});
  const app=dataHttp(db,()=>({viewer:{kind:'member',id:'sam'},valid:()=>true}),undefined,{
    private:{type:GraphQLString,resolve:(_row,_args,context)=>{keepReadUntil(context,1);return 'PRIVATE SELECTED';}},
    step:{type:step,resolve:()=>true},
  },{},()=>version,()=>now);
  const response=await app.request('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{private step}'})});
  expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE SELECTED');
});
it.each(['commit','deadline'].flatMap(kind => ['none','direct','wrapped'].map(clone=>({kind,clone}))))('withdraws an unread HTTP response after $kind changes (clone=$clone)', async ({kind,clone}) => {
  const { db }=fixture();let version=0,now=0;
  const { keepReadUntil }=await import('./read-lease.js');
  const app=dataHttp(db,()=>({viewer:{kind:'member',id:'sam'},valid:()=>true}),undefined,{
    private:{type:GraphQLString,resolve:(_row,_args,context)=>{keepReadUntil(context,1);return 'PRIVATE BUFFERED';}},
  },{},()=>version,()=>now);
  const response=await app.request('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{private}'})});
  expect(response.status).toBe(200);response.headers.set('x-fixture','kept');
  const holder=clone==='wrapped'?new Response(response.body,response):response;
  const copy=clone==='none'?holder:holder.clone();
  expect(copy.headers.get('cache-control')).toBe('no-store');expect(copy.headers.get('x-fixture')).toBe('kept');
  await Promise.resolve();if(kind==='commit')version++;else now=1;
  if(clone!=='none') await expect(holder.text()).rejects.toThrow('Data access ended');
  await expect(copy.text()).rejects.toThrow('Data access ended');
});

it('carries the exact private-word deadline from a consumed HTTP response into an outer reply', async () => {
  const {db} = fixture(); let now = 0;
  const {keepReadUntil} = await import('./read-lease.js');
  const app = dataHttp(db, () => ({viewer:{kind:'member',id:'sam'},valid:()=>true}), undefined, {
    words:{type:GraphQLString,resolve:(_s,_a,context)=>{keepReadUntil(context,1);return 'PRIVATE NESTED';}},
  }, {}, undefined, () => now);
  const nested = await app.request('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{words}'})});
  const lease = responseAvailability(nested); expect(lease).toBeDefined(); expect(lease!()).toBe(true);
  const outer = guardedResponse(JSON.stringify({result:await nested.json()}), {}, lease!);
  now = 1;
  expect(lease!()).toBe(false);
  await expect(outer.text()).rejects.toThrow('Data access ended');
  app.stop(); await app.drain();
});
