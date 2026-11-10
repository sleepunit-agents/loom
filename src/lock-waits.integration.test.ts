/**
 * Lock waits off the event loop (lock-gate.ts; t-2130, t-2141), through the server: while another process holds a
 * Comms database (a write lock, or a WAL recovery in progress), a Comms post, a live update and a turn record wait and
 * then succeed, and /login answers at once meanwhile. The same for household.json's and the sessions file's locks.
 * #776 failed these posts at once instead ("comms/adapter: unavailable", SQLITE_BUSY_RECOVERY): never again.
 * Needs `age` (CI installs it) and python3 (to hold a recovery's locks, as SQLite's own recovery does).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { parseLoomBlock, runtimePieces } from './cli/pieces-managed.js';
import { createConversationTables } from './backends/conversations.js';
import { COMMS_DB } from './comms.js';
import { HOUSEHOLD_DB } from './household-store.js';
import { waitForLocks } from './lock-gate.js';
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
  const open = async () => {
    const r = await fetch(`${base}/comms/new`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` },
      body: JSON.stringify({ agent: 'art', id: mid(n++), text: 'hello' }) });
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
});
