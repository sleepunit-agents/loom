/**
 * How often core runs a snapshot provider's `collections query` (t-2110), the way loom's machine is set up: the tasks
 * piece (`tasks/task`, ~2,100 records) and the Changes piece (`changes/change`, ~300), both without a change log, so
 * core keeps them current by snapshot (the bridge, pull.ts), 500 records a page. Two windows of one household owner
 * hold what a Tasks page holds (tasks-live.ts: open and recently moved, of each). Simulated minutes (the clock is moved,
 * the 15 s poll round is run by hand), real provider processes, counted by the stubs themselves.
 *
 * What's pinned: a quiet piece is pulled less often (five minutes, then stops when no real reader remains) and the windows' own queries are one run a
 * provider a window; a piece's word (an API call that wrote) still reaches both windows at once, and a write nobody
 * said anything about reaches them by the next slow consistency check.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { clearPieceCache } from '../ui/pieces.js';
import { clearOutOfContract } from './serve.js';
import { pullNowAll, pullSoon, pullsSettled, roundNow } from './subs.js';

vi.setConfig({ testTimeout: 120_000 });

// A snapshot provider: $LOOM_HOME/<name>.json is its store. Answers a batch as taskstore's and loom-changes' do (filtered
// before it pages, keyset pages by the order key and id), and counts its own runs in runs-<name>.
const PROVIDER_BIN = (name: string) => `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const ask = JSON.parse(s);
  fs.appendFileSync(home + '/runs-${name}', (ask.viewer && ask.viewer.kind) + '\\n');
  const all = JSON.parse(fs.readFileSync(home + '/${name}.json', 'utf-8'));
  const v = ask.viewer;
  const sees = v.kind === 'core' || (v.kind === 'member' && v.agents === '*');
  const cmp = (a, b) => (a === b ? 0 : a === undefined || a === null ? -1 : b === undefined || b === null ? 1 : a < b ? -1 : 1);
  const out = [];
  for (const q of ask.queries) {
    let rs = sees ? all.filter((r) => q.where.every(([f, op, val]) => op === 'eq' ? r[f] === val : op === 'in' ? val.includes(r[f]) : op === 'gte' ? r[f] >= val : true)) : [];
    const key = (r) => [...q.order.map(([f]) => r[f]), r.id];
    const by = (a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) { const c = cmp(ka[i], kb[i]); if (c) return i < q.order.length && q.order[i][1] === 'desc' ? -c : c; } return 0; };
    rs.sort(by);
    if (q.after) rs = rs.filter((r) => { const k = key(r); for (let i = 0; i < k.length; i++) { const c = cmp(k[i], q.after[i]); if (c) return (i < q.order.length && q.order[i][1] === 'desc' ? -c : c) > 0; } return false; });
    const page = rs.slice(0, q.limit);
    for (const r of page) { const o = { id: r.id, audience: r.audience }; for (const f of q.fields) if (f in r) o[f] = r[f]; out.push(JSON.stringify({ id: q.id, row: o })); }
    out.push(JSON.stringify({ id: q.id, more: rs.length > q.limit }));
  }
  process.stdout.write(out.join('\\n') + '\\n');
});
`;

const H = 'household';
const TASK = {
  version: '1.1', schema: { type: 'object' }, max_page: 500, aggregates: { count: {} },
  fields: { title: { class: H }, status: { class: H, filter: ['eq', 'in'], order: true }, updated: { class: H, filter: ['gte'], order: true }, created: { class: H, order: true } },
  default_fields: ['title', 'status'],
};
const CHANGE = {
  version: '1.0', schema: { type: 'object' }, max_page: 500, aggregates: { count: { by: ['state'] } },
  fields: { title: { class: H }, state: { class: H, filter: ['eq', 'in'], order: true }, updated: { class: H, filter: ['gte'], order: true } },
  default_fields: ['title', 'state'],
};

function piece(home: string, name: string, type: string, decl: unknown): void {
  const loom = parseLoomBlock({ collections: { query: [`loom-${name}`, 'collections', 'query', '--json'], types: { [type]: decl } } }, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(`${name}: ${loom}`);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: name === 'tasks' ? 'sleepunit-agents/taskstore' : 'sleepunit-agents/loom-changes', commit: 'a'.repeat(40) },
    package: name, version: '1', installed: 'x', bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, PROVIDER_BIN(name));
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  rmSync(join(home, 'pieces', 'bin', `loom-${name}`), { force: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

interface Frame { event: string; data: Record<string, unknown> }

async function openEvents(base: string, token: string): Promise<{ frames: Frame[]; stop: () => void; hello: Record<string, unknown> }> {
  const ac = new AbortController();
  const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
  if (r.status !== 200) throw new Error(`events: ${r.status}`);
  const frames: Frame[] = [];
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) frames.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  for (let t = 0; t < 100 && !frames.some((f) => f.event === 'hello'); t++) await new Promise((r) => setTimeout(r, 20));
  return { frames, stop: () => ac.abort(), hello: frames.find((f) => f.event === 'hello')!.data };
}

const until = async (f: () => boolean, ms = 4000) => { for (let t = 0; t < ms / 25 && !f(); t++) await new Promise((r) => setTimeout(r, 25)); return f(); };
const iso = (t: number) => new Date(t).toISOString();
const DAY = 86_400_000;

describe('snapshot providers are pulled once per freshness window (t-2110)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let token: string;
  const saved = process.env.LOOM_HOME;
  const streams: Array<{ stop: () => void }> = [];
  const T0 = Date.parse('2026-11-10T15:00:00Z');

  beforeAll(async () => {
    h = loadHousehold((() => {
      const home = mkdtempSync(join(tmpdir(), 'loom-pulls-'));
      mkdirSync(join(home, 'agents', 'art'), { recursive: true });
      writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# art\n');
      writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
      return home;
    })())!;
    process.env.LOOM_HOME = h.home;
    const pad = (n: number) => String(n).padStart(5, '0');
    // 2,100 tasks: 300 open, 200 of them moved in the last eight days; 300 changes, 40 open, 60 recent.
    writeFileSync(join(h.home, 'tasks.json'), JSON.stringify(Array.from({ length: 2100 }, (_, i) => ({
      id: `t-${pad(i)}`, audience: { owners: true }, title: `task ${i} ${'x'.repeat(120)}`, status: i < 300 ? 'open' : 'closed',
      created: iso(T0 - (2100 - i) * DAY / 10), updated: iso(i % 10 === 0 ? T0 - DAY : T0 - 30 * DAY - i),
    }))));
    writeFileSync(join(h.home, 'changes.json'), JSON.stringify(Array.from({ length: 300 }, (_, i) => ({
      id: `github:acme:app:${i}`, audience: { owners: true }, title: `change ${i}`, state: i < 40 ? 'open' : 'merged', updated: iso(i % 5 === 0 ? T0 - DAY : T0 - 40 * DAY - i),
    }))));
    piece(h.home, 'tasks', 'task', TASK);
    piece(h.home, 'changes', 'change', CHANGE);
    process.env.PATH = `${join(h.home, 'pieces', 'bin')}:${process.env.PATH}`;
    clearPieceCache();
    clearOutOfContract();
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    vi.useRealTimers();
    for (const s of streams) s.stop();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const runs = (name: string): string[] => existsSync(join(h.home, `runs-${name}`)) ? readFileSync(join(h.home, `runs-${name}`), 'utf-8').trim().split('\n').filter(Boolean) : [];
  const count = () => runs('tasks').length + runs('changes').length;

  /** A window as a Tasks page holds it (tasks-live.ts): open and recent tasks, open and recent changes, in one POST. */
  const window = async () => {
    const ev = await openEvents(base, token);
    streams.push(ev);
    const recent = iso(Date.now() - 8 * DAY);
    const queries = [
      { id: 'to', type: 'tasks/task@^1', where: [['status', 'in', ['open', 'in_progress']]], order: [['created', 'asc']], limit: 500, fields: ['title', 'status', 'updated'] },
      { id: 'tr', type: 'tasks/task@^1', where: [['updated', 'gte', recent]], order: [['updated', 'desc']], limit: 500, fields: ['title', 'status', 'updated'] },
      { id: 'co', type: 'changes/change@^1', where: [['state', 'eq', 'open']], order: [['updated', 'desc']], limit: 500, fields: ['title', 'state', 'updated'] },
      { id: 'cr', type: 'changes/change@^1', where: [['updated', 'gte', recent]], order: [['updated', 'desc']], limit: 500, fields: ['title', 'state', 'updated'] },
    ].map((q) => ({ ...q, subscribe: true, stream: ev.hello.stream }));
    const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ queries }) });
    const { answers } = (await r.json()) as { answers: Array<Record<string, unknown>> };
    for (const a of answers) expect(a, JSON.stringify(a)).toHaveProperty('rows');
    return ev;
  };
  const upserted = (ev: { frames: Frame[] }, key: string) => ev.frames.some((f) => f.event === 'rows' && (f.data.upserts as Array<{ key: string }> | undefined)?.some((u) => u.key === key));
  const write = (id: string, title: string) => {
    const all = JSON.parse(readFileSync(join(h.home, 'tasks.json'), 'utf-8')) as Array<Record<string, unknown>>;
    for (const t of all) if (t.id === id) { t.title = title; t.updated = iso(Date.now()); }
    writeFileSync(join(h.home, 'tasks.json'), JSON.stringify(all));
  };

  it('two windows, five quiet minutes: runs per minute, and a write still reaches both windows', async () => {
    // The clock and the listener's 15 s round are the test's (the round is run by hand, below); a pull's own gap timer
    // stays real, so the clock is moved in step with real waits where a gap matters.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: T0 });
    const a = await window();
    const b = await window();
    const opened = count();
    const has = (k: string) => upserted(a, k) && upserted(b, k);
    // Minute by minute: the poll round every 15 s, as the listener's timer runs it.
    const perMinute: number[] = [];
    let t = T0;
    const step = (ms: number) => { t += ms; vi.setSystemTime(t); };
    for (let m = 0; m < 5; m++) {
      const before = count();
      for (let r = 0; r < 4; r++) { step(15_000); await roundNow(h.home); }
      perMinute.push(count() - before);
    }
    process.stdout.write(`t-2110 bench: window opens ${opened} runs (${runs('tasks').filter((v) => v === 'member').length} tasks, ${runs('changes').filter((v) => v === 'member').length} changes); poll runs per minute ${perMinute.join(', ')}\n`);
    // The windows' own queries: one run a provider a window.
    expect(opened).toBe(4);
    // Quiet: one initial snapshot (six processes), then no provider processes for the rest of five minutes.
    expect(perMinute).toEqual([6, 0, 0, 0, 0]);

    // A write nobody said anything about (a local CLI's): by the next slow check, at most five minutes.
    // Run the due check, then write immediately after it: measure the full worst-case repair interval.
    step(15_000); await roundNow(h.home);
    await window(); // A real reader keeps the fallback active for the next five-minute check.
    write('t-00011', 'moved by hand');
    let seen = -1;
    // (Frames are on the wire when delivery's done: a moment for them to land.)
    for (let s = 1; s <= 20 && seen < 0; s++) { step(15_000); await roundNow(h.home); if (await until(() => has('tasks/task/t-00011'), 100)) seen = s * 15; }
    process.stdout.write(`t-2110 bench: an unannounced write reached both windows after ${seen} s\n`);
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBe(300);

    // A piece's word (an API call that wrote, pullPieceSoon): both windows have it at once, with no round, and it costs
    // one snapshot (its echo from the tick file is the same word).
    step(7_000);
    let was = runs('tasks').length;
    write('t-00007', 'moved by the API');
    pullSoon(h.home, ['tasks/task']);
    expect(await until(() => has('tasks/task/t-00007'))).toBe(true);
    await new Promise((r) => setTimeout(r, 2_500));
    await pullsSettled(h.home);
    const word = runs('tasks').length - was;
    process.stdout.write(`t-2110 bench: one word cost ${word} runs\n`);
    expect.soft(word).toBe(5);

    // An action on the piece's page (pullAfterAction): pulled before its answer, and that's the one pull (its nudge,
    // heard back from the tick file, is the same word).
    step(7_000);
    was = runs('tasks').length;
    write('t-00009', 'moved by an action');
    await pullNowAll(h.home, ['tasks/task']);
    expect(await until(() => has('tasks/task/t-00009'))).toBe(true);
    await new Promise((r) => setTimeout(r, 2_500));
    await pullsSettled(h.home);
    const acted = runs('tasks').length - was;
    process.stdout.write(`t-2110 bench: one action cost ${acted} runs\n`);
    expect.soft(acted).toBe(5);

    // A burst: a body writing through the API every half second for 6 s. The last write still reaches both windows; the
    // snapshots it costs are counted.
    step(15_000);
    was = runs('tasks').length;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      write(`t-000${20 + i}`, `burst ${i}`);
      last = performance.now();
      pullSoon(h.home, ['tasks/task']);
      await new Promise((r) => setTimeout(r, 500));
      step(500);
    }
    expect(await until(() => has('tasks/task/t-00031'), 10_000)).toBe(true);
    const landed = Math.round(performance.now() - last);
    await new Promise((r) => setTimeout(r, 1_000));
    await pullsSettled(h.home);
    const burst = runs('tasks').length - was;
    process.stdout.write(`t-2110 bench: a burst of 12 words in 6 s cost ${burst} runs; its last write reached both windows ${landed} ms after it\n`);
    expect.soft(burst).toBeLessThanOrEqual(20);
    expect.soft(landed).toBeLessThanOrEqual(5_000);
  });
});
