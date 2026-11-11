/**
 * Lock waits off the event loop (lock-gate.ts; t-2130, t-2141), through the server: while another process holds a
 * Comms database (a write lock, or a WAL recovery in progress), a Comms post, a live update and a turn record wait and
 * then succeed, and /login answers at once meanwhile. The same for household.json's and the sessions file's locks.
 * #776 failed these posts at once instead ("comms/adapter: unavailable", SQLITE_BUSY_RECOVERY): never again.
 * Needs `age` (CI installs it) and python3 (to hold a recovery's locks, as SQLite's own recovery does).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { request, type ClientRequest } from 'node:http';
import { sessionStore } from './ui/sessions.js';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { AUDIT_DB, openAuditDb } from './audit.js';
import { agentDir, createToken, loadHousehold, markIndexOf, revokeToken, type Household } from './household.js';
import { parseLoomBlock, runtimePieces } from './cli/pieces-managed.js';
import { createConversationTables, recordTurn } from './backends/conversations.js';
import * as comms from './comms.js';
import { backfillRefs, backfilled, refsOf } from './comms-work.js';
import { COMMS_DB } from './comms.js';
import { HOUSEHOLD_DB } from './household-store.js';
import * as lockGate from './lock-gate.js';
import { pendingLockWaits, waitForLocks } from './lock-gate.js';
import { clearPieceCache } from './ui/pieces.js';
import { stopCommsWatch } from './ui/comms-live.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const hasPython = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf-8' }).status === 0;

const RUNTIME_BIN = `#!${process.execPath}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'api') return console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: '{}', stderr: '' } }));
  console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: 1, body: 'started' }));
});
`;

/** Another process holding `path`: `exclusive` (BEGIN EXCLUSIVE), or `recovery` (a WAL recovery's locks, its index invalid). */
async function hold(path: string, how: 'exclusive' | 'recovery'): Promise<{ release: () => Promise<void> }> {
  const child: ChildProcessWithoutNullStreams = how === 'exclusive'
    ? spawn(process.execPath, ['-e', `
        const Database = require('better-sqlite3');
        const db = new Database(process.argv[1]);
        db.exec('BEGIN EXCLUSIVE');
        console.log('held');
        process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
        setTimeout(() => process.exit(2), 20000).unref();
      `, path], { stdio: 'pipe' })
    // As walIndexRecover holds them: the shared DMS lock (byte 128) and WRITE, CKPT and RECOVER exclusive (120-122),
    // with the wal-index header zeroed so every reader must recover. SQLite answers SQLITE_BUSY_RECOVERY meanwhile.
    : spawn('python3', ['-c', `
import fcntl, os, sys
fd = os.open(sys.argv[1] + '-shm', os.O_RDWR)
fcntl.lockf(fd, fcntl.LOCK_SH, 1, 128)
fcntl.lockf(fd, fcntl.LOCK_EX, 3, 120)
os.pwrite(fd, b'\\0' * 136, 0)
print('held', flush=True)
sys.stdin.readline()
`, path], { stdio: 'pipe' });
  child.stderr.on('data', (d) => process.stderr.write(d));
  const [started] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => [null])]);
  if (!started) throw new Error(`the ${how} holder exited before holding ${path}`);
  return {
    release: async () => {
      if (child.exitCode !== null) return;
      child.stdin.end('\n');
      await once(child, 'exit');
    },
  };
}

/** Whether `p` is still waiting after `ms`. */
const pending = async (p: Promise<unknown>, ms = 0) => Promise.race([p.then(() => false, () => false), delay(ms).then(() => true)]);

