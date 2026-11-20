import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { WebSocket } from 'ws';
import { GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, tokens, sessions, projects, projectRepositories, agents, jobs, projectMembers } from './core/data/schema.js';
import { changeReviewStore } from './apps/change-reviews.js';
import { sharedRoot } from './shared-root.js';
import type { PullRequestReader } from './apps/changes.js';
import type { Change } from './pieces/changes/model.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'a'.repeat(64), cookie = 'b'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(read: PullRequestReader, fields?: Parameters<typeof sharedRoot>[0]['fields'], configured = true) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(token), label: 'Sam', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(sessions).values({ id: hash(cookie), token: hash(token), device: 'Browser', via: 'token', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(projectRepositories).values({ project: 'pond', repository: 'house/pond' }).run();
  const errors: unknown[] = [];
  const root = sharedRoot({ db, clock, originAllowed: () => true, changes: configured ? { read, rule: () => undefined } : undefined, fields, reportError: error => errors.push(error) });
  cleanup.push(() => root.close());
  const row: Change = { id: 'github:house/pond#1', repo: 'github:house/pond', number: 1, page: '', title: 'Pump', body: '', url: 'https://github.com/house/pond/pull/1', state: 'open', draft: false, author: { login: 'sam' }, created: at, updated: at, closed: null, head: { ref: 'pump', id: 'a'.repeat(40) }, base: { ref: 'next' }, checks: { state: 'passing', failing: [], running: [], total: 1 }, review: { state: 'approved', by: [] }, mergeable: 'yes', conflicts: false, people: [] };
  return { root, clock, client, db, row, errors };
}

