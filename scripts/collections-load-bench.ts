/** House-only synthetic runtime traffic + real live subscriptions. No production stores or network endpoints. */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const mode = process.argv[2] ?? 'server';
const seconds = Number(process.env.BENCH_SECONDS ?? 60);
const streams = Number(process.env.BENCH_STREAMS ?? 6);
const houses = Number(process.env.BENCH_HOUSES ?? 8);
const listeners = Number(process.env.BENCH_LISTENERS ?? 1);
const episodes = Number(process.env.BENCH_EPISODES ?? 300);
for (const [name, value, min, max] of [['STREAMS', streams, 1, 64], ['HOUSES', houses, 0, 64], ['LISTENERS', listeners, 1, 3], ['EPISODES', episodes, 0, 10_000]] as const) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`BENCH_${name} must be ${min}..${max}`);
}
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) throw Error('BENCH_SECONDS must be 5..600');

if (mode === 'load') {
  const cfg = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const counts: Record<string, number> = {};
  let failed = 0, frames = 0;
  const pending = new Set<Promise<unknown>>();
  const aborts: AbortController[] = [];
  const post = async (path: string, token: string, body: unknown) => {
    counts[path] = (counts[path] ?? 0) + 1;
    try {
      const r = await fetch(cfg.base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const answer = await r.json();
      if (!r.ok) { failed++; if (failed < 5) console.error(path, r.status, answer); }
      return answer;
    } catch (e) { failed++; console.error(String(e)); return undefined; }
  };
  const run = (p: Promise<unknown>) => { pending.add(p); void p.finally(() => pending.delete(p)); };
  for (let s = 0; s < streams; s++) {
    const abort = new AbortController(); aborts.push(abort);
    const eventBase = cfg.bases?.[s < streams / 2 ? 0 : 1 + (s % (cfg.bases.length - 1))] ?? cfg.base;
    const r = await fetch(eventBase + '/events', { headers: { authorization: `Bearer ${cfg.owner}` }, signal: abort.signal });
    if (!r.ok) throw Error(`events ${r.status}`);
    const reader = r.body!.getReader();
    const dec = new TextDecoder(); let buf = '';
    let hello!: (v: string) => void;
    const ready = new Promise<string>(resolve => { hello = resolve; });
    void (async () => {
      try { for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, nl); buf = buf.slice(nl + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          if (event === 'hello' && raw) hello(JSON.parse(raw).stream);
          if (event === 'rows') frames++;
        }
      } } catch { /* stopped */ }
    })();
    const stream = await ready;
    const queries = [
      { id: 'status', type: 'loom/agent-status@^1', fields: ['agent', 'state', 'reason', 'jobs', 'steps', 'activity'], order: [['agent', 'asc']], limit: 100 },
      { id: 'attention', type: 'loom/attention@^1', fields: ['agent', 'text', 'kind', 'box'], order: [['sort', 'desc']], limit: 500 },
      { id: 'threads', type: 'loom/thread@^1', fields: ['agent', 'title', 'updated', 'unread', 'working'], order: [['updated', 'desc']], limit: 200 },
    ].map(q => ({ ...q, stream, subscribe: true }));
    const queryResponse = await fetch(eventBase + '/collections/query', { method: 'POST', headers: { authorization: `Bearer ${cfg.owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ queries }) });
    const got = await queryResponse.json();
    counts['/collections/query'] = (counts['/collections/query'] ?? 0) + 1;
    if (!got?.answers?.every((a: { error?: string }) => !a.error)) throw Error(JSON.stringify(got));
  }
  const timers: NodeJS.Timeout[] = [];
  for (let h = 0; h < houses; h++) {
    timers.push(setInterval(() => {
      run(post('/api/runtime/poll', cfg.agent, { house: `h-${h}`, box: `b-${h}`, facts: { cpu: 8, memory: 16384 } }));
      run(post('/api/runtime/body-sync', cfg.agent, { house: `h-${h}`, run: `r-${h}`, state: 'working', observedAt: new Date().toISOString() }));
    }, 2000 + h * 11));
    timers.push(setInterval(() => run(post('/api/runtime/usage', cfg.agent, { house: `h-${h}` })), 10_000));
  }
  // The runtime's manifest changed notifications, not collection hints invented by this bench.
  timers.push(setInterval(() => run(post('/api/loom/pieces/changed', cfg.runtime, {})), 2000));
  if (process.env.BENCH_KEYED === '1') timers.push(setInterval(() => run(post('/api/loom/collections/nudge', cfg.owner, { domain: 'loom/agent-status', key: 'art' })), 1100));
  writeFileSync(cfg.ready, 'ready');
  await delay((seconds + 10) * 1000);
  for (const timer of timers) clearInterval(timer);
  await Promise.allSettled([...pending]);
  for (const abort of aborts) abort.abort();
  writeFileSync(cfg.result, JSON.stringify({ counts, failed, frames }));
} else if (mode === 'peer') {
  const cfg = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  process.env.LOOM_HOME = cfg.home;
  process.env.PATH = `${join(cfg.home, 'pieces', 'bin')}:${process.env.PATH}`;
  const { startHttpServer } = await import('../src/transport/http-server.js');
  const { loadHousehold, agentDir } = await import('../src/household.js');
  const h = loadHousehold(cfg.home)!;
  const server = await startHttpServer({ contextDir: agentDir(h, 'art'), household: h, host: '127.0.0.1', port: 0 });
  writeFileSync(cfg.ready, JSON.stringify({ base: `http://127.0.0.1:${server.port}`, pid: process.pid }));
  process.on('message', () => { void server.close().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), (seconds + 60) * 1000).unref();
} else {
  const [{ startHttpServer }, { loadHousehold, createToken, agentDir }, { parseLoomBlock }, { default: Database }, { createConversationTables }, handler] = await Promise.all([
    import('../src/transport/http-server.js'), import('../src/household.js'), import('../src/cli/pieces-managed.js'), import('better-sqlite3'), import('../src/backends/conversations.js'), import('../src/ui/handler.js'),
  ]);
  const home = mkdtempSync(join(tmpdir(), 'loom-cpu-bench-'));
  process.env.LOOM_HOME = home;
  let connections = 0;
  const originalClose = Database.prototype.close;
  Database.prototype.close = function() {
    if (this.name === join(home, 'collections', 'live.db')) connections++;
    return originalClose.call(this);
  };
  process.env.LOOM_MEMORY_BACKEND = 'filesystem';
  const agents = ['art', 'mark', 'helper'];
  for (const a of agents) {
    const dir = join(home, 'agents', a); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'IDENTITY.md'), `# ${a}\n`);
    const { createBackend } = await import('../src/backends/index.js');
    createBackend(dir);
    const db = new Database(join(dir, 'memories.db'));
    createConversationTables(db);
    const insert = db.prepare('INSERT INTO memories (uuid, ref, title, category, metadata, content, created) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)');
    db.transaction(() => { for (let n = 0; n < episodes; n++) insert.run(`episode/${n}`, `Bench observation ${n}`, 'episode', JSON.stringify({ where: 'terminal:bench' }), 'Read a file. '.repeat(80), new Date(Date.now() - n * 60_000).toISOString()); })();
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents, default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] }));
  const piece = join(home, 'pieces', 'runtime'); mkdirSync(join(piece, 'current'), { recursive: true }); mkdirSync(join(home, 'pieces', 'bin'));
  const bin = join(piece, 'current', 'cli');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const stamp = () => {try{return fs.readFileSync(process.env.LOOM_HOME+'/runtime-tick','utf8')}catch{return 'initial'}};