describe.skipIf(!hasPython)('lock-gate', () => {
  it('waits out a WAL recovery without blocking the event loop, then reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-gate-'));
    const path = join(dir, 'x.db');
    const db = new BetterSqlite3(path);
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)');
      const held = await hold(path, 'recovery');
      // The synchronous wait #776 replaced: busy for as long as its timeout, the loop frozen.
      const sync = new BetterSqlite3(path, { timeout: 0 });
      expect(() => sync.prepare('SELECT n FROM t').get()).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY_RECOVERY' }));
      sync.close();
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 10);
      try {
        expect(await waitForLocks({ read: [path], budgetMs: 300 })).toBe(false);
        expect(ticks).toBeGreaterThan(10);
        const waiting = waitForLocks({ write: [path], budgetMs: 5000 });
        expect(await pending(waiting, 100)).toBe(true);
        await held.release();
        expect(await waiting).toBe(true);
      } finally { clearInterval(timer); }
      expect(db.prepare('SELECT n FROM t').get()).toEqual({ n: 1 });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('lets a line of writers through once a held lock goes, and a spent budget fails nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-gate-'));
    const path = join(dir, 'x.db');
    const db = new BetterSqlite3(path);
    try {
      db.exec('CREATE TABLE t (n INTEGER)');
      const held = await hold(path, 'exclusive');
      const short = waitForLocks({ write: [path], budgetMs: 100 });
      const line = Array.from({ length: 10 }, () => waitForLocks({ write: [path] }));
      // The short one is let go when its budget runs out, false: its caller goes on to its own wait, never a failure.
      expect(await short).toBe(false);
      expect(await pending(Promise.all(line), 50)).toBe(true);
      await held.release();
      expect(await Promise.all(line)).toEqual(Array(10).fill(true));
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(!hasAge || !hasPython)('a held lock, through the server', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;
  let n = 500;
  const mid = (i: number) => `a${String(i).padStart(15, '0').replace(/[0189]/g, (d) => ({ '0': 'a', '1': 'b', '8': 'c', '9': 'd' } as Record<string, string>)[d])}`;

  const api = (path: string, body: unknown) => fetch(`${base}/api/loom/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.runtime}` }, body: JSON.stringify(body) });
  const open = async (text = 'hello') => {
    const r = await fetch(`${base}/comms/new`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` },
      body: JSON.stringify({ agent: 'art', id: mid(n++), text }) });
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { thread: { id: string; conversation: string } }).thread;
  };
  const read = async (res: Response, until: RegExp, ms: number): Promise<string> => {
    const reader = res.body!.getReader();
    let got = '';
    const end = Date.now() + ms;
    while (Date.now() < end && !until.test(got)) {
      const chunk = await Promise.race([reader.read(), delay(Math.max(1, end - Date.now())).then(() => ({ done: true as const, value: undefined }))]);
      if (chunk.done) break;
      got += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    return got;
  };

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-locks-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# art\n');
    const mem = new BetterSqlite3(join(home, 'agents', 'art', 'memories.db'));
    createConversationTables(mem);
    mem.close();
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    h = loadHousehold(home)!;
    process.env.LOOM_HOME = h.home;
    const loom = parseLoomBlock({ role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'] }, 'runtime', ['loom-runtime']);
    if (typeof loom === 'string') throw new Error(loom);
    const dir = join(home, 'pieces', 'runtime');
    mkdirSync(join(dir, 'current'), { recursive: true });
    writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name: 'runtime', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'runtime', version: '1', installed: 'x',
      bins: ['loom-runtime'], loom: { settings: [], services: [], ...loom } }));
    writeFileSync(join(dir, 'current', 'cli'), RUNTIME_BIN);
    chmodSync(join(dir, 'current', 'cli'), 0o755);
    mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
    symlinkSync(join(dir, 'current', 'cli'), join(home, 'pieces', 'bin', 'loom-runtime'));
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.runtime = createToken(h, { role: { kind: 'runtime', piece: 'runtime' }, label: 'runtime', runtimePieces: runtimePieces(process.env) }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    stopCommsWatch();
    await handle.close();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  for (const [db, how] of [[COMMS_DB, 'exclusive'], [HOUSEHOLD_DB, 'exclusive'], [HOUSEHOLD_DB, 'recovery']] as const) {
    it(`a Comms post, a live update and a turn wait out ${how === 'recovery' ? 'a WAL recovery' : 'a write lock'} on ${db}, and /login stays fast`, async () => {
      const t = await open();
      const ac = new AbortController();
      const stream = await fetch(`${base}/comms/${t.id}/events`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${tok.jonathan}` }, signal: ac.signal });
      expect(stream.status).toBe(200);
      expect(await read(stream, /event: message/, 3000)).toMatch(/event: message/);
      // A recovery needs the WAL's index to exist: another connection keeps it, as the daemon's many always do.
      const keeper = new BetterSqlite3(join(h.home, db));
      keeper.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
      const held = await hold(join(h.home, db), how);
      try {
        const began = performance.now();
        const post = api('comms/adapter', { op: 'post', place: t.id, agent: 'art', text: `under ${how}` });
        const activity = api('comms/activity', { conversation: t.conversation, run: 'run-locks', cards: [{ id: 'c1', tool: 'Bash', summary: 'held', state: 'running' }] });
        const turn = api('conversations/turn', { agent: 'art', venue: 'loom', place: t.id, at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
        await delay(100);
        const login = await fetch(`${base}/login`);
        expect(login.status).toBe(200);
        const loginMs = performance.now() - began;
        console.log(`${db} ${how}: /login answered after ${Math.round(loginMs)} ms, posts still waiting`);
        expect(loginMs).toBeLessThan(1000);
        // Released only after /login answered and the writers still wait: a blocking or failing server can't pass.
        expect(await pending(post)).toBe(true);
        expect(await pending(activity)).toBe(true);
        const live = read(stream, /event: message\ndata: \{"seq":\d+\}/, 8000);
        await held.release();
        const posted = await post;
        expect(posted.status, await posted.clone().text()).toBe(200);
        expect(await posted.json()).toMatchObject({ ok: true });
        expect((await activity).status).toBe(200);
        expect((await turn).status).toBe(200);
        expect(await live).toMatch(/event: message/);
      } finally { await held.release(); keeper.close(); ac.abort(); }
    }, 30_000);
  }

  it('a continuation\'s reconciliation waits out a held comms.db and finds its receipt', async () => {
    const t = await open();
    const q = { op: 'post', agent: 'art', place: t.id, text: 'kept before the lock', expiresAt: Date.now() + 60_000, ref: `continuation-${'d'.repeat(64)}` };
    const first = await api('comms/adapter', q);
    expect(first.status).toBe(200);
    const { id } = await first.json() as { id: string };
    // comms.db is what a reconciliation writes: it waits for it, /login answers meanwhile, and it finds the receipt.
    const held = await hold(join(h.home, COMMS_DB), 'exclusive');
    try {
      const began = performance.now();
      const r = api('comms/adapter', { ...q, op: 'reconcile' });
      await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await pending(r)).toBe(true);
      await held.release();
      expect(await (await r).json()).toMatchObject({ ok: true, state: 'delivered', id });
    } finally { await held.release(); }
  }, 20_000);

  it('a null body is still a bad input, not an internal error', async () => {
    const r = await api('comms/adapter', null);
    expect(r.status).toBe(400);
  });

  it('a Comms post never waits on household.json\'s lock, which it doesn\'t take', async () => {
    const lock = join(h.home, '.household.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const began = performance.now();
      await open();
      expect(performance.now() - began).toBeLessThan(1000);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('never makes a stranger wait for a lock: refused at once, so it can\'t crowd the line', async () => {
    const held = await hold(join(h.home, COMMS_DB), 'exclusive');
    try {
      const began = performance.now();
      const r = await fetch(`${base}/comms/new`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'art', id: mid(n++), text: 'x' }) });
      expect(r.status).toBe(401);
      const bad = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=wrong', redirect: 'manual' });
      expect(bad.status).toBe(401);
      expect(performance.now() - began).toBeLessThan(1000);
    } finally { await held.release(); }
  }, 20_000);

  it('a household change waits out household.json\'s lock, and /login stays fast', async () => {
    const lock = join(h.home, '.household.lock');
    const holder = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => process.exit(0)); setTimeout(() => process.exit(2), 20000)'], { stdio: 'pipe' });
    try {
      writeFileSync(lock, String(holder.pid));
      const before = readFileSync(join(h.home, 'household.json'), 'utf8');
      const began = performance.now();
      const post = fetch(`${base}/act/loom`, { method: 'POST', headers: { 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: '_action=mark-set&agent=art&mark=1', redirect: 'manual' });
      await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await pending(post)).toBe(true);
      expect(readFileSync(join(h.home, 'household.json'), 'utf8')).toBe(before);
      rmSync(lock);
      const done = await post;
      expect(done.status).toBe(200);
      expect(await done.json()).toMatchObject({ ok: true });
    } finally { holder.kill(); rmSync(lock, { force: true }); }
  }, 20_000);


  /** Send only part of a body first: the original pre-body probe has run before the test takes the lock. */
  const uploading = (path: string, body: string, headers: Record<string, string>) => {
    let req!: ClientRequest, text = '';
    let received!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    const result = new Promise<number>((resolve, reject) => {
      req = request(`${base}${path}`, { method: 'POST', headers: { ...headers, expect: '100-continue' } }, (res) => {
        res.on('data', (d) => { text += d; }); res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.once('continue', received);
      req.write(body.slice(0, 1));
    });
    return { finish: () => req.end(body.slice(1)), result, started, text: () => text };
  };

  it('MCP waits for a recovery that began during its slow body', async () => {
    const memory = join(agentDir(h, 'art'), 'memories.db');
    const keeper = new BetterSqlite3(memory);
    keeper.pragma('journal_mode = WAL');
    keeper.prepare('SELECT 1 FROM sqlite_master').get();
    const upload = uploading('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lock-test', version: '1' },
    } }), { authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
    await upload.started;
    const held = await hold(memory, 'recovery');
    try {
      const began = performance.now();
      upload.finish();
      await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await pending(upload.result)).toBe(true);
      await held.release();
      expect(await upload.result).toBe(200);
    } finally { await held.release(); keeper.close(); }
  }, 20_000);

  it('activation-time audit maintenance waits off the loop and an independent Comms sweep progresses', async () => {
    const t = await open();
    const words = new BetterSqlite3(join(h.home, COMMS_DB));
    words.prepare("UPDATE comms_messages SET at = '2020-01-01T00:00:00Z' WHERE thread = ? AND seq = 1").run(t.id); words.close();
    const db = openAuditDb(h.home);
    db.prepare('INSERT OR REPLACE INTO audit_entries VALUES (?, ?, ?, ?, ?, ?, ?)').run('art', 'cv-maintenance', 1, 'loom', 'message', '2020-01-01T00:00:00Z', Buffer.from('expired'));
    db.close();
    const held = await hold(join(h.home, AUDIT_DB), 'exclusive');
    try {
      const began = performance.now();
      handle.setBackgroundActive(false);
      handle.setBackgroundActive(true);
      handle.setBackgroundActive(false);
      handle.setBackgroundActive(true);
      expect(pendingLockWaits()).toBe(1);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      // The audit lock remains held: another named timer job must still finish its own work.
      await expect.poll(() => {
        const check = new BetterSqlite3(join(h.home, COMMS_DB));
        try { return check.prepare('SELECT text FROM comms_messages WHERE thread = ? AND seq = 1').get(t.id); }
        finally { check.close(); }
      }, { timeout: 1000 }).toEqual({ text: null });
      await held.release();
      await expect.poll(() => {
        const check = new BetterSqlite3(join(h.home, AUDIT_DB));
        try { return check.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE conversation = 'cv-maintenance'").get(); } finally { check.close(); }
      }).toEqual({ n: 0 });
    } finally { await held.release(); }
  }, 20_000);

  for (const path of ['/mcp', '/cli']) {
    it(`${path} refuses a token revoked during its database wait`, async () => {
      const label = path === '/mcp' ? 'queued-mcp' : 'queued-cli';
      const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label }).token;
      const memory = join(agentDir(h, 'art'), 'memories.db');
      const keeper = new BetterSqlite3(memory);
      keeper.pragma('journal_mode = WAL');
      keeper.prepare('SELECT 1 FROM sqlite_master').get();
      const held = await hold(memory, 'recovery');
      try {
        const request = fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify(path === '/mcp' ? { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'revoked', version: '1' } } } : { argv: ['memory', 'list'] }) });
        await delay(100);
        expect(await pending(request)).toBe(true);
        revokeToken(h, label);
        await held.release();
        expect((await request).status).toBe(401);
      } finally { await held.release(); keeper.close(); }
    }, 20_000);
  }

  for (const path of ['/mcp', '/cli']) {
    it(`${path} never queues a token revoked during upload`, async () => {
      const label = path === '/mcp' ? 'upload-mcp' : 'upload-cli';
      const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label }).token;
      const upload = uploading(path, JSON.stringify(path === '/mcp' ? { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'upload', version: '1' } } } : { argv: ['memory', 'list'] }), {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      });
      await upload.started;
      const memory = join(agentDir(h, 'art'), 'memories.db'), keeper = new BetterSqlite3(memory);
      keeper.pragma('journal_mode = WAL'); keeper.prepare('SELECT 1 FROM sqlite_master').get();
      const held = await hold(memory, 'recovery');
      try {
        revokeToken(h, label); upload.finish();
        expect(await upload.result).toBe(401);
        expect(pendingLockWaits()).toBe(0);
      } finally { await held.release(); keeper.close(); }
    }, 20_000);
  }

  it('Comms refuses a caller revoked during the final lock wait', async () => {
    const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'slow-revoked' }).token;
    const upload = uploading('/comms/new', JSON.stringify({ agent: 'art', id: mid(n++), text: 'must not land' }), {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json',
    });
    await upload.started;
    const held = await hold(join(h.home, COMMS_DB), 'exclusive');
    try {
      upload.finish();
      await delay(100);
      expect(await pending(upload.result)).toBe(true);
      revokeToken(h, 'slow-revoked');
      await held.release();
      expect(await upload.result).toBe(403);
    } finally { await held.release(); }
  }, 20_000);

  it.each(['revoked', 'scope reduced'])('an action refuses authority %s during its final wait', async (change) => {
    const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: `action-${change}` }).token;
    const original = readFileSync(join(h.home, 'household.json'), 'utf8');
    const upload = uploading('/act/loom', '_action=mark-set&agent=art&mark=3', {
      authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1',
    });
    await upload.started;
    const lock = join(h.home, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      upload.finish();
      await delay(100);
      expect(await pending(upload.result)).toBe(true);
      if (change === 'revoked') revokeToken(h, `action-${change}`);
      else {
        const file = JSON.parse(original);
        file.members[0].agents = ['art'];
        file.members.push({ person: 'sam', role: 'owner', agents: '*' });
        writeFileSync(join(h.home, 'household.json'), JSON.stringify(file));
      }
      rmSync(lock);
      expect(await upload.result).toBe(403);
      expect(markIndexOf(loadHousehold(h.home)!, 'art')).not.toBe(3);
    } finally { rmSync(lock, { force: true }); writeFileSync(join(h.home, 'household.json'), original); }
  }, 20_000);

  it('a verified sign-in link waits asynchronously; an unknown link never queues', async () => {
    const store = sessionStore(h.home);
    const code = store.createLink(createHash('sha256').update(tok.jonathan).digest(), 300);
    const lock = join(h.home, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const began = performance.now();
      const signin = fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual' });
      await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect((await fetch(`${base}/login/${'e'.repeat(64)}`, { method: 'POST', redirect: 'manual' })).status).toBe(401);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await pending(signin)).toBe(true);
      rmSync(lock);
      const signed = await signin;
      expect(signed.status).toBe(303);
      expect(signed.headers.has('set-cookie')).toBe(true);
      expect((await fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual' })).status).toBe(401);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('a link expired during its wait is still refused without a session', async () => {
    const store = sessionStore(h.home);
    const code = store.createLink(createHash('sha256').update(tok.jonathan).digest(), 300);
    const lock = join(h.home, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const signin = fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual' });
      await delay(100);
      expect(await pending(signin)).toBe(true);
      const path = join(h.home, 'ui-sessions.json');
      const file = JSON.parse(readFileSync(path, 'utf8'));
      file.links[createHash('sha256').update(code).digest('hex')].expires = 0;
      writeFileSync(path, JSON.stringify(file));
      rmSync(lock);
      const denied = await signin;
      expect(denied.status).toBe(401);
      expect(denied.headers.has('set-cookie')).toBe(false);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('an unknown sign-out cookie never joins the sessions queue', async () => {
    const lock = join(h.home, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const began = performance.now();
      const r = await fetch(`${base}/logout`, { method: 'POST', headers: { cookie: `loom_ui=${'a'.repeat(64)}` }, redirect: 'manual' });
      expect(r.status).toBe(303);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(pendingLockWaits()).toBe(0);
    } finally { rmSync(lock, { force: true }); }
  });

  it('a pasted token revoked during its wait cannot sign in', async () => {
    const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'pasted-revoked' }).token;
    const lock = join(h.home, 'ui-sessions.lock'); writeFileSync(lock, String(process.pid));
    try {
      const signin = fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), redirect: 'manual' });
      await delay(100); expect(await pending(signin)).toBe(true);
      revokeToken(h, 'pasted-revoked'); rmSync(lock);
      const denied = await signin;
      expect(denied.status).toBe(401); expect(denied.headers.has('set-cookie')).toBe(false);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('a link whose token was revoked during its wait cannot sign in', async () => {
    const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'link-revoked' }).token;
    const code = sessionStore(h.home).createLink(createHash('sha256').update(token).digest(), 300);
    const lock = join(h.home, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const signin = fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual' });
      await delay(100);
      expect(await pending(signin)).toBe(true);
      revokeToken(h, 'link-revoked');
      rmSync(lock);
      const denied = await signin;
      expect(denied.status).toBe(401);
      expect(denied.headers.has('set-cookie')).toBe(false);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('sign-out waits asynchronously then revokes the cookie', async () => {
    const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.jonathan }), redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const lock = join(h.home, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const began = performance.now();
      const logout = fetch(`${base}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
      await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await pending(logout)).toBe(true);
      rmSync(lock);
      expect((await logout).status).toBe(303);
      expect((await fetch(`${base}/account`, { headers: { cookie }, redirect: 'manual' })).status).toBe(303);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('an action waits for locks taken while its body was still arriving', async () => {
    const body = '_action=mark-set&agent=art&mark=2';
    const upload = uploading('/act/loom', body, { 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/x-www-form-urlencoded' });
    await upload.started;
    const lock = join(h.home, '.household.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const began = performance.now();
      upload.finish();
      await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await pending(upload.result)).toBe(true);
      rmSync(lock);
      expect(await upload.result).toBe(200);
      expect(markIndexOf(loadHousehold(h.home)!, 'art')).toBe(2);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('a Comms post waits for a lock taken during its slow body', async () => {
    await open();
    const upload = uploading('/comms/new', JSON.stringify({ agent: 'art', id: mid(n++), text: 'slow body' }), {
      authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/json', accept: 'application/json',
    });
    await upload.started;
    const held = await hold(join(h.home, COMMS_DB), 'exclusive');
    try {
      const began = performance.now();
      upload.finish();
      await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await pending(upload.result)).toBe(true);
      await held.release();
      expect(await upload.result).toBe(200);
      const id = JSON.parse(upload.text()).thread.id;
      const persisted = await fetch(`${base}/comms/${id}`, { headers: { authorization: `Bearer ${tok.jonathan}`, accept: 'application/json' } });
      const view = await persisted.json() as { messages: { text: string }[] };
      expect(view.messages.some((m) => m.text === 'slow body')).toBe(true);
    } finally { await held.release(); }
  }, 20_000);

  it('a sign-in waits out the sessions file\'s lock, and the sign-in page stays fast', async () => {
    const lock = join(h.home, 'ui-sessions.lock');
    try {
      writeFileSync(lock, String(process.pid));
      const began = performance.now();
      const signin = fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${tok.jonathan}`, redirect: 'manual' });
      await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await pending(signin)).toBe(true);
      rmSync(lock);
      const signed = await signin;
      expect(signed.status).toBe(303);
      expect(signed.headers.get('set-cookie')).toContain('HttpOnly');
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);
  it('a slow action waits on the receipt database and keeps one result for retries', async () => {
    const op = 'receipt-slow-body-12345678';
    const body = `_action=mark-set&agent=art&mark=4&_op=${op}`;
    const upload = uploading('/act/loom', body, { 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/x-www-form-urlencoded' });
    await upload.started;
    const path = join(h.home, 'collections', 'live.db');
    const held = await hold(path, 'exclusive');
    try {
      const began = performance.now(); upload.finish(); await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000); expect(await pending(upload.result)).toBe(true);
      await held.release(); expect(await upload.result).toBe(200);
      const answer = JSON.parse(upload.text());
      expect(answer).toMatchObject({ ok: true, receipt: { op, state: 'done' } });
      expect(markIndexOf(loadHousehold(h.home)!, 'art')).toBe(4);
      const retry = await fetch(`${base}/act/loom`, { method: 'POST', headers: { 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/x-www-form-urlencoded' }, body });
      expect(await retry.json()).toEqual(answer);
    } finally { await held.release(); }
  }, 20_000);

  it('a slow collection query rechecks its caller after its body arrives', async () => {
    const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'slow-query' }).token;
    const upload = uploading('/collections/query', JSON.stringify({ queries: [] }), { authorization: `Bearer ${token}`, 'content-type': 'application/json' });
    await upload.started;
    revokeToken(h, 'slow-query');
    upload.finish();
    expect(await upload.result).toBe(403);
  });

  it('refs backfill waits before enumerating threads, indexes refs and crosses a page', async () => {
    const t = await open('see t-4242');
    const first = (await comms.messagesOf(h, process.env, t, { after: 0 }))[0];
    const original = comms.messagesOf;
    const source = vi.spyOn(comms, 'messagesOf').mockImplementation(async (...args) => {
      if (args[2].id !== t.id) return original(...args);
      const after = args[3]?.after ?? 0;
      return Array.from({ length: after === 0 ? comms.SINCE_MAX : 1 }, (_, i) => ({ ...first, seq: after + i + 1, text: after === 0 ? 'first page t-4242' : 'last page t-4243' }));
    });
    const index = new BetterSqlite3(join(h.home, HOUSEHOLD_DB));
    index.prepare("DELETE FROM comms_meta WHERE key = 'refs_backfilled'").run(); index.prepare('DELETE FROM comms_refs').run(); index.close();
    const held = await hold(join(h.home, COMMS_DB), 'exclusive');
    try {
      const began = performance.now(); const backfill = backfillRefs(h, process.env);
      await delay(100); expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000); expect(await pending(backfill)).toBe(true);
      await held.release(); expect(await backfill).toBeGreaterThan(comms.SINCE_MAX);
      expect(refsOf(h.home, t.id)).toContainEqual(expect.objectContaining({ ref: 't-4242', seq: comms.SINCE_MAX }));
      expect(refsOf(h.home, t.id)).toContainEqual(expect.objectContaining({ ref: 't-4243', seq: comms.SINCE_MAX + 1 }));
      expect(backfilled(h.home)).toBe(true);
    } finally { source.mockRestore(); await held.release(); }
  }, 20_000);

  it('folding and scorecard measures wait for memory recovery, then both finish', async () => {
    const dir = agentDir(h, 'art'), memory = join(dir, 'memories.db');
    const old = recordTurn(dir, 'art', { venue: 'loom', place: 'fold-fixture', at: '2020-01-01T00:00:00Z', from: { kind: 'person', slug: 'jonathan' }, kind: 'message' }, 'runtime');
    recordTurn(dir, 'art', { venue: 'loom', place: 'measure-fixture', at: new Date(Date.now() - 2000).toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' }, 'runtime');
    recordTurn(dir, 'art', { venue: 'loom', place: 'measure-fixture', at: new Date().toISOString(), from: { kind: 'agent', id: 'art' }, kind: 'reply', model: 'maintenance-fixture', harness: 'codex' }, 'runtime');
    const keeper = new BetterSqlite3(memory); keeper.pragma('journal_mode = WAL'); keeper.prepare('SELECT 1 FROM sqlite_master').get();
    const held = await hold(memory, 'recovery');
    try {
      const began = performance.now();
      handle.setBackgroundActive(false); handle.setBackgroundActive(true);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      await held.release();
      await expect.poll(() => {
        const check = new BetterSqlite3(memory);
        try { return check.prepare('SELECT COUNT(*) AS n FROM conversation_days WHERE conversation = ?').get(old.conversation); }
        finally { check.close(); }
      }).toEqual({ n: 1 });
      await expect.poll(() => {
        const check = new BetterSqlite3(join(h.home, HOUSEHOLD_DB));
        try { return check.prepare("SELECT COUNT(*) AS n FROM scorecards WHERE model = 'maintenance-fixture' AND measure = 'first_reply_s'").get(); }
        finally { check.close(); }
      }).toEqual({ n: 1 });
    } finally { await held.release(); keeper.close(); }
  }, 20_000);

  it.each(['title', 'project'])('a slow Comms %s post waits on its agent store', async (kind) => {
    const dir = agentDir(h, 'art'), memory = join(dir, 'memories.db');
    const t = await open();
    recordTurn(dir, 'art', { venue: 'loom', place: t.id, at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' }, 'runtime');
    const keeper = new BetterSqlite3(memory); keeper.pragma('journal_mode = WAL');
    keeper.exec("CREATE TABLE IF NOT EXISTS project_names (name TEXT PRIMARY KEY, slug TEXT NOT NULL, kind TEXT NOT NULL)");
    keeper.prepare('INSERT OR REPLACE INTO project_names VALUES (?, ?, ?)').run('lock-project', 'lock-project', 'slug');
    const path = kind === 'title' ? `/comms/${t.id}/title` : '/comms/new';
    const body = kind === 'title' ? { title: 'Label after recovery' } : { agent: 'art', id: mid(n++), text: 'project during recovery', project: 'lock-project' };
    const upload = uploading(path, JSON.stringify(body), { authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/json', accept: 'application/json' });
    await upload.started;
    const held = await hold(memory, 'recovery');
    try {
      const began = performance.now(); upload.finish(); await delay(100);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000); expect(await pending(upload.result)).toBe(true);
      await held.release(); expect(await upload.result).toBe(200);
      if (kind === 'title') expect(keeper.prepare('SELECT label FROM conversations WHERE id = ?').get(t.conversation)).toEqual({ label: 'Label after recovery' });
      else expect(JSON.parse(upload.text()).thread.project).toBe('lock-project');
    } finally { await held.release(); keeper.close(); }
  }, 20_000);

  it('the Comms sweep waits for its words store and expires old words after release', async () => {
    const t = await open();
    const path = join(h.home, COMMS_DB), db = new BetterSqlite3(path);
    db.prepare("UPDATE comms_messages SET at = '2020-01-01T00:00:00Z' WHERE thread = ?").run(t.id); db.close();
    const held = await hold(path, 'exclusive');
    try {
      const began = performance.now();
      handle.setBackgroundActive(false); handle.setBackgroundActive(true);
      expect((await fetch(`${base}/login`)).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      await held.release();
      await expect.poll(() => {
        const check = new BetterSqlite3(path);
        try { return check.prepare('SELECT COUNT(*) AS n FROM comms_messages WHERE thread = ? AND text IS NOT NULL').get(t.id); }
        finally { check.close(); }
      }).toEqual({ n: 0 });
    } finally { await held.release(); }
  }, 20_000);

  it('a refs backfill cancelled during its first wait never marks itself done', async () => {
    const index = new BetterSqlite3(join(h.home, HOUSEHOLD_DB));
    index.prepare("DELETE FROM comms_meta WHERE key = 'refs_backfilled'").run(); index.close();
    const held = await hold(join(h.home, COMMS_DB), 'exclusive');
    let active = true;
    try {
      const backfill = backfillRefs(h, process.env, new Date(), () => active);
      await delay(100); expect(await pending(backfill)).toBe(true);
      active = false;
      await held.release();
      expect(await backfill).toBe(0);
      expect(backfilled(h.home)).toBe(false);
    } finally { active = false; await held.release(); }
  }, 20_000);

  it('refs backfill cancelled after decryption writes neither refs nor its completion marker', async () => {
    await open('late cancel t-4343');
    const index = new BetterSqlite3(join(h.home, HOUSEHOLD_DB));
    index.prepare("DELETE FROM comms_meta WHERE key = 'refs_backfilled'").run(); index.prepare('DELETE FROM comms_refs').run(); index.close();
    let active = true;
    const original = comms.messagesOf;
    const source = vi.spyOn(comms, 'messagesOf').mockImplementation(async (...args) => {
      const messages = await original(...args);
      active = false; // The listener closes during its asynchronous decryption.
      return messages.map((m) => ({ ...m, text: 'late cancel t-4343' }));
    });
    try {
      await backfillRefs(h, process.env, new Date(), () => active);
      const check = new BetterSqlite3(join(h.home, HOUSEHOLD_DB));
      try { expect(check.prepare('SELECT COUNT(*) AS n FROM comms_refs').get()).toEqual({ n: 0 }); }
      finally { check.close(); }
      expect(backfilled(h.home)).toBe(false);
    } finally { source.mockRestore(); }
  });

  it('a failed probe never becomes a failed sign-in', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { expect(await waitForLocks({ files: [{ path: 'test-probe-error', held: () => { throw new Error('probe unavailable'); } }] })).toBe(false); }
    finally { error.mockRestore(); }
    const original = lockGate.waitForLocks;
    const probe = vi.spyOn(lockGate, 'waitForLocks').mockImplementation((w) => w.files?.some((f) => f.path === join(h.home, 'ui-sessions.lock')) ? Promise.resolve(false) : original(w));
    try {
      const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.jonathan }), redirect: 'manual' });
      expect(r.status).toBe(303); expect(r.headers.has('set-cookie')).toBe(true);
    } finally { probe.mockRestore(); }
  });

  it('a spent async budget still runs the original synchronous sign-in wait', async () => {
    const lock = join(h.home, 'ui-sessions.lock');
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs'); const lock = process.argv[1];
      fs.writeFileSync(lock, String(process.pid)); console.log('held');
      process.stdin.once('data', () => setTimeout(() => { fs.rmSync(lock, {force:true}); process.exit(0); }, 250));
      setTimeout(() => { fs.rmSync(lock, {force:true}); process.exit(2); }, 15000).unref();
    `, lock], { stdio: 'pipe' });
    await once(holder.stdout, 'data');
    const original = lockGate.waitForLocks;
    let expired = false;
    const probe = vi.spyOn(lockGate, 'waitForLocks').mockImplementation(async (w) => {
      const free = await original(w);
      if (!free && w.files?.some((f) => f.path === lock)) { expired = true; holder.stdin.end('release'); }
      return free;
    });
    try {
      const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.jonathan }), redirect: 'manual' });
      expect(expired).toBe(true);
      expect(existsSync(lock)).toBe(false); // The child releases 250 ms after expiry: a bypass would answer with it still held.
      expect(r.status).toBe(303); expect(r.headers.has('set-cookie')).toBe(true);
    } finally { probe.mockRestore(); holder.kill(); rmSync(lock, { force: true }); }
  }, 20_000);

  it('a maintenance pass delayed by a lock does not write after its listener closes', async () => {
    const db = openAuditDb(h.home);
    db.prepare('INSERT OR REPLACE INTO audit_entries VALUES (?, ?, ?, ?, ?, ?, ?)').run('art', 'cv-cancelled', 1, 'loom', 'message', '2020-01-01T00:00:00Z', Buffer.from('expired'));
    db.close();
    const held = await hold(join(h.home, AUDIT_DB), 'exclusive');
    let other: HttpServeHandle | undefined;
    try {
      other = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
      expect(pendingLockWaits()).toBeGreaterThan(0);
      await other.close(); other = undefined;
      await held.release();
      await delay(100);
      const check = new BetterSqlite3(join(h.home, AUDIT_DB));
      try { expect(check.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE conversation = 'cv-cancelled'").get()).toEqual({ n: 1 }); }
      finally { check.close(); }
    } finally { await held.release(); await other?.close(); }
  }, 20_000);

});