it('publishes scheduled Changes source commits and failures through the actual shared socket and HTTP query', async () => {
  let rows: Change[] = [], failed = false, reads = 0;
  const f = fixture(async repository => { expect(repository).toBe('house/pond'); reads++; if (failed) throw new Error('upstream'); return rows; });
  rows = [f.row];
  const http = createServer(getRequestListener(request => f.root.http.fetch(request)));
  const detach = f.root.attach(http);
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
  cleanup.push(async () => { detach(); await f.root.close(); await new Promise<void>(ok => http.close(() => ok())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { cookie: 'loom_ui=' + cookie, origin: 'http://loom' } });
  cleanup.push(() => ws.terminate());
  await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'changes', payload: { query: 'subscription { observe(query:"{ changes { id title } changeSync { failed } }") { revision patches { path value removed } } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({ changes: [], changeSync: [] });
  next = once(ws, 'message'); f.clock.advance(0); await f.root.refreshChanges!();
  expect(reads).toBe(1);
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toContainEqual({ path: ['changes', 0], value: { id: f.row.id, title: 'Pump' }, removed: false });
  failed = true; next = once(ws, 'message');
  await expect(f.root.refreshChanges!()).rejects.toThrow('GitHub read unavailable');
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toContainEqual({ path: ['changeSync', 0, 'failed'], value: true, removed: false });
  const response = await f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui=' + cookie }, body: JSON.stringify({ query: '{ changes { id title } changeSync { failed } }' }) });
  expect(await response.json()).toEqual({ data: { changes: [{ id: f.row.id, title: 'Pump' }], changeSync: [{ failed: true }] } });
  expect(f.errors).toEqual([]);
});

it('drains a configured Changes read before root close completes and never rearms it', async () => {
  let finish!: (rows: Change[]) => void, reads = 0;
  const f = fixture(async () => { reads++; return new Promise(resolve => { finish = resolve; }); });
  const pending = f.root.refreshChanges!();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  let closed = false;
  const closing = f.root.close().then(() => { closed = true; });
  await new Promise<void>(resolve => queueMicrotask(resolve));
  expect(closed).toBe(false);
  finish([f.row]); await pending; await closing;
  expect(f.root.services.changes.list()).toHaveLength(1);
  f.clock.advance(120_000); expect(reads).toBe(1);
  expect(f.client.open).toBe(true);
  expect(f.errors).toEqual([]);
});

it('fences late GraphQL callbacks immediately while an unrelated source read still drains', async () => {
  let finishSource!: (rows: Change[]) => void, releaseRead!: () => void, began!: () => void, late = 0;
  const started = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<void>(resolve => { releaseRead = resolve; });
  const f = fixture(async () => new Promise(resolve => { finishSource = resolve; }), {
    delayed: { type: new GraphQLObjectType({ name: 'ChangesShutdownChild', fields: {
      word: { type: GraphQLString, resolve() { late++; f.client.prepare('select 1').get(); return 'PRIVATE-FINAL'; } },
    } }), async resolve() { began(); await held; return {}; } },
  });
  const source = f.root.refreshChanges!();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  const pending = f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui=' + cookie }, body: JSON.stringify({ query: '{ delayed { word } }' }) });
  let closing: Promise<void> | undefined;
  try {
    await started;
    let closed = false;
    closing = f.root.close().then(() => { closed = true; });
    releaseRead(); const response = await pending;
    expect(await response.text()).not.toContain('PRIVATE-FINAL');
    expect(late).toBe(0); expect(closed).toBe(false);
  } finally {
    releaseRead(); finishSource([]); await source; await closing;
  }
  expect(f.errors).toEqual([]);
});

it('commits a source failure during shutdown without waking a stopped real subscriber', async () => {
  let rejectSource!: (error: Error) => void, reads = 0, probes = 0;
  const f = fixture(async () => { reads++; return new Promise((_resolve, reject) => { rejectSource = reject; }); }, {
    probe: { type: GraphQLString, resolve() { probes++; f.client.prepare('select 1').get(); return 'ready'; } },
  });
  const http = createServer(getRequestListener(request => f.root.http.fetch(request)));
  const detach = f.root.attach(http);
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
  cleanup.push(async () => { detach(); await f.root.close(); await new Promise<void>(ok => http.close(() => ok())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { cookie: 'loom_ui=' + cookie, origin: 'http://loom' } });
  cleanup.push(() => ws.terminate());
  await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'probe', payload: { query: 'subscription { observe(query:"{ probe }") { revision patches { path value removed } } }' } }));
  await next; expect(probes).toBe(1);
  const pending = f.root.refreshChanges!(); void pending.catch(() => {});
  await new Promise<void>(resolve => queueMicrotask(resolve));
  const closing = f.root.close(); expect(f.root.close()).toBe(closing);
  try {
    await expect.poll(() => ws.readyState).toBe(WebSocket.CLOSED);
    rejectSource(new Error('upstream'));
    await expect(pending).rejects.toThrow('GitHub read unavailable');
    await closing;
    expect(f.root.services.changes.syncStatus()?.failed).toBe(true);
    expect(probes).toBe(1); expect(f.errors).toEqual([]);
    f.clock.advance(120_000); expect(reads).toBe(1);
  } finally { rejectSource(new Error('cleanup')); await pending.catch(() => {}); await closing; }
});


it('owner Refresh coalesces source reads and returns no cached household facts; failures preserve the copy', async () => {
  let resolve!: (rows:Change[])=>void, began!:()=>void, reads=0, fail=false;
  const started=new Promise<void>(done=>{began=done;});
  const f=fixture(async()=>{reads++;if(fail)throw new Error('private upstream detail');began();return new Promise(done=>{resolve=done;});});
  const post=(input:unknown={}, authenticated=true)=>f.root.http.request('http://loom/api/changes/refresh',{method:'POST',headers:{'content-type':'application/json',...(authenticated?{cookie:'loom_ui='+cookie}:{})},body:JSON.stringify({input})});
  expect((await post({},false)).status).toBe(401);
  expect((await post({actor:'sam'})).status).toBe(400);
  expect(reads).toBe(0);
  const a=post(), b=post();await started;
  resolve([f.row]);
  for(const response of await Promise.all([a,b])) {expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,value:{refreshed:true}});}
  expect(reads).toBe(1);expect(f.root.services.changes.list()).toHaveLength(1);
  fail=true;const failure=await post();expect(failure.status).toBe(503);expect(JSON.stringify(await failure.json())).not.toContain('private upstream');
  expect(f.root.services.changes.list()).toHaveLength(1);expect(f.root.services.changes.syncStatus()?.failed).toBe(true);
  f.db.update(members).set({role:'member'}).where(eq(members.id,'sam')).run();
  expect((await post()).status).toBe(403);expect(reads).toBe(2);
});

