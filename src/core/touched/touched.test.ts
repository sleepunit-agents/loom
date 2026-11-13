import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer } from '../../server.js';
import { startLoom } from '../../foundation.js';
import { createFoundation } from '../app.js';
import { FakeClock, maySee, type Sharing, type Viewer } from '../index.js';
import { CardTable } from '../../backends/cards.js';
import { PeopleStore } from '../../backends/people.js';
import { ProjectsStore } from '../../backends/projects.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
import { createBackend, closeAllBackends } from '../../backends/index.js';
import { installTouched, listenForTouches, touched, touchSocketPath } from './index.js';
import { identities } from './writes.js';
const dirs: string[] = [], closes: (() => void | Promise<void>)[] = [];
const home = () => { const p = mkdtempSync(join(tmpdir(), 'touch-')); dirs.push(p); return p; };
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); closeAllBackends(); for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
const agent: Viewer = { kind: 'agent', id: 'art' };
const sharing: Sharing = { members: { jonathan: { owner: true, agents: ['art'] }, other: { owner: false, agents: [] } }, projects: {}, services: {} };
function messages(ws: WebSocket) {
  const queue: any[] = [], waits: ((v: any) => void)[] = [];
  ws.on('message', raw => { const v = JSON.parse(raw.toString()); const next = waits.shift(); if (next) next(v); else queue.push(v); });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>(resolve => waits.push(resolve));
}
async function window(url: string, who = 'jonathan') {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers: { authorization: who } });
  const next = messages(ws); await once(ws, 'open'); closes.push(() => ws.terminate()); return { ws, next };
}
it('a real MCP write over stdio reaches two windows, reread with each viewer policy', async () => {
  const dir = home(), store = new PeopleStore({ dbPath: join(dir, 'memories.db') }); closes.push(() => store.close());
  const app = await startLoom({ home: home(), clock: new FakeClock(), authenticate: req => ({ viewer: { kind: 'member', id: req.headers.authorization! }, valid: () => true }), install(app) {
    installTouched(app.operations, (v, c) => v.kind === 'agent' && v.id === 'art' && c.type === 'person' ? c : undefined);
    app.live.register({ name: 'person', ids: () => store.list().map(r => r.slug), inScope: () => true,
      read(id, viewer) { const row = store.getRow(id); return row && row.archived_at === null && maySee(viewer, { agent: 'art' }, sharing) ? { id, ...row.card } : undefined; },
    });
  } }); closes.push(() => app.close());
  closes.push(await listenForTouches(app.operations, { directory: dir, viewer: agent, resolve: c => c.type === 'person' ? c : undefined }));
  expect(statSync(touchSocketPath(dir)).mode & 0o777).toBe(0o600);
  const a = await window(app.url), b = await window(app.url), denied = await window(app.url, 'other');
  for (const w of [a, b, denied]) { w.ws.send(JSON.stringify({ kind: 'subscribe', type: 'person' })); expect(await w.next()).toMatchObject({ kind: 'set', records: [] }); }
  const input = new PassThrough(), output = new PassThrough();
  const { server } = createLoomServer({ contextDir: dir });
  await server.connect(new StdioServerTransport(input, output)); closes.push(() => server.close());
  let responses = ''; output.on('data', chunk => { responses += chunk.toString(); });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'person_write', arguments: { slug: 'jonathan', name: 'Jonathan' } } }) + '\n');
  expect(await a.next()).toMatchObject({ kind: 'put', record: { id: 'jonathan', name: 'Jonathan' } });
  expect(await b.next()).toMatchObject({ kind: 'put', record: { id: 'jonathan', name: 'Jonathan' } });
  // A request/reply barrier proves the hidden viewer did not receive the preceding put.
  denied.ws.send(JSON.stringify({ kind: 'call', request: 'barrier', name: 'missing', input: {} }));
  expect(await denied.next()).toMatchObject({ kind: 'pending', request: 'barrier' });
  expect(await denied.next()).toMatchObject({ kind: 'result', request: 'barrier' });
  expect(responses).toContain('Jonathan');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'person_archive', arguments: { slug: 'jonathan', reason: 'test' } } }) + '\n');
  expect(await b.next()).toMatchObject({ kind: 'del', id: 'jonathan' });
});
it('outside-writer types all notify only identities after success, and the operation rejects other doors/callers', async () => {
  const dir = home(), app = createFoundation({ home: home(), clock: new FakeClock() }); closes.push(() => app.close());
  const seen: string[] = [];
  installTouched(app.operations, (v, c) => { if (v.kind !== 'agent' || v.id !== 'art') return; seen.push(c.type + ':' + c.id); return c; });
  closes.push(await listenForTouches(app.operations, { directory: dir, viewer: agent, resolve: c => c }));
  const knowledge = new SqliteKnowledgeBackend({ dbPath: join(dir, 'knowledge.db') }); closes.push(() => knowledge.close());
  await knowledge.writePage({ slug: 'fact', title: 'Fact', domain: 'test', body: 'one' });
  await knowledge.addCitations('fact', [{ claim: 'one', source_kind: 'web', source_locator: 'https://example.com', excerpt: 'one' }]);
  const projects = new ProjectsStore({ dbPath: join(dir, 'memories.db') }); closes.push(() => projects.close());
  projects.write({ slug: 'loom', name: 'Loom' });
  const memory = createBackend(dir); const ref = await memory.remember({ category: 'project', title: 'Loom', content: 'a memory' });
  // A live put is the condition, with no sleeps or child processes.
  await vi.waitFor(() => { expect(seen).toContain('knowledge:fact'); expect(seen).toContain('project:loom'); expect(seen).toContain('memory:' + ref.ref); });
  expect(app.operations.call('http', agent, 'core.touched', { type: 'memory', id: ref.ref })).toMatchObject({ code: 'denied' });
  expect(app.operations.call('direct', { kind: 'agent', id: 'mark' }, 'core.touched', { type: 'memory', id: ref.ref })).toMatchObject({ code: 'denied' });
});
it('absent daemon costs no connection, timers or retry and preserves offline writes', async () => {
  const dir = home();
  const before = process.getActiveResourcesInfo();
  touched(dir, 'memory', 'ref');
  expect(process.getActiveResourcesInfo()).toEqual(before);
  const memory = createBackend(dir);
  await expect(memory.remember({ category: 'project', title: 'Offline', content: 'stored without daemon' })).resolves.toHaveProperty('ref');
});
it('extracts only declared identities, excluding bodies, metadata and dry-run results', () => {
  expect(identities({ slug: 'right', body: 'secret', metadata: { slug: 'wrong' }, pages: [{ slug: 'new', old_slug: 'old' }] }, new Set(['slug', 'old_slug']))).toEqual(['right', 'new', 'old']);
});

it('card commit hooks emit actual written slugs only after commit, and discard a rollback', () => {
  const store = new PeopleStore({ dbPath: join(home(), 'memories.db') }); closes.push(() => store.close());
  store.write({ slug: 'jonathan', name: 'Jonathan' });
  const committed = vi.fn();
  const table = new CardTable(store.database, { table: 'people', revisions: 'person_revisions', noun: store.cardTable.noun }, null, committed);
  const row = store.rawRow('jonathan')!;
  expect(() => store.database.transaction(() => store.write({ slug: 'jonathan', name: 'Unsafe' }))()).toThrow('must own the outer transaction');
  expect(store.rawRow('jonathan')?.name).toBe('Jonathan');
  expect(() => table.mutate(() => { table.store({ ...row, name: 'Wrong' }); throw new Error('rollback'); })).toThrow('rollback');
  expect(committed).not.toHaveBeenCalled();
  expect(store.rawRow('jonathan')?.name).toBe('Jonathan');
  table.mutate(() => { table.store({ ...row, name: 'Right' }); expect(committed).not.toHaveBeenCalled(); });
  expect(committed).toHaveBeenCalledExactlyOnceWith('jonathan');
});
