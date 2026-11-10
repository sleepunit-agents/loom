/**
 * A live-shaped smoke for lock waits (t-2130): Comms posts through a real server while another process keeps taking
 * Comms' and household.db's write locks, on a scratch COPY of a household's databases. Never the live files: the
 * live databases are only read, through SQLite's backup API; everything written goes to a fresh temporary home,
 * removed after. Fresh tokens and a fresh Comms key are made for the copy; no secret is copied.
 *
 *   node --import tsx scripts/lock-smoke.ts --home <a household's home> [--posts 50] [--hold-ms 400] [--gap-ms 200]
 *   node --import tsx scripts/lock-smoke.ts --synthetic        (a made-up household, for a machine without one)
 *
 * The writer alternates between the two databases: a hold of 20 to --hold-ms, a pause of up to --gap-ms, and every
 * tenth hold 2 s (the stalls seen live were 3.8 to 6.7 s). --gap-ms 30 is a hostile writer, holding nearly always.
 *
 * Prints one JSON line: failures (must be 0), post latencies, /login latencies and the event loop's worst delay.
 * Needs `age` (Comms encrypts each post). Exits 1 on any failed post.
 */
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer } from '../src/transport/http-server.js';
import { agentDir, createToken, loadHousehold } from '../src/household.js';
import { parseLoomBlock, runtimePieces } from '../src/cli/pieces-managed.js';
import { createConversationTables } from '../src/backends/conversations.js';
import { COMMS_DB } from '../src/comms.js';
import { HOUSEHOLD_DB } from '../src/household-store.js';
import { stopCommsWatch } from '../src/ui/comms-live.js';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const live = arg('home');
const synthetic = process.argv.includes('--synthetic');
const POSTS = Number(arg('posts') ?? 50);
const HOLD_MS = Number(arg('hold-ms') ?? 400);
const GAP_MS = Number(arg('gap-ms') ?? 200);
if (!live === !synthetic) { console.error('usage: lock-smoke.ts --home <household home> | --synthetic'); process.exit(2); }

const scratch = mkdtempSync(join(tmpdir(), 'loom-lock-smoke-'));
chmodSync(scratch, 0o700);

/** A consistent copy of one live database, read through the backup API (the live file is never written). */
async function copyDb(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  const src = new BetterSqlite3(from, { readonly: true, fileMustExist: true, timeout: 5000 });
  try { await src.backup(to); } finally { src.close(); }
}

async function copyHousehold(home: string): Promise<string[]> {
  const root = realpathSync(resolve(home));
  if (realpathSync(scratch).startsWith(root + '/')) throw new Error('the scratch home must not be inside the live one');
  copyFileSync(join(root, 'household.json'), join(scratch, 'household.json'));
  await copyDb(join(root, HOUSEHOLD_DB), join(scratch, HOUSEHOLD_DB));
  await copyDb(join(root, COMMS_DB), join(scratch, COMMS_DB));
  const agents = (JSON.parse(String(await import('node:fs').then((fs) => fs.readFileSync(join(root, 'household.json'), 'utf-8')))) as { agents: string[] }).agents;
  for (const a of agents) {
    const from = join(root, 'agents', a), to = join(scratch, 'agents', a);
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(from)) if (f === 'IDENTITY.md') copyFileSync(join(from, f), join(to, f));
    await copyDb(join(from, 'memories.db'), join(to, 'memories.db'));
  }
  return agents;
}