it('rechecks owner and session after a configured source read before acknowledging Refresh', async () => {
  let finish!: (rows:Change[])=>void, began!:()=>void;
  let started=new Promise<void>(done=>{began=done;});
  const f=fixture(async()=>{began();return new Promise(done=>{finish=done;});});
  const post=()=>f.root.http.request('http://loom/api/changes/refresh',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+cookie},body:JSON.stringify({input:{}})});
  const a=post();await started;
  f.db.update(members).set({role:'member'}).where(eq(members.id,'sam')).run();finish([f.row]);expect((await a).status).toBe(403);
  f.db.update(members).set({role:'owner'}).where(eq(members.id,'sam')).run();
  started=new Promise<void>(done=>{began=done;});const b=post();await started;
  f.db.delete(sessions).run();finish([f.row]);expect((await b).status).toBe(403);
});

it('exposes Refresh capability only for a configured root and current owner through actual GraphQL',async()=>{
  for(const configured of [false,true]){
    const f=fixture(async()=>[],undefined,configured);
    const query=()=>f.root.http.request('http://loom/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+cookie},body:JSON.stringify({query:'{ workAnswerOwner workChangesRefresh }'})});
    expect(await (await query()).json()).toEqual({data:{workAnswerOwner:true,workChangesRefresh:configured}});
    f.db.update(members).set({role:'member'}).where(eq(members.id,'sam')).run();
    expect(await (await query()).json()).toEqual({data:{workAnswerOwner:false,workChangesRefresh:false}});
    if(!configured)expect((await f.root.http.request('http://loom/api/changes/refresh',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+cookie},body:JSON.stringify({input:{}})})).status).toBe(404);
  }
});

it('requires access to the change and the job for each review returned by the HTTP door', async () => {
  const f = fixture(async () => []);
  const at = f.row.created;
  f.db.insert(members).values({ id: 'pat', role: 'member', joinedAt: at }).run();
  f.db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  f.root.services.changes.put(f.row);
  const store = changeReviewStore(f.db, () => at);
  for (const member of ['pat', 'sam']) {
    const job = 'review-' + member;
    f.db.insert(jobs).values({ id: job, member, agent: 'art', title: 'Review', state: 'queued',
      brief: '', model: 'reviewer', startedByKind: 'agent', startedBy: 'art', houseRepository: 'house/pond',
      houseFile: '', houseBranch: 'next', queuedAt: at }).run();
    const identity = { job, change: f.row.id, headCommit: f.row.head.id };
    store.assign({ ...identity, tier: 'high', round: 1 });
    store.finish({ ...identity, verdict: 'CLEAR', findings: 'Review for ' + member });
  }
  const read = async () => {
    const response = await f.root.http.request('http://loom/graphql', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'loom_ui=' + cookie },
      body: JSON.stringify({ query: 'query($change:String!) { changeReviewHistory(change:$change) { job findings } }', variables: { change: f.row.id } }) });
    return response.json();
  };
  const visible = { data: { changeReviewHistory: [{ job: 'review-sam', findings: 'Review for sam' }] } };
  expect(await read()).toEqual(visible);
  f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'sam')).run();
  expect(await read()).toEqual({ data: { changeReviewHistory: [] } });
  f.db.insert(projectMembers).values({ member: 'sam', project: 'pond' }).run();
  expect(await read()).toEqual(visible);
});
