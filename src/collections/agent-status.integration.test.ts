/**
 * Each agent's card as a live record (t-2028): core's `agent-status` type is Home's own cards (handler.ts agentCards
 * over the member's pieces, atWorkFor), made for each viewer, so the desktop's cards, the rail's boxes of running jobs
 * (t-2077) and Home read one set. Pinned here, through the real HTTP server with a stub runtime piece:
 *
 *  - parity: for a household owner and an owner of one agent, the records are exactly Home's `cards` (GET /), field for
 *    field;
 *  - scope: a job in a member's Comms thread is theirs alone (another owner of the same agent never gets it, nor its
 *    title); an agent owner never gets another agent's card;
 *  - live: a job that starts reaches a live subscription as a change of that agent's record, and `running` counts it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { createConversationTables } from '../backends/conversations.js';
import { openThread } from '../comms.js';
import { nudge } from './pull.js';
import { clearPieceCache } from '../ui/pieces.js';
import { stopCommsWatch } from '../ui/comms-live.js';
import { closeAllBackends } from '../backends/index.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

// The runtime's manifest: each agent's report, from a file the test writes (its `agents` section, docs/extensions.md).
const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2).filter((x) => x !== '--json');
if (a[0] === 'ui' && a.length === 1) {
  let agents = {};
  try { agents = JSON.parse(fs.readFileSync(process.env.LOOM_HOME + '/runtime-agents.json', 'utf-8')); } catch {}
  const scope = process.env.LOOM_OWNER_SCOPE ? process.env.LOOM_OWNER_SCOPE.split(',') : null;
  if (scope) agents = Object.fromEntries(Object.entries(agents).filter(([k]) => scope.includes(k)));
  console.log(JSON.stringify({ v: 2, owners: 2, tab: { label: 'Boxes', kind: 'setting' }, asks: [], agents }));
} else process.exit(2);
`;

function piece(home: string, name: string, raw: Record<string, unknown>, src: string): void {
  const loom = parseLoomBlock(raw, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(loom);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  writeFileSync(join(dir, 'current', 'cli'), src);
  chmodSync(join(dir, 'current', 'cli'), 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(join(dir, 'current', 'cli'), join(home, 'pieces', 'bin', `loom-${name}`));
}

interface Frame { event: string; data: Record<string, unknown> }
async function openEvents(base: string, token: string): Promise<{ frames: Frame[]; stop: () => void; hello: Record<string, unknown> }> {
  const ac = new AbortController();
  const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
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
const until = async (f: () => boolean, ms = 6000) => { for (let t = 0; t < ms / 25 && !f(); t++) await new Promise((r) => setTimeout(r, 25)); return f(); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;
const SPEC = { type: 'loom/agent-status@^1', order: [['agent', 'asc']], limit: 100 };
const since = '2026-11-10T08:00:00.000Z';

describe.skipIf(!hasAge)('agent-status records: Home\'s cards, one set for every view (t-2028)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const streams: Array<{ stop: () => void }> = [];
  const saved = process.env.LOOM_HOME;
  let mine: { id: string; conversation: string };

  const report = (extra: Record<string, unknown> = {}) => writeFileSync(join(h.home, 'runtime-agents.json'), JSON.stringify({
    art: { state: 'working', reason: 'On two things', readings: [{ label: 'Next', value: '09:00', detail: 'morning lane' }, { label: 'Box', value: 'down', tone: 'bad' }],
      doing: [{ text: 'Working in a conversation', kind: 'talk', conversation: mine.conversation, since }],
      jobs: [
        { id: 'job-thread', text: 'Working in a conversation', kind: 'talk', status: 'running', conversation: mine.conversation, since },
        { id: 'job-lane', text: 'Morning lane', kind: 'lane', status: 'running', where: 'wake', since },
        { id: 'job-next', text: 'Evening lane', kind: 'lane', status: 'scheduled', at: '2026-11-10T20:00:00.000Z' },
      ] },
    mark: { state: 'available', readings: [], jobs: [] },
    ...extra,
  }));

  beforeEach(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-agent-status-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
      createConversationTables(db);
      db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] }));
    piece(home, 'runtime', { role: 'runtime' }, RUNTIME_BIN);
    h = loadHousehold(home)!;
    process.env.LOOM_HOME = h.home;
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'cccccccccccccccc', text: 'Is the build green?' });
    mine = o.thread;
    report();
    clearPieceCache();
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    for (const s of streams.splice(0)) s.stop();
    stopCommsWatch();
    await handle.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  const home = async (who: string): Promise<Data> => (await fetch(`${base}/`, { headers: { authorization: `Bearer ${tok[who]}`, accept: 'application/json' } })).json();
  const ask = async (who: string, q: Record<string, unknown> = {}): Promise<Data> => {
    // Home first: it registers the Inbox's and the cards' code for this household (as any page does).
    const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[who]}` },
      body: JSON.stringify({ queries: [{ id: 'q', ...SPEC, ...q }] }) });
    return ((await r.json()) as { answers: Data[] }).answers[0];
  };
  /** A record as Home's card: its key's id is the card's id; `running` and `agent` are the record's own. */
  const asCard = (r: Data) => { const { key, agent: _a, running: _r, ...rest } = r; return { id: key.split('/')[2], ...rest }; };
  // The cards' times ("Last seen 3 min ago") are made when asked: the same within a test's second.
  const strip = (c: Data) => JSON.parse(JSON.stringify(c));

  it('holds exactly Home\'s cards, for a household owner and an owner of one agent', async () => {
    for (const who of ['jonathan', 'sam']) {
      const page = await home(who);
      const a = await ask(who);
      expect(a.error, who).toBeUndefined();
      expect(a.coverage.complete, who).toBe(true);
      expect((a.rows as Data[]).map(asCard).map(strip), who).toEqual((page.home.cards as Data[]).map(strip));
    }
    const sam = await ask('sam');
    expect((sam.rows as Data[]).map((r) => r.agent)).toEqual(['art']);
    const jon = (await ask('jonathan')).rows as Data[];
    const art = jon.find((r) => r.agent === 'art');
    expect(art.running).toBe(2);
    expect(art.jobs.map((j: Data) => j.id).sort()).toEqual(['job-lane', 'job-next', 'job-thread']);
    // The Comms thread's job is jonathan's: sam (another owner of art) gets neither it nor its thread.
    const samArt = (sam.rows as Data[])[0];
    expect(samArt.jobs.map((j: Data) => j.id).sort()).toEqual(['job-lane', 'job-next']);
    expect(JSON.stringify(sam.rows)).not.toContain(mine.id.replace(/^th:/, ''));
    expect(samArt.running).toBe(1);
  });

  it('a job that starts reaches a live subscription as its agent\'s change; sam never hears a thread of jonathan\'s', async () => {
    await home('jonathan');
    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    const sam = await openEvents(base, tok.sam); streams.push(sam);
    expect((await ask('jonathan', { subscribe: true, stream: jon.hello.stream })).error).toBeUndefined();
    expect((await ask('sam', { subscribe: true, stream: sam.hello.stream })).error).toBeUndefined();
    report({ mark: { state: 'working', readings: [], jobs: [{ id: 'job-mark', text: 'Tidying the notes', kind: 'lane', status: 'running', since }] } });
    clearPieceCache();
    const t0 = Date.now();
    nudge(h.home, 'loom/agent-status');
    const key = 'loom/agent-status/mark';
    expect(await until(() => jon.frames.some((f) => f.event === 'rows' && ((f.data.upserts as Data[]) ?? []).some((u) => u.key === key && u.running === 1)))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4_000);
    // sam owns art only: mark's card never reaches them.
    await new Promise((r) => setTimeout(r, 300));
    expect(sam.frames.some((f) => JSON.stringify(f.data).includes('agent-status/mark'))).toBe(false);
    expect(JSON.stringify(sam.frames)).not.toContain(mine.id.replace(/^th:/, ''));
  }, 30_000);
});
