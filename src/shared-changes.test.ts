import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { WebSocket } from 'ws';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, tokens, sessions, projects, projectRepositories } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import type { PullRequestReader } from './apps/changes.js';
import type { Change } from './pieces/changes/model.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'a'.repeat(64), cookie = 'b'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(read: PullRequestReader) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(token), label: 'Sam', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(sessions).values({ id: hash(cookie), token: hash(token), device: 'Browser', via: 'token', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(projectRepositories).values({ project: 'pond', repository: 'house/pond' }).run();
  const errors: unknown[] = [];
  const root = sharedRoot({ db, clock, originAllowed: () => true, changes: { read, rule: () => undefined }, reportError: error => errors.push(error) });
  cleanup.push(() => root.close());
  const row: Change = { id: 'github:house/pond#1', repo: 'github:house/pond', number: 1, page: '', title: 'Pump', body: '', url: 'https://github.com/house/pond/pull/1', state: 'open', draft: false, author: { login: 'sam' }, created: at, updated: at, closed: null, head: { ref: 'pump', id: 'a'.repeat(40) }, base: { ref: 'next' }, checks: { state: 'passing', failing: [], running: [], total: 1 }, review: { state: 'approved', by: [] }, mergeable: 'yes', conflicts: false, people: [] };
  return { root, clock, client, row, errors };
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

it('drains a configured Changes read before closing the data owner and never rearms it', async () => {
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
