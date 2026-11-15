import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { WebSocket } from 'ws';
import { GraphQLString } from 'graphql/index.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, boxes, jobs, sessions, tokens, tasks, projects } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
const raw = { member: 'a'.repeat(64), runner: 'b'.repeat(64), body: 'c'.repeat(64), agent: 'd'.repeat(64), cookie: 'e'.repeat(64), bodyCookie: 'f'.repeat(64), runnerCookie: '1'.repeat(64) };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const request = (headers: Record<string,string>) => new Request('http://loom', { headers });
function fixture(prepare?: () => Promise<unknown>) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values(['box-1','box-2'].map(id => ({ id, name: id, owner: 'sam', sameMachineAsLoom: false, hostsAny: false, reportOnly: false, alwaysOn: false, enrolledAt: at }))).run();
  db.insert(jobs).values(['job-1','job-2'].map(id => ({ id, agent: 'art', box: 'box-1', title: id, state: 'running' as const, brief: '', model: 'fixture', startedByKind: 'agent', startedBy: 'art', houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', queuedAt: at }))).run();
  db.insert(tokens).values([
    { fingerprint: hash(raw.member), label: 'Sam', kind: 'owner', member: 'sam', createdAt: at },
    { fingerprint: hash(raw.runner), label: 'Worker', kind: 'runner', box: 'box-1', createdAt: at },
    { fingerprint: hash(raw.body), label: 'Body', kind: 'agent', agent: 'art', job: 'job-1', createdAt: at },
    { fingerprint: hash(raw.agent), label: 'Art', kind: 'agent', agent: 'art', createdAt: at },
  ]).run();
  db.insert(sessions).values([{ id: hash(raw.cookie), token: hash(raw.member), device: 'Browser', via: 'link', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }, { id: hash(raw.bodyCookie), token: hash(raw.body), device: 'Browser', via: 'link', isAgent: true, issuedAt: at, seenAt: at, provedAt: at }, { id: hash(raw.runnerCookie), token: hash(raw.runner), device: 'Browser', via: 'link', isAgent: true, issuedAt: at, seenAt: at, provedAt: at }]).run();
  let root!: ReturnType<typeof sharedRoot>;
  root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {}, fields: {
    currentBody: { type: GraphQLString, resolve: (_row, _args, context) => root.credentials.body(context.viewer)?.job ?? null },
  } }); cleanup.push(() => root.close());
  root.operations.register({ name: 'worker.report', write: true, recheckPolicy: true,
    input: z.object({ box: z.string() }).strict(), output: z.object({ ack: z.literal(true) }),
    may: (viewer, input) => root.credentials.runner(viewer)?.box === input.box,
    run(ctx, input) { db.update(boxes).set({ lastSeenAt: new Date(ctx.now).toISOString() }).where(eq(boxes.id, input.box)).run(); ctx.changed('box', input.box); return { ack: true }; },
  });
  root.operations.register({ name: 'private.control', write: true, recheckPolicy: true,
    input: z.object({ job: z.string() }).strict(), output: z.object({ ack: z.literal(true) }),
    requiresWindow: (input, viewer) => root.credentials.body(viewer)?.job !== input.job,
    may: (viewer, input) => root.credentials.body(viewer)?.job === input.job, prepare,
    run(ctx) { if (ctx.viewer.kind !== 'agent') throw new Error('Body required'); const task = root.services.tasks.create({ title: 'Body control', goal: 'Ack', why: 'Fixture', owner: { kind: 'agent', id: 'art' } }, ctx.viewer); ctx.changed('task', task.id); return { ack: true }; },
  });
  const call = (name: 'worker/report' | 'private/control', input: unknown, credential = raw.body, id = 'control', headers: Record<string,string> = {}) => root.http.request('http://loom/api/'+name, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credential, ...headers }, body: JSON.stringify({ input, id }),
  });
  const read = (credential = raw.body) => root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credential }, body: JSON.stringify({ query: '{ currentBody }' }) });
  return { db, client, clock, root, call, read };
}
it('binds runner, body and browser scopes to the exact authenticated viewer, never an equal label or another credential', async () => {
  const f = fixture();
  const body = f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.body }))!;
  expect(f.root.credentials.body(body.viewer)).toEqual({ job: 'job-1', agent: 'art', box: 'box-1' });
  expect(Object.isFrozen(f.root.credentials.body(body.viewer))).toBe(true);
  expect(f.root.credentials.body({ ...body.viewer })).toBeUndefined();
  expect(f.root.credentials.runner(body.viewer)).toBeUndefined();
  const runner = f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.runner }))!;
  expect(f.root.credentials.runner(runner.viewer)).toEqual({ box: 'box-1' });
  expect(Object.isFrozen(f.root.credentials.runner(runner.viewer))).toBe(true);
  expect(f.root.credentials.body(runner.viewer)).toBeUndefined();
  const browser = f.root.credentials.authenticate(request({ cookie: 'loom_ui='+raw.cookie }))!;
  expect(f.root.credentials.browser(browser.viewer)).toEqual({ session: hash(raw.cookie) });
  expect(Object.isFrozen(f.root.credentials.browser(browser.viewer))).toBe(true);
  const bearer = f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.member, cookie: 'loom_ui='+raw.cookie }))!;
  expect(f.root.credentials.browser(bearer.viewer)).toBeUndefined();
  const cookieRunner = f.root.credentials.authenticate(request({ cookie: 'loom_ui='+raw.runnerCookie }))!;
  expect(cookieRunner.viewer).toEqual({ kind: 'runner', id: 'box-1' });
  expect(f.root.credentials.runner(cookieRunner.viewer)).toBeUndefined();
  expect((await f.root.http.request('http://loom/api/worker/report', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui='+raw.runnerCookie }, body: JSON.stringify({ input: { box: 'box-1' }, id: 'cookie-worker' }) })).status).toBe(403);
  const agent = f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.agent }))!;
  expect(f.root.credentials.body(agent.viewer)).toBeUndefined();
  const cookieBody = f.root.credentials.authenticate(request({ cookie: 'loom_ui='+raw.bodyCookie }))!;
  expect(f.root.credentials.body(cookieBody.viewer)).toBeUndefined();
  expect(f.root.credentials.authenticate(request({ authorization: 'Bearer '+hash(raw.body) }))).toBeUndefined();
  expect(await (await f.read()).json()).toEqual({ data: { currentBody: 'job-1' } });
});
it('admits only the credential box/job on actual HTTP and rejects input-selected scope before a receipt', async () => {
  const f = fixture();
  expect((await f.call('worker/report', { box: 'box-2' }, raw.runner)).status).toBe(403);
  expect((await f.call('worker/report', { box: 'box-1' }, raw.member)).status).toBe(403);
  expect((await f.call('private/control', { job: 'job-2' })).status).toBe(403);
  expect((await f.call('private/control', { job: 'job-1' }, raw.agent)).status).toBe(403);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  expect((await f.call('worker/report', { box: 'box-1' }, raw.runner)).status).toBe(200);
  expect(await (await f.call('private/control', { job: 'job-1' })).json()).toEqual({ ok: true, value: { ack: true } });
  expect(f.db.select().from(tasks).all()).toHaveLength(1);
  f.root.writes.run(() => f.db.update(boxes).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(boxes.id, 'box-1')).run());
  expect((await f.call('worker/report', { box: 'box-1' }, raw.runner)).status).toBe(401);
  expect((await f.call('private/control', { job: 'job-1' })).status).toBe(401);
  expect((await f.read()).status).toBe(401);
});
it.each(['retarget-token','reassign-job','retarget-conversation','retarget-member','retarget-project','end-job','revoke-box','revoke-token','expiry'] as const)('withdraws a prepared body request after %s without effects or receipt', async change => {
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => { began(); return held; });
  const auth = f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.body }))!;
  const pending = f.call('private/control', { job: 'job-1' }); await started;
  f.root.writes.run(() => {
    if (change === 'retarget-token') f.db.update(tokens).set({ job: 'job-2' }).where(eq(tokens.fingerprint, hash(raw.body))).run();
    if (change === 'reassign-job') f.db.update(jobs).set({ box: 'box-2' }).where(eq(jobs.id, 'job-1')).run();
    if (change === 'retarget-conversation') { const cv = f.root.services.conversations.open({ agent: 'art', member: 'sam', venue: 'loom', place: 'private', label: 'Private' }); f.db.update(jobs).set({ conversation: cv.id }).where(eq(jobs.id, 'job-1')).run(); }
    if (change === 'retarget-member') f.db.update(jobs).set({ member: 'sam' }).where(eq(jobs.id, 'job-1')).run();
    if (change === 'retarget-project') { f.db.insert(projects).values({ id: 'pond', name: 'Pond' }).run(); f.db.update(jobs).set({ project: 'pond' }).where(eq(jobs.id, 'job-1')).run(); }
    if (change === 'end-job') f.db.update(jobs).set({ state: 'done' }).where(eq(jobs.id, 'job-1')).run();
    if (change === 'revoke-box') f.db.update(boxes).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(boxes.id, 'box-1')).run();
    if (change === 'revoke-token') f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(tokens.fingerprint, hash(raw.body))).run();
    if (change === 'expiry') f.db.update(tokens).set({ expiresAt: new Date(f.clock.now()).toISOString() }).where(eq(tokens.fingerprint, hash(raw.body))).run();
  });
  release(); expect((await pending).status).toBe(403);
  expect(auth.valid()).toBe(false); expect(f.root.credentials.body(auth.viewer)).toBeUndefined();
  expect(f.db.select().from(tasks).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});
