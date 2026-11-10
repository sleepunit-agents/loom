/**
 * An agent at work in a Comms thread, on its card and its window (t-1945; docs/extensions.md, "agents"): the runtime's
 * manifest is the one record of a body at work, whatever ran it (a Comms thread, a bridge, a wake, a house), and names
 * the conversation; loom says which thread and links it, for the thread's member only (comms.md, rule 4). When the
 * runtime says its manifest moved (POST /api/loom/pieces/changed), the open apps hear `change` on /events at once, and
 * the card goes working, then quiet again, without waiting for loom's own look at the pieces.
 * Needs `age` (a thread's words are encrypted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock, runtimePieces } from '../cli/pieces-managed.js';
import { createConversationTables } from '../backends/conversations.js';
import { titleFromAgent } from '../comms.js';
import { parseTurn, recordTurn } from '../backends/conversations.js';
import { atWorkFor } from './handler.js';
import type { PieceInfo } from './pieces.js';
import { clearPieceCache } from './pieces.js';
import { stopCommsWatch } from './comms-live.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

/** The runtime, faked: its manifest is the file runtime-manifest.json, its deliveries start a body. */
const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'ui' && process.argv[3] === '--json') {
  const f = process.env.LOOM_HOME + '/runtime-manifest.json';
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : JSON.stringify({ v: 2, owners: 2, tab: { label: 'Boxes' }, asks: [] }));
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'api') return console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: '{}', stderr: '' } }));
  console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: 1, body: 'started' }));
});
`;

describe.skipIf(!hasAge)('an agent at work in a Comms thread', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  const get = async (token: string, path: string) => {
    const r = await fetch(`${base}${path}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    return await r.json() as Record<string, any>;
  };
  const card = async (token: string, agent: string) => ((await get(token, '/')).home.cards as Array<Record<string, any>>).find((c) => c.id === agent)!;
  const manifest = (doing: unknown[] | null) => writeFileSync(join(h.home, 'runtime-manifest.json'), JSON.stringify({ v: 2, owners: 2, tab: { label: 'Boxes' }, asks: [],
    agents: doing ? { mark: { readings: [], doing } } : {} }));
  const changed = async () => {
    const r = await fetch(`${base}/api/loom/pieces/changed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.runtime}` }, body: '{}' });
    expect(r.status).toBe(200);
  };
  /** An open app's live stream: resolves with how long the next `change` took, from now. */
  const listen = async (token: string) => {
    const ctl = new AbortController();
    const r = await fetch(`${base}/events`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }, signal: ctl.signal });
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const next = async (): Promise<number> => {
      const t0 = Date.now();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('the stream closed');
        buf += dec.decode(value);
        const i = buf.indexOf('event: change');
        if (i >= 0) { buf = buf.slice(i + 13); return Date.now() - t0; }
      }
    };
    return { next, close: () => ctl.abort() };
  };

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-at-work-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a === 'art' ? 'Art E Fish' : 'Mark'}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
      createConversationTables(db);
      db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [
      { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['mark'] }, { person: 'loren', role: 'owner', agents: ['art'] }] }));
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
    manifest(null);
    for (const m of ['jonathan', 'sam', 'loren']) tok[m] = createToken(h, { role: { kind: 'owner', member: m }, label: m }).token;
    tok.runtime = createToken(h, { role: { kind: 'runtime', piece: 'runtime' }, label: 'runtime', runtimePieces: runtimePieces(process.env) }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    stopCommsWatch();
    await handle.close();
    clearPieceCache();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  it('a Comms body starts and ends: the card and window go working (its title, a link to it), then quiet, within seconds', async () => {
    const r = await fetch(`${base}/comms/new`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` },
      body: JSON.stringify({ agent: 'mark', id: 'aaaaaaaaaaaaaaab', text: 'Can you plan the garden?' }) });
    expect(r.status).toBe(200);
    const thread = ((await r.json()) as { thread: { id: string; conversation: string } }).thread;
    titleFromAgent(h.home, 'mark', thread.conversation, 'Plan the garden');
    const quiet = await card(tok.jonathan, 'mark');
    expect(quiet).toMatchObject({ state: 'available', doing: [] });

    const app = await listen(tok.jonathan);
    // The stream's first look at the pieces (what it compares against) is done before the runtime moves.
    await new Promise((res) => setTimeout(res, 1500));
    try {
      // The runtime: a body at work in the thread (its manifest names the conversation, never the title).
      const observedAt = Date.now();
      manifest([{ text: 'In a Comms thread', kind: 'talk', where: 'Comms', conversation: thread.conversation, since: new Date().toISOString(), activity: { action: 'Running a command', observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(observedAt+30000).toISOString() } }]);
      const heard = app.next();
      await changed();
      expect(await heard).toBeLessThan(5000);
      const working = await card(tok.jonathan, 'mark');
      expect(working.state).toBe('working');
      expect(working.doing).toHaveLength(1);
      expect(working.doing[0]).toMatchObject({ text: 'Plan the garden', where: 'Comms', href: `/comms/${thread.id.replace(/^th:/, '')}` });
      // Its window: the working pill, and what it's on, linked.
      const win = await get(tok.jonathan, '/a/mark/mind');
      expect(win.head).toMatchObject({ working: true, on: { text: 'Plan the garden', href: `/comms/${thread.id.replace(/^th:/, '')}` } });
      // Another owner of the same agent never hears of the thread: not its title, not that it's at work there.
      const other = await card(tok.sam, 'mark');
      expect(other).toMatchObject({ state: 'available', doing: [] });
      expect(JSON.stringify(await get(tok.sam, '/'))).not.toContain('Plan the garden');
      expect(JSON.stringify(await get(tok.sam, '/'))).not.toContain('Running a command');
      expect((await get(tok.jonathan, '/')).chrome.shell.agents.find((a: any) => a.id === 'mark').activity.action).toBe('Running a command');

      // Its turn over: the runtime says nothing at work, and the card is quiet again within seconds.
      manifest(null);
      const heardAgain = app.next();
      await changed();
      expect(await heardAgain).toBeLessThan(5000);
      expect(await card(tok.jonathan, 'mark')).toMatchObject({ state: 'available', doing: [] });
      expect((await get(tok.jonathan, '/a/mark/mind')).head.working).toBeUndefined();
    } finally { app.close(); }
  }, 30_000);

  it('a bridge\'s or a wake\'s row: its label and link for the agent\'s owners, only the runtime\'s plain words for anyone else', async () => {
    // A Slack DM of mark's, as core has it: its label names who it's with.
    const { conversation } = recordTurn(agentDir(h, 'mark'), 'mark', parseTurn({ venue: 'slack', place: 'dm:U1', at: new Date().toISOString(),
      from: { kind: 'person', slug: 'loren' }, kind: 'message', label: 'Loren (dm:U1)' }, 'mark'), 'runtime');
    manifest([{ text: 'Working · Slack', kind: 'talk', conversation }]);
    clearPieceCache();
    // mark's owners: its label, and a link to the conversation.
    for (const t of [tok.jonathan, tok.sam]) {
      expect((await card(t, 'mark')).doing.map((d: Record<string, unknown>) => [d.text, d.href])).toEqual([['Talking in Loren (dm:U1)', `/a/mark/conversation/${conversation}`]]);
    }
    // Loren doesn't own mark: no card of mark's, and nothing of the conversation anywhere in their Home.
    const theirs = await get(tok.loren, '/');
    expect((theirs.home.cards as Array<{ id: string }>).map((c) => c.id)).toEqual(['art']);
    expect(JSON.stringify(theirs)).not.toContain('dm:U1');
    // And the rule itself: a viewer who isn't the agent's owner keeps the runtime's plain words, no label, no link.
    const pieces = [{ piece: 'runtime', manifest: { agents: { mark: { readings: [], doing: [{ text: 'Working · Slack', kind: 'talk', conversation }] } } } }] as unknown as PieceInfo[];
    const seen = (m: string) => atWorkFor(pieces, h, h.members.find((x) => x.person === m))[0].manifest.agents!.mark.doing!;
    expect(seen('loren')).toEqual([{ text: 'Working · Slack', kind: 'talk', conversation }]);
    expect(seen('sam')[0]).toMatchObject({ text: 'Talking in Loren (dm:U1)', href: `/a/mark/conversation/${conversation}` });
    expect(atWorkFor(pieces, h, undefined)[0].manifest.agents!.mark.doing).toEqual([{ text: 'Working · Slack', kind: 'talk', conversation }]);
    manifest(null);
    clearPieceCache();
  });

  it('only the runtime may say a piece moved', async () => {
    const r = await fetch(`${base}/api/loom/pieces/changed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` }, body: '{}' });
    expect(r.status).not.toBe(200);
  });
});
