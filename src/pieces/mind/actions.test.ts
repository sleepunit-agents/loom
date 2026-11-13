import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
import { installMindKnowledge } from './index.js';
import { verifyKnowledgePages } from '../../backends/knowledge-verification.js';
import { installMindKnowledgeActions } from './actions.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const sharing: Sharing = { members: { owner: { owner: true, agents: ['art'] }, partial: { owner: false, agents: ['art'] } }, projects: {}, services: { reader: { types: ['knowledge'], operations: [] } } };
const owner: Viewer = { kind: 'member', id: 'owner' };
async function fixture(missing = false) {
  const home = mkdtempSync(join(tmpdir(), 'mind-actions-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'knowledge.db');
  const backend = missing ? undefined : new SqliteKnowledgeBackend({ dbPath: path });
  if (backend) { cleanups.push(() => backend.close()); await backend.writePage({ slug: 'fact', title: 'Fact', domain: 'systems', body: 'Original' }); }
  const db = missing ? undefined : new BetterSqlite3(path);
  if (db) cleanups.push(() => db.close());
  const clock = new FakeClock(Date.UTC(2026, 10, 12));
  async function start() {
    const app = await startLoom({ home: join(home, 'daemon'), clock, authenticate: () => ({ viewer: owner, valid: () => true }), install(app) {
      const reader = installMindKnowledge(app.operations, app.live, { path, sharing: () => sharing }); app.onClose(() => reader.close());
      const actions = installMindKnowledgeActions(app.operations, { path, sharing: () => sharing, verify: verifyKnowledgePages }); app.onClose(() => actions.close());
    } });
    let stopped = false;
    const close = async () => { if (stopped) return; stopped = true; await app.close(); };
    cleanups.push(close);
    return { ...app, close };
  }
  return { app: await start(), start, db, backend, clock, path };
}
it('confirms and requests a recheck with original notes, attribution and clock; retry acts once', async () => {
  const { app, backend, clock } = await fixture();
  const call = (verb: string, id: string) => app.operations.call('direct', owner, `mind.${verb}`, { slug: 'fact' }, id);
  const confirmed = call('knowledgeVerify', 'confirm');
  expect(confirmed).toMatchObject({ ok: true, value: { stamped: true, noted: true, verified_at: new Date(clock.now()).toISOString() } });
  clock.advance(86400_000);
  expect(call('knowledgeVerify', 'confirm')).toEqual(confirmed);
  const stale = call('knowledgeRecheck', 'stale');
  expect(stale).toMatchObject({ ok: true, value: { stamped: false, noted: true } });
  expect(await backend!.getPage('fact')).toMatchObject({ verified_at: '2026-11-12T00:00:00.000Z', updated: '2026-11-13T00:00:00.000Z', body: "Original\n\n## Verification — 2026-11-12\n\nconfirmed from loom's page\n\n## Verification — 2026-11-13\n\nasked to be checked again from loom's page" });
  expect(await backend!.getVerifications('fact')).toHaveLength(2);
  expect(await backend!.getVerifications('fact')).toEqual(expect.arrayContaining([expect.objectContaining({ verifier: 'owner', outcome: 'stale' })]));
  expect(app.operations.call('direct', owner, 'mind.knowledgeRead', { slug: 'fact' })).toMatchObject({ value: { fresh: 'due' } });
});
it('denies partial members, agents, runners and read-only services without creating receipt metadata', async () => {
  const { app, db, backend } = await fixture();
  for (const viewer of [{ kind: 'member', id: 'partial' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'one' }, { kind: 'service', id: 'reader' }] as Viewer[]) {
    for (const verb of ['knowledgeVerify', 'knowledgeRecheck']) expect(app.operations.call('direct', viewer, `mind.${verb}`, { slug: 'fact' }, 'denied')).toMatchObject({ code: 'denied' });
  }
  expect(db!.prepare("SELECT name FROM sqlite_master WHERE name = 'mind_operation_receipts'").get()).toBeUndefined();
  expect(await backend!.getVerifications('fact')).toEqual([]);
  expect(app.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'fact' })).toMatchObject({ code: 'invalid' });
});
it('does not create a missing source, and refuses missing or archived pages without a receipt', async () => {
  const missing = await fixture(true);
  expect(missing.app.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'fact' }, 'missing')).toMatchObject({ code: 'not-found' });
  expect(existsSync(missing.path)).toBe(false);
  const { app, backend, db } = await fixture();
  expect(app.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'absent' }, 'absent')).toMatchObject({ code: 'not-found' });
  await backend!.archivePage({ slug: 'fact' });
  expect(app.operations.call('direct', owner, 'mind.knowledgeRecheck', { slug: 'fact' }, 'archived')).toMatchObject({ code: 'conflict' });
  expect(db!.prepare("SELECT name FROM sqlite_master WHERE name = 'mind_operation_receipts'").get()).toBeUndefined();
});
it('replays the source receipt after a core receipt failure and restart, without another note or audit', async () => {
  const { app, start, backend, db, clock } = await fixture();
  app.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  expect(app.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'fact' }, 'recover')).toMatchObject({ code: 'unavailable' });
  // Unavailable explicitly does not promise an unchanged external content store.
  const page = await backend!.getPage('fact');
  expect(await backend!.getVerifications('fact')).toHaveLength(1);
  expect(db!.prepare('SELECT count(*) AS n FROM mind_operation_receipts').get()).toEqual({ n: 1 });
  app.db.exec('DROP TRIGGER fail_receipt');
  await app.close(); clock.advance(86400_000);
  const restarted = await start();
  expect(restarted.operations.call('direct', owner, 'mind.knowledgeRecheck', { slug: 'fact' }, 'recover')).toMatchObject({ code: 'conflict' });
  expect(restarted.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'another' }, 'recover')).toMatchObject({ code: 'conflict' });
  expect(restarted.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'fact' }, 'recover')).toMatchObject({ ok: true, value: { verified_at: '2026-11-12T00:00:00.000Z' } });
  expect(await backend!.getPage('fact')).toEqual(page);
  expect(await backend!.getVerifications('fact')).toHaveLength(1);
  expect(restarted.db.prepare('SELECT count(*) AS n FROM core_operations').get()).toEqual({ n: 1 });
});
it('rolls content back if source receipt insertion fails, then allows a safe retry', async () => {
  const { app, backend, db } = await fixture();
  // Create the source schema with an unrelated completed action.
  expect(app.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'fact' }, 'first')).toMatchObject({ ok: true });
  const before = await backend!.getPage('fact');
  db!.exec("CREATE TRIGGER fail_source_receipt BEFORE INSERT ON mind_operation_receipts BEGIN SELECT RAISE(ABORT, 'injected source receipt failure'); END");
  expect(app.operations.call('direct', owner, 'mind.knowledgeRecheck', { slug: 'fact' }, 'retry')).toMatchObject({ code: 'unavailable' });
  expect(await backend!.getPage('fact')).toEqual(before);
  expect(await backend!.getVerifications('fact')).toHaveLength(1);
  db!.exec('DROP TRIGGER fail_source_receipt');
  expect(app.operations.call('direct', owner, 'mind.knowledgeRecheck', { slug: 'fact' }, 'retry')).toMatchObject({ ok: true });
  expect(await backend!.getVerifications('fact')).toHaveLength(2);
});
it('publishes committed checks to two live windows and repairs publication after a failed core receipt', async () => {
  const { app } = await fixture();
  const windows = await Promise.all([1, 2].map(async () => {
    const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/live');
    const queued: any[] = [], waiting: Array<(v: any) => void> = [];
    socket.on('message', raw => { const frame = JSON.parse(raw.toString()); const next = waiting.shift(); if (next) next(frame); else queued.push(frame); });
    const next = () => queued.length ? Promise.resolve(queued.shift()) : new Promise<any>(resolve => waiting.push(resolve));
    cleanups.push(() => socket.close()); await once(socket, 'open');
    socket.send(JSON.stringify({ kind: 'subscribe', type: 'knowledge' })); await next();
    return { socket, next };
  }));
  app.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  expect(app.operations.call('direct', owner, 'mind.knowledgeRecheck', { slug: 'fact' }, 'live')).toMatchObject({ code: 'unavailable' });
  for (const w of windows) {
    w.socket.send(JSON.stringify({ kind: 'call', request: 'barrier', name: 'mind.knowledgeList', input: {} }));
    expect(await w.next()).toMatchObject({ kind: 'pending', request: 'barrier' });
    expect(await w.next()).toMatchObject({ kind: 'result', request: 'barrier' });
  }
  app.db.exec('DROP TRIGGER fail_receipt');
  expect(app.operations.call('direct', owner, 'mind.knowledgeRecheck', { slug: 'fact' }, 'live')).toMatchObject({ ok: true });
  for (const w of windows) expect(await w.next()).toMatchObject({ kind: 'put', record: { id: 'fact', fresh: 'due', checked: { outcome: 'stale' } } });
});
it('refuses a locked source before effects and permits reuse only after the thirty-day retry window', async () => {
  const { app, db, backend, clock } = await fixture();
  db!.exec('BEGIN IMMEDIATE');
  try { expect(app.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'fact' }, 'locked')).toMatchObject({ code: 'unavailable' }); }
  finally { db!.exec('ROLLBACK'); }
  expect(await backend!.getVerifications('fact')).toEqual([]);
  expect(app.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'fact' }, 'locked')).toMatchObject({ ok: true });
  clock.advance(30 * 86400_000 - 1);
  expect(app.operations.call('direct', owner, 'mind.knowledgeRecheck', { slug: 'fact' }, 'locked')).toMatchObject({ code: 'conflict' });
  clock.advance(1);
  expect(app.operations.call('direct', owner, 'mind.knowledgeRecheck', { slug: 'fact' }, 'locked')).toMatchObject({ ok: true });
  expect(await backend!.getVerifications('fact')).toHaveLength(2);
  expect(db!.prepare('SELECT count(*) AS n FROM mind_operation_receipts').get()).toEqual({ n: 1 });
});
it('rolls first-use receipt DDL and verification back when the original note would exceed the body cap', async () => {
  const { app, backend, db } = await fixture();
  await backend!.writePage({ slug: 'fact', title: 'Fact', domain: 'systems', body: 'a'.repeat(65536), mode: 'replace' });
  expect(app.operations.call('direct', owner, 'mind.knowledgeVerify', { slug: 'fact' }, 'cap')).toMatchObject({ code: 'unavailable' });
  expect(await backend!.getVerifications('fact')).toEqual([]);
  expect((await backend!.getPage('fact'))!.body).toHaveLength(65536);
  expect(db!.prepare("SELECT name FROM sqlite_master WHERE name = 'mind_operation_receipts'").get()).toBeUndefined();
});