it('uses the same exact body binding on a real socket and closes it on job withdrawal', async () => {
  const f = fixture(), server = createServer(getRequestListener(request => f.root.http.fetch(request))), detach = f.root.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { detach(); await f.root.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const ws = new WebSocket('ws://127.0.0.1:'+address.port+'/graphql', 'graphql-transport-ws', { headers: { authorization: 'Bearer '+raw.body } });
  cleanup.push(() => ws.terminate()); await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'body', payload: { query: 'subscription { observe(query:"{ currentBody }") { patches { path value } } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({ currentBody: 'job-1' });
  const ended = once(ws, 'close'); f.root.writes.run(() => f.db.update(jobs).set({ state: 'done' }).where(eq(jobs.id, 'job-1')).run());
  expect((await ended)[0]).toBe(4403); expect((await f.read()).status).toBe(401);
});
it('fences retained credential proof and new authentication before any SQL after close', async () => {
  const f = fixture();
  const body = f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.body }))!;
  const browser = f.root.credentials.authenticate(request({ cookie: 'loom_ui='+raw.cookie }))!;
  const runner = f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.runner }))!;
  await f.root.close();
  const sql = vi.spyOn(f.client, 'prepare');
  expect(body.valid()).toBe(false); expect(f.root.credentials.body(body.viewer)).toBeUndefined();
  expect(f.root.credentials.runner(runner.viewer)).toBeUndefined(); expect(f.root.credentials.browser(browser.viewer)).toBeUndefined();
  expect(f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.body }))).toBeUndefined();
  expect(sql).not.toHaveBeenCalled();
});
it.each([['starting','running'], ['running','waiting'], ['waiting','running']] as const)('keeps the same scoped request admitted across normal %s to %s state changes', async (before, after) => {
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => { began(); return held; });
  f.db.update(jobs).set({ state: before }).where(eq(jobs.id, 'job-1')).run();
  const pending = f.call('private/control', { job: 'job-1' }); await started;
  f.root.writes.run(() => f.db.update(jobs).set({ state: after }).where(eq(jobs.id, 'job-1')).run());
  release(); expect((await pending).status).toBe(200);
  expect(f.db.select().from(tasks).all()).toHaveLength(1);
});
it.each(['queued','unassigned','wrong-agent'] as const)('refuses initial body authentication for a %s job', async invalid => {
  const f = fixture();
  if (invalid === 'queued') f.db.update(jobs).set({ state: 'queued' }).where(eq(jobs.id, 'job-1')).run();
  if (invalid === 'unassigned') f.db.update(jobs).set({ box: null }).where(eq(jobs.id, 'job-1')).run();
  if (invalid === 'wrong-agent') {
    f.db.insert(agents).values({ id: 'mark', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
    f.db.update(jobs).set({ agent: 'mark' }).where(eq(jobs.id, 'job-1')).run();
  }
  expect(f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.body }))).toBeUndefined();
  expect((await f.call('private/control', { job: 'job-1' })).status).toBe(401);
  expect((await f.read()).status).toBe(401);
  expect(f.db.select().from(tasks).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});

it('reads binding metadata without selecting or retaining job payload columns', () => {
  const f = fixture();
  f.db.update(jobs).set({ brief: 'Private fixture words', logTail: 'Private fixture transcript' }).where(eq(jobs.id, 'job-1')).run();
  const sql = vi.spyOn(f.client, 'prepare');
  const auth = f.root.credentials.authenticate(request({ authorization: 'Bearer '+raw.body }))!;
  expect(f.root.credentials.body(auth.viewer)).toEqual({ job: 'job-1', agent: 'art', box: 'box-1' });
  const reads = sql.mock.calls.map(([statement]) => String(statement)).filter(statement => /from "jobs"/i.test(statement));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.join(' ')).not.toMatch(/brief|log_tail|title|model|harness|account|select\s+\*/i);
});