const manifest = () => ({v:2, owners:2, tab:{label:'Runtime',kind:'setting'}, asks:[], agents:Object.fromEntries(['art','mark','helper'].map(a=>[a,{state:'working',reason:'Bench work '+stamp(),readings:[],jobs:Array.from({length:16},(_,i)=>({id:a+'-'+i,text:'House '+i,kind:'talk',status:'running',since:'2026-11-11T10:00:00Z'}))}]))});
if(process.argv[2]==='ui') { console.log(JSON.stringify(manifest())); process.exit(0); }
const answer = r => {if(r.path==='body-sync')fs.writeFileSync(process.env.LOOM_HOME+'/runtime-tick',String(Date.now()));return {status:200,body:{ok:true,path:r.path},changed:r.path!=='usage'}};
if(process.argv.includes('--serve')) readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,exit:0,stdout:JSON.stringify(answer(m.request))})+'\\n')});
else {let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(answer(JSON.parse(s)))))}
`);
  chmodSync(bin, 0o755); symlinkSync(bin, join(home, 'pieces', 'bin', 'loom-runtime'));
  const loom = parseLoomBlock({ role: 'runtime', api_serve: ['poll', 'body-sync', 'usage'] }, 'runtime', ['loom-runtime']); if (typeof loom === 'string') throw Error(loom);
  writeFileSync(join(piece, 'piece.json'), JSON.stringify({ v: 1, name: 'runtime', source: { repo: 'sleepunit-agents/loom-box', commit: 'a'.repeat(40) }, package: 'runtime', version: '1', installed: 'bench', bins: ['loom-runtime'], loom: { settings: [], services: [], ...loom } }));
  process.env.PATH = `${join(home, 'pieces', 'bin')}:${process.env.PATH}`;
  const h = loadHousehold(home)!;
  const owner = createToken(h, { role: { kind: 'owner' }, label: 'bench-owner' }).token;
  const agent = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'bench-agent' }).token;
  const runtime = createToken(h, { role: { kind: 'runtime', piece: 'runtime' }, label: 'bench-runtime', runtimePieces: ['runtime'] }).token;
  const server = await startHttpServer({ contextDir: agentDir(h, 'art'), household: h, host: '127.0.0.1', port: 0 });
  const bases = [`http://127.0.0.1:${server.port}`];
  const peers: ReturnType<typeof spawn>[] = [];
  for (let i = 1; i < listeners; i++) {
    const peerConfig = join(home, `peer-${i}.json`), ready = join(home, `peer-${i}-ready.json`);
    writeFileSync(peerConfig, JSON.stringify({ home, ready }));
    const peer = spawn(process.execPath, ['--import', 'tsx', process.argv[1], 'peer', peerConfig], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    peers.push(peer);
    const deadline = Date.now() + 10_000;
    for (;;) { try { bases.push(JSON.parse(readFileSync(ready, 'utf8')).base); break; } catch { if (Date.now() >= deadline) throw Error('peer start timed out'); await delay(20); } }
  }
  const config = join(home, 'bench.json'); const result = join(home, 'load.json');
  writeFileSync(config, JSON.stringify({ base: bases[0], bases, owner, agent, runtime, result, ready: join(home, 'load-ready') }), { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', 'tsx', process.argv[1], 'load', config], { stdio: ['ignore', 'inherit', 'inherit'] });
  const childDone = new Promise<number | null>(resolve => child.on('exit', resolve));
  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    try { readFileSync(join(home, 'load-ready')); break; } catch {
      if (child.exitCode !== null || Date.now() > readyDeadline) {
        child.kill('SIGTERM'); for (const peer of peers) peer.kill('SIGTERM');
        throw Error('load did not finish subscription setup');
      }
      await delay(20);
    }
  }
  // All subscriptions exist before the warmup and the measured interval.
  await delay(8000);
  const initialConnections = connections;
  const cpu = process.cpuUsage(); const began = performance.now();
  const builds = { status: handler.agentStatusBuilds(home), attention: handler.attentionBuilds(home) };
  await delay(seconds * 1000);
  const used = process.cpuUsage(cpu); const elapsed = performance.now() - began;
  const output = { seconds: elapsed / 1000, cpuPercent: (used.user + used.system) / (elapsed * 10), streams, houses, listeners, liveDbConnections: connections - initialConnections, episodes,
    builds: { status: handler.agentStatusBuilds(home) - builds.status, attention: handler.attentionBuilds(home) - builds.attention } };
  console.log(JSON.stringify(output));
  const exit = await childDone;
  if (exit !== 0) { for (const peer of peers) peer.kill('SIGTERM'); throw Error(`load exited ${exit}`); }
  console.log(readFileSync(result, 'utf8'));
  await server.close();
  for (const peer of peers) peer.kill('SIGTERM');
  // Persistent background watcher state is process-owned; leave the isolated fixture for diagnosis.
  process.exit(0);
}