function makeHousehold(): string[] {
  mkdirSync(join(scratch, 'agents', 'art'), { recursive: true });
  writeFileSync(join(scratch, 'agents', 'art', 'IDENTITY.md'), '# art\n');
  const mem = new BetterSqlite3(join(scratch, 'agents', 'art', 'memories.db'));
  createConversationTables(mem);
  mem.close();
  writeFileSync(join(scratch, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  return ['art'];
}

/** A stand-in runtime piece: it takes deliveries and answers at once, so the copy reaches no real runtime. */
function fakeRuntime(): void {
  const loom = parseLoomBlock({ role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'] }, 'runtime', ['loom-runtime']);
  if (typeof loom === 'string') throw new Error(loom);
  const dir = join(scratch, 'pieces', 'runtime');
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name: 'runtime', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'runtime', version: '1', installed: 'x',
    bins: ['loom-runtime'], loom: { settings: [], services: [], ...loom } }));
  writeFileSync(join(dir, 'current', 'cli'), `#!${process.execPath}\nlet i='';process.stdin.on('data',(d)=>{i+=d});process.stdin.on('end',()=>console.log(JSON.stringify({conversation:'cv-0123456789ab',seq:1,body:'started'})));\n`);
  chmodSync(join(dir, 'current', 'cli'), 0o755);
  mkdirSync(join(scratch, 'pieces', 'bin'), { recursive: true });
  symlinkSync(join(dir, 'current', 'cli'), join(scratch, 'pieces', 'bin', 'loom-runtime'));
}

/** Another process taking the copy's write locks over and over (see the top), until told to stop. */
function writer(): { stop: () => Promise<{ holds: number }> } {
  const child = spawn(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const [hh, comms, holdMs, gapMs] = [process.argv[1], process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
    let holds = 0, stop = false;
    process.stdin.once('data', () => { stop = true; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      while (!stop) {
        const path = holds % 2 ? hh : comms;
        const db = new Database(path, { timeout: 10000 });
        db.exec('CREATE TABLE IF NOT EXISTS lock_smoke (n INTEGER)');
        db.exec(path === comms ? 'BEGIN EXCLUSIVE' : 'BEGIN IMMEDIATE');
        db.prepare('INSERT INTO lock_smoke VALUES (?)').run(holds);
        await sleep(holds % 10 === 9 ? 2000 : 20 + Math.random() * (holdMs - 20));
        db.exec('COMMIT');
        db.close();
        holds++;
        await sleep(Math.random() * gapMs);
      }
      console.log(JSON.stringify({ holds }));
    })();
  `, join(scratch, HOUSEHOLD_DB), join(scratch, COMMS_DB), String(HOLD_MS), String(GAP_MS)], { stdio: ['pipe', 'pipe', 'inherit'], cwd: process.cwd() });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  return {
    stop: async () => {
      child.stdin.end('stop\n');
      await new Promise((r) => child.once('exit', r));
      return JSON.parse(out.trim() || '{"holds":0}') as { holds: number };
    },
  };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0); };

async function main(): Promise<number> {
  const agents = live ? await copyHousehold(live) : makeHousehold();
  process.env.LOOM_HOME = scratch;
  fakeRuntime();
  const h = loadHousehold(scratch)!;
  const owner = (h.members ?? [])[0]?.person ?? 'jonathan';
  const ownerTok = createToken(h, { role: { kind: 'owner', member: owner }, label: 'lock-smoke' }).token;
  const runtimeTok = createToken(h, { role: { kind: 'runtime', piece: 'runtime' }, label: 'lock-smoke-runtime', runtimePieces: runtimePieces(process.env) }).token;
  const handle = await startHttpServer({ contextDir: agentDir(h, h.default ?? agents[0]), host: '127.0.0.1', port: 0, household: h });
  const base = `http://127.0.0.1:${handle.port}`;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  try {
    // One thread of the owner's, opened on the copy before the writer starts.
    const opened = await fetch(`${base}/comms/new`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${ownerTok}` },
      body: JSON.stringify({ agent: h.default ?? agents[0], id: `a${'b'.repeat(15)}`, text: 'lock smoke' }) });
    if (opened.status !== 200) throw new Error(`couldn't open a thread on the copy: ${opened.status} ${await opened.text()}`);
    const t = ((await opened.json()) as { thread: { id: string; agent?: string } }).thread;
    const agent = h.default ?? agents[0];
    await delay(500);
    const w = writer();
    loop.enable();
    const logins: number[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const began = performance.now();
        const r = await fetch(`${base}/login`);
        await r.arrayBuffer();
        logins.push(performance.now() - began);
        await delay(50);
      }
    })();
    const posts = await Promise.all(Array.from({ length: POSTS }, async (_, i) => {
      await delay(i * 40);
      const began = performance.now();
      const r = await fetch(`${base}/api/loom/comms/adapter`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${runtimeTok}` },
        body: JSON.stringify({ op: 'post', place: t.id, agent, text: `lock smoke ${i}` }) });
      const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; reason?: string };
      return { ok: r.status === 200 && body.ok === true, status: r.status, error: body.error ?? body.reason, ms: performance.now() - began };
    }));
    polling = false;
    await poller;
    const { holds } = await w.stop();
    loop.disable();
    const failed = posts.filter((p) => !p.ok);
    const report = {
      source: live ? 'copy' : 'synthetic', posts: posts.length, failures: failed.length, failed: failed.slice(0, 5).map((p) => `${p.status} ${p.error ?? ''}`),
      writer: { holds, holdMs: HOLD_MS, gapMs: GAP_MS }, postMs: { p50: pct(posts.map((p) => p.ms), 0.5), p95: pct(posts.map((p) => p.ms), 0.95), max: pct(posts.map((p) => p.ms), 1) },
      loginMs: { n: logins.length, p50: pct(logins, 0.5), max: pct(logins, 1) }, loopDelayMaxMs: Math.round(loop.max / 1e6),
    };
    console.log(JSON.stringify(report));
    return failed.length ? 1 : 0;
  } finally {
    stopCommsWatch();
    await handle.close();
  }
}

main().then((code) => { rmSync(scratch, { recursive: true, force: true }); process.exit(code); }, (e) => {
  console.error(e);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
