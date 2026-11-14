import { afterEach, expect, it } from 'vitest';
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
