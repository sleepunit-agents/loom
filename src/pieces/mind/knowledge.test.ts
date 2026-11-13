import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { installTouched } from '../../core/touched/index.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
import { installMindKnowledge } from './index.js';
import { mindRole } from './role.js';
const homes: string[] = [], closes: (() => void | Promise<void>)[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), 'mind-knowledge-')); homes.push(h); return h; };
afterEach(async () => { for (const c of closes.splice(0).reverse()) await c(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const sharing: Sharing = { members: { owner: { owner: true, agents: ['art'] }, partial: { owner: false, agents: ['art'] } }, projects: {}, services: {} };
const owner: Viewer = { kind: 'member', id: 'owner' };
function inbox(ws: WebSocket) {
  const queue: any[] = [], waiting: ((v: any) => void)[] = [];
  ws.on('message', b => { const value = JSON.parse(b.toString()); const next = waiting.shift(); if (next) next(value); else queue.push(value); });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>(r => waiting.push(r));
}
async function fixture(path: string) {
  const clock = new FakeClock(Date.UTC(2026, 10, 12));
  let reader: ReturnType<typeof installMindKnowledge>;
  const app = await startLoom({ home: home(), clock, authenticate: req => ({ viewer: req.url?.includes('partial') ? { kind: 'member', id: 'partial' } : owner, valid: () => true }), install(app) {
    reader = installMindKnowledge(app.operations, app.live, { path, sharing: () => sharing });
    installTouched(app.operations, (v, c) => v.kind === 'agent' && v.id === 'art' && c.type === 'knowledge' ? c : undefined);
  } });
  closes.push(() => { reader!.close(); }); closes.push(() => app.close());
  return { app, clock };
}
it('empty source is read-only and missing details return not-found; partial owners and agents are denied', async () => {
  const path = join(home(), 'missing.db'); const { app } = await fixture(path);
  expect(app.operations.call('direct', owner, 'mind.knowledgeList', {})).toMatchObject({ ok: true, value: { pages: [], total: 0 } });
  expect(app.operations.call('direct', owner, 'mind.knowledgeRead', { slug: 'missing' })).toMatchObject({ code: 'not-found' });
  for (const viewer of [{ kind: 'member', id: 'partial' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'one' }] as Viewer[]) expect(app.operations.call('direct', viewer, 'mind.knowledgeList', {})).toMatchObject({ code: 'denied' });
  expect(existsSync(path)).toBe(false);
});
it('projects freshness, citations, referring pages, and stale checks without renewing the successful stamp', async () => {
  const path = join(home(), 'knowledge.db'); const store = new SqliteKnowledgeBackend({ dbPath: path }); closes.push(() => store.close());
  await store.writePage({ slug: 'fact', title: 'A fact', domain: 'systems', body: 'a'.repeat(20001), citations: [{ claim: 'One', source_kind: 'web', source_locator: 'https://example.com', excerpt: 'e' }] });
  await store.writePage({ slug: 'ref', title: 'Reference', domain: 'systems', body: '[[fact]]' });
  await store.verifyPages({ slug: 'fact', verified_at: '2026-11-10T00:00:00.000Z', verifier: 'art' });
  const { app } = await fixture(path);
  const mind = mindRole(app.operations);
  const read = () => mind.call(owner, 'knowledgeRead', { slug: 'fact' });
  expect(mind.call({ kind: 'member', id: 'partial' }, 'knowledgeRead', { slug: 'fact' })).toMatchObject({ code: 'denied' });
  expect(read()).toMatchObject({ ok: true, value: { id: 'fact', fresh: 'fresh', recent: true, citedBy: [{ slug: 'ref' }], sources: [{ href: 'https://example.com' }] } });
  const result = read(); if (result.ok) expect((result.value as any).body).toHaveLength(20000);
  await store.verifyPages({ slug: 'fact', outcome: 'stale', verified_at: '2026-11-11T00:00:00.000Z' });
  expect(read()).toMatchObject({ value: { fresh: 'due', verified_at: '2026-11-10T00:00:00.000Z', checked: { outcome: 'stale' } } });
  await store.archivePage({ slug: 'fact' });
  expect(read()).toMatchObject({ code: 'not-found' });
});
it('two live windows get freshness deadlines and committed refreshes; a partial member gets no pages', async () => {
  const path = join(home(), 'knowledge.db'); const store = new SqliteKnowledgeBackend({ dbPath: path }); closes.push(() => store.close());
  await store.writePage({ slug: 'fact', title: 'A fact', domain: 'systems', body: 'content' });
  await store.verifyPages({ slug: 'fact', verified_at: '2026-11-06T00:00:00.000Z' });
  const { app, clock } = await fixture(path);
  const windows = await Promise.all(['', '', '?partial'].map(async query => { const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live' + query); const next = inbox(ws); closes.push(() => ws.close()); await once(ws, 'open'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'knowledge' })); return { ws, next }; }));
  expect((await windows[0].next()).records[0]).toMatchObject({ recent: true, fresh: 'fresh' });
  await windows[1].next(); expect((await windows[2].next()).records).toEqual([]);
  clock.advance(86400_000);
  for (const w of windows.slice(0, 2)) expect((await w.next()).record.recent).toBeUndefined();
  clock.advance(13 * 86400_000);
  for (const w of windows.slice(0, 2)) expect((await w.next()).record.fresh).toBe('aging');
  clock.advance(10 * 86400_000);
  for (const w of windows.slice(0, 2)) expect((await w.next()).record.fresh).toBe('due');
  await store.archivePage({ slug: 'fact' });
  app.operations.call('direct', { kind: 'agent', id: 'art' }, 'core.touched', { type: 'knowledge', id: 'fact' });
  for (const w of windows.slice(0, 2)) expect(await w.next()).toMatchObject({ kind: 'del', id: 'fact' });
});

it('refreshes derived backlinks after referring content changes, archive, restore, rename and purge', async () => {
  const path = join(home(), 'knowledge.db'); const store = new SqliteKnowledgeBackend({ dbPath: path }); closes.push(() => store.close());
  await store.writePage({ slug: 'fact', title: 'Fact', domain: 'systems', body: 'Content' });
  await store.writePage({ slug: 'ref', title: 'Reference', domain: 'systems', body: '[[fact]]' });
  const { app } = await fixture(path);
  const windows = await Promise.all(['', '', '?partial'].map(async query => {
    const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live' + query); const next = inbox(ws);
    closes.push(() => ws.close()); await once(ws, 'open');
    // A scoped reader must refresh even when the referring record is outside its scope.
    ws.send(JSON.stringify({ kind: 'subscribe', type: 'knowledge', scope: 'fact' }));
    const initial = await next();
    return { ws, next, initial };
  }));
  for (const w of windows.slice(0, 2)) expect(w.initial.records[0].citedBy).toEqual([{ slug: 'ref', title: 'Reference' }]);
  expect(windows[2].initial.records).toEqual([]);
  async function notify(id: string, expected: Array<{ slug: string; title: string }>) {
    expect(app.operations.call('direct', { kind: 'agent', id: 'art' }, 'core.touched', { type: 'knowledge', id })).toMatchObject({ ok: true });
    for (const [i, w] of windows.entries()) {
      // A socket call is a FIFO barrier: all earlier change frames precede its result.
      w.ws.send(JSON.stringify({ kind: 'call', request: 'barrier', name: 'mind.knowledgeList', input: {} }));
      const frames: any[] = [];
      for (;;) { const frame = await w.next(); if (frame.kind === 'result') break; frames.push(frame); }
      const updates = frames.filter(f => f.kind === 'put');
      if (i === 2) expect(updates).toEqual([]);
      else expect(updates).toEqual([expect.objectContaining({ record: expect.objectContaining({ id: 'fact', citedBy: expected }) })]);
    }
  }
  await store.writePage({ slug: 'ref', title: 'Reference', domain: 'systems', body: 'No reference', mode: 'replace' });
  await notify('ref', []);
  await store.writePage({ slug: 'ref', title: 'Reference', domain: 'systems', body: '/knowledge/fact', mode: 'replace' });
  await notify('ref', [{ slug: 'ref', title: 'Reference' }]);
  await store.archivePage({ slug: 'ref' }); await notify('ref', []);
  await store.restorePage({ slug: 'ref' }); await notify('ref', [{ slug: 'ref', title: 'Reference' }]);
  await store.movePage({ slug: 'ref', new_slug: 'renamed', leave_pointer: false });
  await notify('ref', [{ slug: 'renamed', title: 'Reference' }]);
  await store.archivePage({ slug: 'renamed' }); await notify('renamed', []);
  await store.purgePages({ slugs: ['renamed'], confirm: true }); await notify('renamed', []);
  await store.archivePage({ slug: 'fact' });
  app.live.changed([{ type: 'knowledge', id: 'fact' }, { type: 'knowledge', id: 'renamed' }]);
  // Previously sent records remain candidates after they disappear from ids().
  for (const w of windows.slice(0, 2)) expect(await w.next()).toMatchObject({ kind: 'del', id: 'fact' });
});
