/**
 * Comms (docs/specs/comms.md): the core venue `loom`, its thread store, and the owner-only rule enforced by the
 * server. Each describe names the spec's acceptance criterion. Needs the `age` and `age-keygen` programs (CI installs
 * age).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { parseLoomBlock, runtimePieces } from './cli/pieces-managed.js';
import { conversationId, createConversationTables, recordTurn, writeDigest } from './backends/conversations.js';
import { conversationSteps, COMMS_DB, COMMS_FILES, COMMS_KEY, COMMS_SALT, adapterCall, wordsHash, placeFor, resendMessage, SEND_STALE_MS, settleThread, sweepComms, threadState, traceOf, WORKING_STALE_MS, type Thread } from './comms.js';
import { createHash, createHmac } from 'node:crypto';
import { clearPieceCache } from './ui/pieces.js';
import { knowledgeWrite } from './tools/knowledge-write.js';
import { openProjectsStore } from './backends/projects.js';
import { Notes } from './notes.js';
import { stopCommsWatch } from './ui/comms-live.js';
import { resolveNeeds, pieceCheckers } from './needs-resolve.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'api') {
    fs.appendFileSync(home + '/runtime-api.jsonl', input + '\\n');
    const q = JSON.parse(input);
    if (q.path === 'conversation-control') {
      const f = home + '/control-status';
      const status = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 200;
      return console.log(JSON.stringify({ status, body: status === 200 ? { accepted: true, state: q.body.action === 'interrupt' ? 'pending' : 'resuming' } : { error: status === 404 ? 'no such conversation' : 'control unavailable' } }));
    }
    if (q.path === 'conversation-origins') {
      const all = fs.existsSync(home + '/runtime-origins.json') ? JSON.parse(fs.readFileSync(home + '/runtime-origins.json', 'utf8')) : {};
      return console.log(JSON.stringify({ status: 200, body: { origins: Object.fromEntries(q.body.conversations.map(cv => [cv, all[cv] || cv])) } }));
    }
    if (q.path === 'model-choice') {
      const f = home + '/model-choices.json';
      const choices = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {};
      if (q.body.harness !== undefined) { choices[q.body.conversation] = q.body.harness; fs.writeFileSync(f, JSON.stringify(choices)); }
      return console.log(JSON.stringify({ status: 200, body: { agent: q.body.agent, conversation: q.body.conversation, threadChoice: choices[q.body.conversation] || 'auto', agentChoice: 'auto', effective: choices[q.body.conversation] || 'auto' } }));
    }

    return console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: '{}', stderr: '' } }));
  }
  fs.appendFileSync(home + '/runtime-calls.jsonl', input + '\\n');
  const mode = fs.existsSync(home + '/runtime-mode') ? fs.readFileSync(home + '/runtime-mode', 'utf-8').trim() : 'ok';
  if (mode === 'said') { console.log(JSON.stringify({ status: 503, error: 'no house free for art' })); process.exit(1); }
  if (mode === 'refuse') { console.log(JSON.stringify({ status: 400, error: 'bad-input: no such thing' })); process.exit(1); }
  const d = JSON.parse(input);
  console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: 1, body: mode === 'failed' ? 'failed' : mode === 'queued' ? 'queued' : 'started', ...(mode === 'failed' ? { reason: 'no box is logged in' } : {}) }));
});
`;

function piece(home: string, name: string, raw: Record<string, unknown>, body: string): void {
  const loom = parseLoomBlock(raw, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(`${name}: ${loom}`);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  rmSync(join(home, 'pieces', 'bin', `loom-${name}`), { force: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

function household(prefix: string): Household {
  const home = mkdtempSync(join(tmpdir(), prefix));
  for (const a of ['art', 'mark', 'pond-bot']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({
    v: 1, agents: ['art', 'mark', 'pond-bot'], default: 'art', members: [
      { person: 'jonathan', role: 'owner', agents: '*' },
      { person: 'sam', role: 'owner', agents: ['art'] },
      { person: 'loren', role: 'owner', agents: ['pond-bot'] },
    ],
  }));
  return loadHousehold(home)!;
}

/** 16 base32 characters, made from a number: a test's message id. */
const mid = (n: number) => `a${String(n).padStart(15, '0').replace(/[0189]/g, (d) => ({ '0': 'a', '1': 'b', '8': 'c', '9': 'd' } as Record<string, string>)[d])}`;

/** Read a stream until `until` matches or `ms` pass: what came. */
async function readFor(res: Response, until: RegExp, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  let got = '';
  const end = Date.now() + ms;
  while (Date.now() < end && !until.test(got)) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(1, end - Date.now())))]);
    if (chunk.done) break;
    got += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return got;
}

describe.skipIf(!hasAge)('Comms', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  const page = async (token: string | undefined, method: string, path: string, body?: unknown, accept = 'application/json') => {
    const r = await fetch(`${base}${path}`, {
      method, headers: { accept, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json, text };
  };
  const api = async (token: string, path: string, body: unknown) => {
    const r = await fetch(`${base}/api/loom/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const deliveries = (): Array<Record<string, unknown>> => {
    const f = join(h.home, 'runtime-calls.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : []; // the page's manifest asks run it with nothing on stdin
  };
  const apiCalls = (): Array<Record<string, unknown>> => {
    const f = join(h.home, 'runtime-api.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const mode = (m: 'ok' | 'said' | 'refuse' | 'failed' | 'queued') => writeFileSync(join(h.home, 'runtime-mode'), m);
  let n = 100;
  /** Until no member's message in the thread is on its way: a send is accepted at once, delivered in the background. */
  const settled = async (thread: string) => {
    const end = Date.now() + 10_000;
    for (;;) {
      const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true });
      const busy = (() => { try { return (db.prepare("SELECT COUNT(*) AS n FROM comms_messages WHERE thread = ? AND kind = 'message' AND delivered IS NULL").get(thread) as { n: number }).n; } finally { db.close(); } })();
      if (!busy) return;
      if (Date.now() > end) throw new Error(`${thread} still has a message on its way`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const open = async (token = tok.jonathan, agent = 'art', text = 'hello art') => {
    const r = await page(token, 'POST', '/comms/new', { agent, id: mid(n++), text });
    expect(r.status).toBe(200);
    const t = r.body.thread as { id: string; conversation: string; channel: number };
    await settled(t.id);
    return t;
  };

  beforeAll(async () => {
    clearPieceCache();
    h = household('loom-comms-');
    process.env.LOOM_HOME = h.home;
    // A stand-in approvals piece: its manifest's asks are a file the test writes (approvals-asks.json).
    piece(h.home, 'approvals', { role: 'approvals' }, `#!${process.execPath}
const fs = require('node:fs');
const f = process.env.LOOM_HOME + '/approvals-asks.json';
const st = process.env.LOOM_HOME + '/approvals-state.json';
const read = (x, d) => fs.existsSync(x) ? JSON.parse(fs.readFileSync(x, 'utf-8')) : d;
if (process.argv[2] === 'ui' && process.argv[3] === '--json') {
  console.log(JSON.stringify({ v: 2, owners: 2, asks: read(f, []) }));
} else if (process.argv[2] === 'ui' && process.argv[3] === 'act') {
  // Allow or Deny: the card leaves the manifest, its state is kept (as the real piece's answer).
  const req = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const id = req.fields && req.fields.id;
  const asks = read(f, []);
  if (!asks.some((a) => a.actions.some((b) => b.fields.id === id))) { console.log(JSON.stringify({ ok: false, message: 'Not pending.', page: '' })); process.exit(0); }
  fs.writeFileSync(f, JSON.stringify(asks.filter((a) => !a.actions.some((b) => b.fields.id === id))));
  const s = read(st, {}); s[id] = { state: req.action === 'allow' ? 'allowed' : 'denied', agent: 'art', kind: 'merge' }; fs.writeFileSync(st, JSON.stringify(s));
  console.log(JSON.stringify({ ok: true, message: req.action === 'allow' ? 'Allowed once.' : 'Denied.', page: '' }));
} else if (process.argv[2] === 'api' && process.argv[3] === '--json') {
  const req = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const s = read(st, {});
  if (req.path === 'state') console.log(JSON.stringify({ status: 200, body: { approvals: Object.fromEntries((req.body.ids || []).filter((i) => s[i]).map((i) => [i, s[i]])) } }));
  else console.log(JSON.stringify({ status: 404, body: { error: 'no' } }));
} else process.exit(2);
`);
    // A piece that doesn't understand agent owners (no owners: 2): the household owner's only, as the Inbox has it.
    piece(h.home, 'deskonly', {}, `#!${process.execPath}
const fs = require('node:fs');
const f = process.env.LOOM_HOME + '/household-asks.json';
if (process.argv[2] === 'ui' && process.argv[3] === '--json') {
  console.log(JSON.stringify({ v: 2, asks: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : [] }));
} else if (process.argv[2] === 'ui' && process.argv[3] === 'act') {
  const req = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const asks = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : [];
  fs.writeFileSync(f, JSON.stringify(asks.filter((a) => !a.actions.some((b) => b.fields.id === req.fields.id))));
  console.log(JSON.stringify({ ok: true, message: 'Done.', page: '' }));
} else process.exit(2);
`);
    // A stand-in tasks piece: `run show t-N` answers any task under 1000 (t-7 is closed), none above.
    piece(h.home, 'tasks', { role: 'tasks' }, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'ui' && process.argv[3] === '--json') console.log(JSON.stringify({ v: 2, tab: { label: 'Tasks' }, asks: [] }));
else if (process.argv[2] === 'api' && process.argv[3] === '--json') {
  const req = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const id = req.body && req.body.argv && req.body.argv[1];
  fs.appendFileSync(process.env.LOOM_HOME + '/tasks-shows.log', id + '\\n');
  const n = Number(String(id).slice(2));
  const out = n < 1000 ? { ok: true, task: { id, title: 'Task ' + id, status: n === 7 ? 'closed' : 'open' } } : { ok: false, errors: ['E_UNKNOWN_ID'] };
  console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: JSON.stringify(out) } }));
} else process.exit(2);
`);
    piece(h.home, 'runtime', { role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'], venues: { spawn: { label: 'Spawn', kind: 'agent' }, relay: { label: 'Relay', kind: 'agent', send: ['loom-runtime', 'relay-send'] } } }, RUNTIME_BIN);
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    tok.loren = createToken(h, { role: { kind: 'owner', member: 'loren' }, label: 'loren' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
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

  describe('criterion 1: owners only, enforced by the server', () => {
    it('refuses a member who does not own the agent, and a second owner, on every thread route', async () => {
      const t = await open();
      const routes: Array<[string, string, unknown?]> = [
        ['GET', `/comms/${t.id}`], ['GET', `/comms/${t.id}/since/0`], ['GET', `/comms/${t.id}/before/9`],
        ['POST', `/comms/${t.id}/send`, { id: mid(1), text: 'x' }], ['POST', `/comms/${t.id}/title`, { title: 'x' }],
        ['POST', `/comms/${t.id}/project`, { project: null }], ['POST', `/comms/${t.id}/pin`, {}], ['POST', `/comms/${t.id}/unpin`, {}],
        ['POST', `/comms/${t.id}/archive`, {}], ['POST', `/comms/${t.id}/unarchive`, {}], ['POST', `/comms/${t.id}/read`, { seq: 1 }],
        ['POST', `/comms/${t.id}/stop`, {}], ['POST', `/comms/${t.id}/resume`, {}], ['POST', `/comms/${t.id}/delete`, {}],
      ];
      for (const who of [tok.loren, tok.sam]) {
        for (const [m, p, b] of routes) {
          const r = await page(who, m, p, b);
          expect(r.status, `${m} ${p}`).toBe(403);
        }
        const ev = await page(who, 'GET', `/comms/${t.id}/events`, undefined, 'text/event-stream');
        expect(ev.status).toBe(403);
      }
      // The thread is still there, untouched, for its member.
      const mine = await page(tok.jonathan, 'GET', `/comms/${t.id}`);
      expect(mine.status).toBe(200);
      expect((mine.body.thread as { archived: unknown }).archived).toBeNull();
    });

    it('refuses opening a thread with an agent the member does not own, and lists only their own', async () => {
      const r = await page(tok.loren, 'POST', '/comms/new', { agent: 'art', id: mid(2), text: 'hi' });
      expect(r.status).toBe(403);
      const list = await page(tok.loren, 'GET', '/comms');
      expect(list.status).toBe(200);
      expect(list.body.threads).toEqual([]);
      expect(list.body.agents).toEqual(['pond-bot']);
      const sams = await page(tok.sam, 'GET', '/comms');
      expect(sams.body.threads).toEqual([]);
    });

    it('answers a thread that never existed exactly as another member\'s', async () => {
      const t = await open();
      const theirs = await page(tok.loren, 'GET', `/comms/${t.id}`);
      const none = await page(tok.loren, 'GET', '/comms/th:aaaaaaaaaa');
      expect(none.status).toBe(403);
      expect(none.body).toEqual(theirs.body);
    });

    it('refuses agent and runtime tokens on the page, and the page on the runtime\'s routes', async () => {
      // Not a page sign-in: a GET goes to the sign-in page, a POST is a 401.
      for (const t of [tok.art, tok.runtime]) {
        const g = await fetch(`${base}/comms`, { headers: { accept: 'application/json', authorization: `Bearer ${t}` }, redirect: 'manual' });
        expect(g.status).toBe(303);
        expect(g.headers.get('location')).toBe('/login');
        const p = await page(t, 'POST', '/comms/new', { agent: 'art', id: mid(4), text: 'x' });
        expect(p.status).toBe(401);
      }
      const r = await api(tok.jonathan, 'comms/adapter', { op: 'describe', place: 'th:aaaaaaaaaa', agent: 'art' });
      expect(r.status).toBe(403);
    });

    it('refuses a write from another site', async () => {
      const r = await fetch(`${base}/comms/new`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}`, origin: 'https://evil.example' }, body: JSON.stringify({ agent: 'art', id: mid(3), text: 'x' }) });
      expect(r.status).toBe(403);
    });

    it('gives a member\'s Comms view only the agents they own, never another owner\'s', async () => {
      const r = await page(tok.loren, 'GET', '/comms');
      expect(r.status).toBe(200);
      expect(Object.keys((r.body.ctx as { agents: Record<string, unknown> }).agents)).toEqual(['pond-bot']);
      expect(r.body.agents).toEqual(['pond-bot']);
      expect(JSON.stringify(r.body.ctx)).not.toMatch(/"art"|"mark"/);
    });

    it('refuses a page load of another member\'s thread as its JSON is refused', async () => {
      const t = await open();
      for (const who of [tok.loren, tok.sam]) {
        const r = await fetch(`${base}/comms/${t.id}`, { headers: { accept: 'text/html', authorization: `Bearer ${who}` } });
        expect(r.status).toBe(403);
      }
      const mine = await fetch(`${base}/comms/${t.id}`, { headers: { accept: 'text/html', authorization: `Bearer ${tok.jonathan}` } });
      expect(mine.status).not.toBe(403);
      // A fetch from another site is refused, a page or not.
      const cross = await fetch(`${base}/comms`, { headers: { accept: 'application/json', authorization: `Bearer ${tok.jonathan}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } });
      expect(cross.status).toBe(403);
    });

    it('refuses a signed-in browser\'s write without its form token', async () => {
      const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(tok.jonathan)}`, redirect: 'manual' });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      expect(cookie).toMatch(/=/);
      const home = await (await fetch(`${base}/`, { headers: { cookie, accept: 'application/json' } })).json() as { chrome: { csrf: string } };
      const post = (body: Record<string, unknown>) => fetch(`${base}/comms/new`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
      expect((await post({ agent: 'art', id: mid(n++), text: 'no token' })).status).toBe(403);
      expect((await post({ agent: 'art', id: mid(n++), text: 'wrong token', _csrf: 'f'.repeat(64) })).status).toBe(403);
      expect((await post({ agent: 'art', id: mid(n++), text: 'with its token', _csrf: home.chrome.csrf })).status).toBe(200);
    });

    it('refuses a piece token on the page', async () => {
      const piece = createToken(h, { role: { kind: 'piece', piece: 'runtime', subject: 'x' }, label: 'p' }).token;
      const g = await fetch(`${base}/comms`, { headers: { accept: 'application/json', authorization: `Bearer ${piece}` }, redirect: 'manual' });
      expect(g.status).toBe(303);
    });

    it('cuts off an open stream when its member stops owning the agent, at the next event', async () => {
      const t = await open(tok.sam);
      const ac = new AbortController();
      const lastSeq = ((await page(tok.sam, 'GET', `/comms/${t.id}`)).body.messages as Array<{ seq: number }>).at(-1)!.seq;
      const r = await fetch(`${base}/comms/${t.id}/events?from=${lastSeq}`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${tok.sam}` }, signal: ac.signal });
      expect(r.status).toBe(200);
      const raw = JSON.parse(readFileSync(join(h.home, 'household.json'), 'utf-8'));
      raw.members[1].agents = ['mark'];
      writeFileSync(join(h.home, 'household.json'), JSON.stringify(raw));
      try {
        await new Promise((res2) => setTimeout(res2, 150));
        await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'after the change' });
        const got = await readFor(r, /event: message/, 1500);
        expect(got).not.toMatch(/event: message/);
      } finally {
        ac.abort();
        raw.members[1].agents = ['art'];
        writeFileSync(join(h.home, 'household.json'), JSON.stringify(raw));
      }
    });

    it('reads and saves a thread model through the authenticated runtime with server-owned scope', async () => {
      const t = await open();
      const read = await page(tok.jonathan, 'GET', `/comms/${t.id}/model`);
      expect(read.status).toBe(200);
      expect(read.body.threadChoice).toBe('auto');
      const saved = await page(tok.jonathan, 'POST', `/comms/${t.id}/model`, { harness: 'codex', conversation: 'cv-999999999999', agent: 'mark' });
      expect(saved.status).toBe(200);
      expect(saved.body.threadChoice).toBe('codex');
      expect((await page(tok.jonathan, 'GET', `/comms/${t.id}/model`)).body.threadChoice).toBe('codex');
      const request = apiCalls().filter((x) => x.path === 'model-choice').at(-1)!;
      expect(request.body).toEqual({ agent: 'art', conversation: t.conversation });
      expect(request.caller).toMatchObject({ kind: 'owner', who: 'jonathan', agents: '*' });
      expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/model`, { harness: 'auto' })).body.threadChoice).toBe('auto');
    });

    it('refuses model choice from another owner, a body, or an invalid selection', async () => {
      const t = await open();
      const before = apiCalls().length;
      expect((await page(tok.sam, 'POST', `/comms/${t.id}/model`, { harness: 'codex' })).status).toBe(403);
      expect((await page(tok.art, 'POST', `/comms/${t.id}/model`, { harness: 'codex' })).status).toBe(401);
      expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/model`, { harness: 'not-a-harness' })).status).toBe(400);
      expect(apiCalls()).toHaveLength(before);
    });

    it('shows another owner the conversation, never its words', async () => {
      const t = await open(tok.jonathan, 'art', 'words-only-jonathan-reads-ibex');
      recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: t.id, at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:runtime');
      const r = await fetch(`${base}/conversation/${t.conversation}`, { headers: { accept: 'application/json', authorization: `Bearer ${tok.sam}` } });
      expect(await r.text()).not.toMatch(/ibex/);
    });

    it('cuts off a member who stops owning the agent', async () => {
      const t = await open(tok.sam);
      const raw = JSON.parse(readFileSync(join(h.home, 'household.json'), 'utf-8'));
      raw.members[1].agents = ['mark'];
      writeFileSync(join(h.home, 'household.json'), JSON.stringify(raw));
      try {
        const r = await page(tok.sam, 'GET', `/comms/${t.id}`);
        expect(r.status).toBe(403);
      } finally {
        raw.members[1].agents = ['art'];
        writeFileSync(join(h.home, 'household.json'), JSON.stringify(raw));
      }
    });
  });

  describe('criterion 2: the venue', () => {
    it('lists loom as core\'s own, adapted by core, with no send', async () => {
      const r = await fetch(`${base}/api/loom/venues`, { headers: { authorization: `Bearer ${tok.runtime}` } });
      const v = ((await r.json()) as { venues: Array<Record<string, unknown>> }).venues.find((x) => x.name === 'loom');
      expect(v).toEqual({ name: 'loom', label: 'loom', kind: 'live', piece: 'loom', adapter: 'core' });
    });
    it('refuses a piece declaring it', () => {
      expect(parseLoomBlock({ venues: { loom: { label: 'Mine', kind: 'live' } } }, 'x', ['loom-x'])).toMatch(/core's own/);
    });
  });

  describe('criterion 3: sending', () => {
    it('delivers as core\'s own delivery from the member, once per id', async () => {
      const before = deliveries().length;
      const t = await open(tok.jonathan, 'art', 'first words');
      const d = deliveries().slice(before);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ venue: 'loom', place: t.id, agent: 'art', from: { kind: 'person', slug: 'jonathan' }, kind: 'message', text: 'first words', source: 'loom' });
      expect(String(d[0].id)).toMatch(new RegExp(`^comms:${t.id}:[a-z2-7]{16}$`));
      const id = mid(n++);
      const a = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'second' });
      // Accepted at once, on its way; the same id again meanwhile is the same message, still on its way, and no second delivery.
      expect(a.body).toMatchObject({ delivery: 'sending' });
      const during = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'second' });
      expect(during.body).toMatchObject({ seq: a.body.seq, repeat: true });
      await settled(t.id);
      const b = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'second' });
      expect(b.body).toMatchObject({ seq: a.body.seq, delivery: 'delivered', repeat: true });
      expect(deliveries().length - before).toBe(2);
      const other = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'other words' });
      expect(other.status).toBe(409);
    });

    it('answers a replayed new with the same thread, and refuses its id with another agent or other words', async () => {
      const id = mid(n++);
      const a = await page(tok.jonathan, 'POST', '/comms/new', { agent: 'art', id, text: 'once' });
      const b = await page(tok.jonathan, 'POST', '/comms/new', { agent: 'art', id, text: 'once' });
      expect((b.body.thread as { id: string }).id).toBe((a.body.thread as { id: string }).id);
      expect(b.body.repeat).toBe(true);
      expect((await page(tok.jonathan, 'POST', '/comms/new', { agent: 'mark', id, text: 'once' })).status).toBe(409);
      expect((await page(tok.jonathan, 'POST', '/comms/new', { agent: 'art', id, text: 'twice' })).status).toBe(409);
    });

    it('refuses bad ids and text out of bounds', async () => {
      const t = await open();
      for (const id of ['a'.repeat(15), 'a'.repeat(17), 'aaaaaaaaaaaaaaa0', 'aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa8', 'Aaaaaaaaaaaaaaaa']) {
        expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'x' })).status, id).toBe(400);
      }
      expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id: mid(n++), text: '' })).status).toBe(400);
      expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id: mid(n++), text: 'x'.repeat(40_001) })).status).toBe(400);
    });

    it('makes places of the right shape, keyed by the salt', () => {
      const p1 = placeFor(h.home, 'jonathan', 'art', 'aaaaaaaaaaaaaaaa');
      expect(p1).toMatch(/^th:[a-z2-7]{10}$/);
      expect(placeFor(h.home, 'jonathan', 'art', 'aaaaaaaaaaaaaaaa')).toBe(p1);
      expect(placeFor(h.home, 'jonathan', 'mark', 'aaaaaaaaaaaaaaaa')).not.toBe(p1);
      const unkeyed = createHash('sha256').update('jonathan\0art\0aaaaaaaaaaaaaaaa').digest('hex');
      expect(p1.slice(3)).not.toBe(unkeyed.slice(0, 10));
      expect(createHmac('sha256', readFileSync(join(h.home, COMMS_SALT))).update('jonathan\0art\0aaaaaaaaaaaaaaaa').digest().length).toBe(32);
      const other = mkdtempSync(join(tmpdir(), 'loom-comms-salt-'));
      try { expect(placeFor(other, 'jonathan', 'art', 'aaaaaaaaaaaaaaaa')).not.toBe(p1); } finally { rmSync(other, { recursive: true, force: true }); }
    });

    it('keeps a message the runtime could not take, and Send again delivers it once', async () => {
      const t = await open();
      mode('said');
      const id = mid(n++);
      const a = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'try me' });
      expect(a.body).toMatchObject({ delivery: 'sending' });
      await settled(t.id);
      const failed = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; delivered: boolean | null; delivery?: string; seq: number }>;
      expect(failed.find((m) => m.seq === a.body.seq)).toMatchObject({ delivered: false, delivery: 'failed' });
      mode('ok');
      const before = deliveries().length;
      // Send again, tapped three times: it goes again once, and is on its way meanwhile.
      const b = await Promise.all([1, 2, 3].map(() => page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'try me' })));
      for (const x of b) expect(x.body).toMatchObject({ seq: a.body.seq, repeat: true });
      expect(b.some((x) => x.body.delivery === 'sending')).toBe(true);
      await settled(t.id);
      expect(deliveries().length - before).toBe(1);
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; delivered: boolean | null; seq: number }>;
      expect(msgs.find((m) => m.seq === a.body.seq)).toMatchObject({ delivered: true, delivery: 'delivered' });
    });
  });

  describe('criterion 4: the adapter route', () => {
    it('posts a reply to a live thread, and refuses for good where it can\'t', async () => {
      const t = await open();
      const ok = await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'hi jonathan' });
      expect(ok.body).toMatchObject({ ok: true });
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string; from: string }>;
      expect(msgs.at(-1)).toMatchObject({ kind: 'reply', text: 'hi jonathan', from: 'art', card: null });
      // A switched body's reply names its harness (loom-box t-1907), kept on its card for the channel line; anything
      // but a short word is dropped.
      await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'on codex now', on: 'Codex' });
      for (const bad of ['<b>x</b>', 'Codex Max', 'C'.repeat(25), 7]) await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: `odd on ${String(bad).length}`, on: bad });
      await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'longest', on: 'C'.repeat(24) });
      const after = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ text: string; card: unknown }>;
      // Only `on` is kept, nothing else of the call.
      expect(after.find((m) => m.text === 'on codex now')?.card).toEqual({ on: 'Codex' });
      expect(after.filter((m) => m.text.startsWith('odd on')).map((m) => m.card)).toEqual([null, null, null, null]);
      expect(after.find((m) => m.text === 'longest')?.card).toEqual({ on: 'C'.repeat(24) });
      const mt = await open(tok.jonathan, 'mark');
      const cases: Array<Record<string, unknown>> = [
        { place: 'th:aaaaaaaaaa', agent: 'art', text: 'x' }, { place: mt.id, agent: 'art', text: 'x' },
        { place: t.id, agent: 'art', text: '' }, { place: t.id, agent: 'art', text: 'x'.repeat(40_001) },
      ];
      for (const c of cases) expect((await api(tok.runtime, 'comms/adapter', { op: 'post', ...c })).body).toMatchObject({ ok: false, permanent: true });
      const gone = await open();
      await page(tok.jonathan, 'POST', `/comms/${gone.id}/archive`, {});
      expect((await api(tok.runtime, 'comms/adapter', { op: 'post', place: gone.id, agent: 'art', text: 'x' })).body).toMatchObject({ ok: false, permanent: true });
      const del = await open();
      await page(tok.jonathan, 'POST', `/comms/${del.id}/delete`, {});
      expect((await api(tok.runtime, 'comms/adapter', { op: 'post', place: del.id, agent: 'art', text: 'x' })).body).toMatchObject({ ok: false, permanent: true });
    });

    it('describes the thread: its member reads it, with the project and title lines as they apply', async () => {
      const t = await open();
      const d = await api(tok.runtime, 'comms/adapter', { op: 'describe', place: t.id, agent: 'art' });
      expect(d.body).toMatchObject({ ok: true, readers: ['jonathan'] });
      expect(d.body.brief).toEqual(expect.arrayContaining([expect.stringMatching(/comms_title/)]));
      expect(JSON.stringify(d.body.brief)).not.toMatch(/project/);
      await page(tok.jonathan, 'POST', `/comms/${t.id}/title`, { title: 'A name' });
      const d2 = await api(tok.runtime, 'comms/adapter', { op: 'describe', place: t.id, agent: 'art' });
      expect(JSON.stringify(d2.body.brief)).not.toMatch(/comms_title/);
    });

    it('shows working, clears it on done, and sends Stop through scoped runtime control', async () => {
      const t = await open();
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'working' });
      expect(((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.thread as { state: { working: boolean } }).state.working).toBe(true);
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done' });
      expect(((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.thread as { state: { working: boolean } }).state.working).toBe(false);
      const stopped = await page(tok.jonathan, 'POST', `/comms/${t.id}/stop`, { conversation: 'cv-ffffffffffff', agent: 'sam' });
      expect(stopped.body).toEqual({ accepted: true, state: 'pending' });
      expect(apiCalls().filter(x => x.path === 'conversation-control').at(-1)).toMatchObject({
        caller: { kind: 'owner', agents: '*', who: 'jonathan' }, body: { agent: 'art', conversation: t.conversation, action: 'interrupt' },
      });
      expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/resume`, { conversation: 'cv-ffffffffffff' })).body).toEqual({ accepted: true, state: 'resuming' });
      expect(apiCalls().filter(x => x.path === 'conversation-control').at(-1)).toMatchObject({ body: { agent: 'art', conversation: t.conversation, action: 'resume' } });
      expect((await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'working' })).body).toEqual({ ok: true });
    });

    it('a turn over with nothing sent says so in the thread, once per run; a done that replied, or names no run, adds nothing', async () => {
      const t = await open();
      const errors = async () => ((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string; run: string | null; card: { error?: string } | null }>).filter((m) => m.kind === 'error');
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done' });
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done', replied: false });
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done', replied: false, run: 'bad run!' });
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'working', replied: false, run: 'run-0123456789ab' });
      expect(await errors()).toEqual([]);
      expect((await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done', replied: false, run: 'run-0123456789ab' })).body).toEqual({ ok: true });
      // Said again (the runtime retries a done it didn't hear back from): still one.
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done', replied: false, run: 'run-0123456789ab' });
      const said = await errors();
      expect(said.map((m) => [m.text, m.run, m.card?.error])).toEqual([['Art finished without replying.', 'run-0123456789ab', 'no-reply']]);
      // Another run's silence is its own.
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done', replied: false, run: 'run-ba9876543210' });
      expect(await errors()).toHaveLength(2);
    });

    it('takes only the runtime\'s token', async () => {
      expect((await api(tok.art, 'comms/adapter', { op: 'describe', place: 'th:aaaaaaaaaa', agent: 'art' })).status).toBe(403);
    });
  });

  it('offers only this member and selected agent’s unarchived threads about the same ref', async () => {
    const about = { ref: 't-12', label: 'A task', page: 'p/tasks/task/t-12' };
    const made = await page(tok.jonathan, 'POST', '/comms/new', { agent: 'art', id: mid(n++), text: 'Discuss this', about });
    expect(made.status).toBe(200);
    const t = made.body.thread as Thread;
    expect((await page(tok.jonathan, 'GET', '/comms/about?agent=art&ref=t-12')).body.threads).toEqual([{ id: t.id, title: null }]);
    expect((await page(tok.sam, 'GET', '/comms/about?agent=art&ref=t-12')).body.threads).toEqual([]);
    expect((await page(tok.jonathan, 'GET', '/comms/about?agent=mark&ref=t-12')).body.threads).toEqual([]);
    expect((await page(tok.jonathan, 'GET', '/comms/about?agent=art&ref=t-13')).body.threads).toEqual([]);
    expect((await page(tok.loren, 'GET', '/comms/about?agent=art&ref=t-12')).status).toBe(403);
    expect((await page(tok.jonathan, 'GET', '/comms/about?agent=art')).status).toBe(400);
    expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/archive`, {})).status).toBe(200);
    expect((await page(tok.jonathan, 'GET', '/comms/about?agent=art&ref=t-12')).body.threads).toEqual([]);
  });

  describe('criterion 5 (core): activity', () => {
    const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, at: new Date().toISOString(), tool: 'Bash', summary: 'Ran the tests', state: 'running', ...extra });
    it('keeps wake and bridge steps apart by run, encrypted, with bounded pages and the existing viewer gate', async () => {
      for (const venue of ['wake', 'slack']) {
        const cv = recordTurn(agentDir(h, 'art'), 'art', { venue, place: `watch-${venue}`, at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' } as never, 'runtime:runtime').conversation;
        for (const run of ['run1', 'run2']) expect((await api(tok.runtime, 'comms/activity', { conversation: cv, run, cards: [card('same')] })).body).toMatchObject({ added: 1 });
        expect((await api(tok.runtime, 'comms/activity', { conversation: cv, run: 'run2', cards: [card('same', { state: 'done' })] })).body).toMatchObject({ updated: 1 });
        const steps = await conversationSteps(h.home, process.env, cv);
        expect(steps.map((s) => [s.run, s.state, s.text])).toEqual([['run1', 'running', 'Ran the tests'], ['run2', 'done', 'Ran the tests']]);
        expect((await conversationSteps(h.home, process.env, cv, steps[1].seq)).map((s) => s.run)).toEqual(['run1']);
        const visible = await page(tok.jonathan, 'GET', `/a/art/conversation/${cv}`);
        expect(JSON.stringify(visible.body)).toContain('Watching');
        expect(JSON.stringify(visible.body)).toContain('Ran the tests');
        const denied = await page(tok.loren, 'GET', `/a/art/conversation/${cv}`);
        expect(JSON.stringify(denied.body)).not.toContain('Ran the tests');
        expect(JSON.stringify((await page(tok.loren, 'GET', `/conversation/${cv}`)).body)).not.toContain('Ran the tests');
        expect(readFileSync(join(h.home, COMMS_DB)).includes(Buffer.from('Ran the tests'))).toBe(false);
      }
    });
    it('never revives a deleted private thread as agent-wide conversation steps', async () => {
      const t = await open();
      recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: t.id, at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:runtime');
      expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/delete`, {})).status).toBe(200);
      expect((await api(tok.runtime, 'comms/activity', { conversation: t.conversation, run: 'r1', cards: [card('late')] })).status).toBe(409);
      expect(await conversationSteps(h.home, process.env, t.conversation)).toEqual([]);
    });
    it('takes cards for a live thread, updates by id, and keeps the summary encrypted', async () => {
      const t = await open();
      expect((await api(tok.runtime, 'comms/activity', { conversation: 'cv-000000000000', run: 'r1', cards: [card('c1')] })).status).toBe(409);
      expect((await api(tok.runtime, 'comms/activity', { conversation: t.conversation, run: 'r1', cards: Array.from({ length: 51 }, (_, i) => card(`c${i}`)) })).status).toBe(400);
      expect((await api(tok.runtime, 'comms/activity', { conversation: t.conversation, run: 'r1', cards: [card('c1', { summary: 'x'.repeat(121) })] })).status).toBe(400);
      expect((await api(tok.runtime, 'comms/activity', { conversation: t.conversation, run: 'r1', cards: [card('c1', { summary: 'two\nlines' })] })).status).toBe(400);
      expect((await api(tok.runtime, 'comms/activity', { conversation: t.conversation, run: 'r1', cards: [card('c1')] })).body).toMatchObject({ ok: true, added: 1 });
      expect((await api(tok.runtime, 'comms/activity', { conversation: t.conversation, run: 'r1', cards: [card('c1', { state: 'failed', summary: 'Ran the tests — exit 1: 3 tests failed' })] })).body).toMatchObject({ ok: true, added: 0, updated: 1 });
      // t-1944: the update carries its label too (a failure's why), and the label stays sealed.
      expect(((await page(tok.jonathan, 'GET', `/comms/${t.id}/since/0`)).body.messages as Array<{ kind: string; text: string }>).find((m) => m.kind === 'card')!.text).toBe('Ran the tests — exit 1: 3 tests failed');
      expect((await api(tok.runtime, 'comms/activity', { conversation: t.conversation, run: 'r1', cards: [card('c1', { state: 'done' })] })).body).toMatchObject({ ok: true, added: 0, updated: 1 });
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}/since/0`)).body.messages as Array<{ kind: string; text: string; card: { state: string }; run: string }>;
      const cards = msgs.filter((m) => m.kind === 'card');
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ text: 'Ran the tests', card: { tool: 'Bash', state: 'done' }, run: 'r1' });
      for (let i = 0; i < 3; i++) await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: `r${i}` });
      const all = (await page(tok.jonathan, 'GET', `/comms/${t.id}/since/0`)).body.messages as Array<{ seq: number }>;
      const last = all.at(-1)!.seq;
      const before = (await page(tok.jonathan, 'GET', `/comms/${t.id}/before/${last}`)).body.messages as Array<{ seq: number }>;
      expect(before.map((m) => m.seq)).toEqual(all.slice(0, -1).map((m) => m.seq));
      const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true });
      try {
        const blob = db.prepare("SELECT text FROM comms_messages WHERE thread = ? AND kind = 'card'").get(t.id) as { text: Buffer };
        expect(blob.text.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
      } finally { db.close(); }
    });
  });

  describe('criterion 8: unread, pin, archive, delete', () => {
    it('keeps the thread intact and reports failure when its runtime cannot accept interruption', async () => {
      const t = await open();
      writeFileSync(join(h.home, 'control-status'), '503');
      try {
        for (const verb of ['stop', 'archive', 'delete']) {
          expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/${verb}`, {})).status).toBe(502);
          const current = await page(tok.jonathan, 'GET', `/comms/${t.id}`);
          expect(current.status).toBe(200);
          expect((current.body.thread as { archived: unknown }).archived).toBeNull();
        }
      } finally { rmSync(join(h.home, 'control-status')); }
    });

    it('can archive a new thread whose conversation has not reached the runtime', async () => {
      const t = await open();
      writeFileSync(join(h.home, 'control-status'), '404');
      try { expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/archive`, {})).status).toBe(200); }
      finally { rmSync(join(h.home, 'control-status')); }
    });
    it('counts unread replies and never lowers read_seq', async () => {
      const t = await open();
      await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'unread one' });
      const list = (await page(tok.jonathan, 'GET', '/comms')).body.threads as Array<{ id: string; unread: boolean; last_seq: number }>;
      const row = list.find((x) => x.id === t.id)!;
      expect(row.unread).toBe(true);
      await page(tok.jonathan, 'POST', `/comms/${t.id}/read`, { seq: row.last_seq });
      await page(tok.jonathan, 'POST', `/comms/${t.id}/read`, { seq: 0 });
      const after = ((await page(tok.jonathan, 'GET', '/comms')).body.threads as Array<{ id: string; unread: boolean; read_seq: number }>).find((x) => x.id === t.id)!;
      expect(after).toMatchObject({ unread: false, read_seq: row.last_seq });
    });

    it('refuses a member\'s ninth pin', async () => {
      const ts = [];
      for (let i = 0; i < 9; i++) ts.push(await open(tok.loren, 'pond-bot', `pin ${i}`));
      for (let i = 0; i < 8; i++) expect((await page(tok.loren, 'POST', `/comms/${ts[i].id}/pin`, {})).status).toBe(200);
      const ninth = await page(tok.loren, 'POST', `/comms/${ts[8].id}/pin`, {});
      expect(ninth.status).toBe(409);
      expect(String(ninth.body.error)).toMatch(/pin 8 threads at most/);
    }, 30_000);

    it('archiving hides the thread, ends its body and refuses sends until unarchived', async () => {
      const t = await open();
      await page(tok.jonathan, 'POST', `/comms/${t.id}/archive`, {});
      const list = (await page(tok.jonathan, 'GET', '/comms')).body.threads as Array<{ id: string }>;
      expect(list.some((x) => x.id === t.id)).toBe(false);
      const archived = (await page(tok.jonathan, 'GET', '/comms?archived=1')).body.threads as Array<{ id: string }>;
      expect(archived.some((x) => x.id === t.id)).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(apiCalls().some((c) => c.path === 'conversation-control' && (c.body as { conversation: string }).conversation === t.conversation)).toBe(true);
      const refused = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id: mid(n++), text: 'x' });
      expect(refused.status).toBe(409);
      expect(String(refused.body.error)).toMatch(/archived/);
      await page(tok.jonathan, 'POST', `/comms/${t.id}/unarchive`, {});
      expect((await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id: mid(n++), text: 'x' })).status).toBe(200);
    });

    it('deleting leaves only a tombstone: 404 to its member, the same 403 to anyone else', async () => {
      const t = await open(tok.jonathan, 'art', 'a planted secret phrase zebra-quokka');
      const blob = (() => { const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true }); try { return (db.prepare("SELECT text FROM comms_messages WHERE thread = ? AND kind = 'message'").get(t.id) as { text: Buffer }).text; } finally { db.close(); } })();
      // It decrypts with comms.key, and with no other identity.
      expect(spawnSync('age', ['-d', '-i', join(h.home, COMMS_KEY)], { input: blob }).stdout.toString()).toBe('a planted secret phrase zebra-quokka');
      const otherKey = join(h.home, 'other.key');
      spawnSync('age-keygen', ['-o', otherKey]);
      expect(spawnSync('age', ['-d', '-i', otherKey], { input: blob }).status).not.toBe(0);
      rmSync(otherKey);
      await page(tok.jonathan, 'POST', `/comms/${t.id}/delete`, {});
      // secure_delete: the freed pages are zeroed, so not even the encrypted bytes stay in the file.
      expect(readFileSync(join(h.home, COMMS_DB)).includes(blob.subarray(40, 104))).toBe(false);
      expect((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).status).toBe(404);
      const other = await page(tok.sam, 'GET', `/comms/${t.id}`);
      const none = await page(tok.sam, 'GET', '/comms/th:aaaaaaaaaa');
      expect(other.status).toBe(403);
      expect(other.body).toEqual(none.body);
      const db = new BetterSqlite3(join(h.home, 'household.db'), { readonly: true });
      try {
        expect(db.prepare('SELECT id, member FROM comms_deleted WHERE id = ?').get(t.id)).toEqual({ id: t.id, member: 'jonathan' });
        expect(db.prepare('SELECT 1 FROM comms_threads WHERE id = ?').get(t.id)).toBeUndefined();
      } finally { db.close(); }
      const m = new BetterSqlite3(join(h.home, COMMS_DB));
      try {
        expect((m.prepare('SELECT COUNT(*) AS n FROM comms_messages WHERE thread = ?').get(t.id) as { n: number }).n).toBe(0);
      } finally { m.close(); }
    });

    it('keeps a channel number for good', async () => {
      const a = await open(tok.loren, 'pond-bot', 'ch a');
      const b = await open(tok.loren, 'pond-bot', 'ch b');
      expect(b.channel).toBe(a.channel + 1);
      await page(tok.loren, 'POST', `/comms/${b.id}/delete`, {});
      const c = await open(tok.loren, 'pond-bot', 'ch c');
      expect(c.channel).toBe(b.channel + 1);
    });
  });

  describe('criterion 9: history', () => {
    it('finishes a journaled deletion after restart without reopening its target', async () => {
      const t = await open();
      const post = { op: 'post', place: t.id, agent: 'art', ref: `continuation-${'d'.repeat(64)}`, text: 'accepted before deletion', expiresAt: Date.now() + 60000 };
      expect((await api(tok.runtime, 'comms/adapter', post)).body).toMatchObject({ ok: true });
      const threads = new BetterSqlite3(join(h.home, 'household.db'));
      try {
        threads.transaction(() => {
          threads.prepare('INSERT INTO comms_deleted (id, member, agent, channel, at) SELECT id, member, agent, channel, ? FROM comms_threads WHERE id = ?').run(new Date().toISOString(), t.id);
          threads.prepare('INSERT INTO comms_delete_pending (id) VALUES (?)').run(t.id);
          threads.prepare('DELETE FROM comms_threads WHERE id = ?').run(t.id);
        })();
      } finally { threads.close(); }
      // A crash can leave ciphertext/receipts, but deletion rejects all posts.
      expect((await api(tok.runtime, 'comms/adapter', post)).body).toMatchObject({ ok: false, permanent: true });
      expect((await api(tok.runtime, 'comms/adapter', { ...post, ref: `continuation-${'e'.repeat(64)}` })).body).toMatchObject({ ok: false, permanent: true });
      expect((await api(tok.runtime, 'comms/adapter', { ...post, op: 'reconcile' })).body).toEqual({ ok: true, state: 'deleted' });
      sweepComms(loadHousehold(h.home)!);
      sweepComms(loadHousehold(h.home)!); // Recovery is idempotent.
      expect((await api(tok.runtime, 'comms/adapter', post)).body).toMatchObject({ ok: false, permanent: true });
      expect((await api(tok.runtime, 'comms/adapter', { ...post, op: 'reconcile' })).body).toEqual({ ok: true, state: 'deleted' });
      const words = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true });
      const recovered = new BetterSqlite3(join(h.home, 'household.db'), { readonly: true });
      try {
        expect(words.prepare('SELECT COUNT(*) AS n FROM comms_messages WHERE thread = ?').get(t.id)).toEqual({ n: 0 });
        expect(words.prepare('SELECT COUNT(*) AS n FROM comms_asks WHERE thread = ?').get(t.id)).toEqual({ n: 0 });
        expect(recovered.prepare('SELECT id FROM comms_deleted WHERE id = ?').get(t.id)).toEqual({ id: t.id });
        expect(recovered.prepare('SELECT id FROM comms_delete_pending WHERE id = ?').get(t.id)).toBeUndefined();
      } finally { words.close(); recovered.close(); }
    });

    it('sweeps words past comms_days, keeps the row, and shows the digests in their place', async () => {
      const t = await open(tok.jonathan, 'art', 'old words');
      const db = new BetterSqlite3(join(h.home, COMMS_DB));
      try { db.prepare('UPDATE comms_messages SET at = ? WHERE thread = ?').run(new Date(Date.now() - 15 * 86_400_000).toISOString(), t.id); } finally { db.close(); }
      sweepComms(loadHousehold(h.home)!);
      recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: t.id, at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:runtime');
      writeDigest(agentDir(h, 'art'), { conversation: t.conversation, run: 'run-old' }, { summary: 'Talked through the old plan.' });
      const r = await page(tok.jonathan, 'GET', `/comms/${t.id}`);
      const msgs = r.body.messages as Array<{ kind: string; text: string | null }>;
      expect(msgs.find((m) => m.kind === 'message')?.text).toBeNull();
      expect(r.body.earlier).toEqual([expect.objectContaining({ summary: 'Talked through the old plan.' })]);
    });

    it('takes comms_days 1-14 and refuses anything else', () => {
      const raw = JSON.parse(readFileSync(join(h.home, 'household.json'), 'utf-8'));
      for (const bad of [0, 15, 2.5, '3']) {
        writeFileSync(join(h.home, 'household.json'), JSON.stringify({ ...raw, comms_days: bad }));
        expect(() => loadHousehold(h.home), String(bad)).toThrow(/comms_days/);
      }
      writeFileSync(join(h.home, 'household.json'), JSON.stringify({ ...raw, comms_days: 3 }));
      expect(loadHousehold(h.home)!.commsDays).toBe(3);
      writeFileSync(join(h.home, 'household.json'), JSON.stringify(raw));
      expect(loadHousehold(h.home)!.commsDays).toBe(14);
    });

    it('sweeps at comms_days', async () => {
      const t = await open(tok.jonathan, 'art', 'four days old');
      const db = new BetterSqlite3(join(h.home, COMMS_DB));
      try { db.prepare('UPDATE comms_messages SET at = ? WHERE thread = ?').run(new Date(Date.now() - 4 * 86_400_000).toISOString(), t.id); } finally { db.close(); }
      sweepComms(loadHousehold(h.home)!);
      expect(((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string | null }>).find((m) => m.kind === 'message')?.text).toBe('four days old');
      sweepComms({ ...loadHousehold(h.home)!, commsDays: 3 });
      expect(((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string | null }>).find((m) => m.kind === 'message')?.text).toBeNull();
    });

    it('names every Comms file the bundle refuses', () => {
      expect(COMMS_FILES).toEqual(expect.arrayContaining([COMMS_DB, COMMS_KEY, COMMS_SALT, `${COMMS_DB}-journal`]));
      expect(readFileSync(fileURLToPath(new URL('./bundle.ts', import.meta.url)), 'utf-8')).toMatch(/COMMS_FILES\.includes\(name\)/);
    });

    it('keeps its keys 0600 and its words in no file as plain bytes', async () => {
      await open(tok.jonathan, 'art', 'plainly-findable-marmoset-words');
      for (const f of [COMMS_KEY, COMMS_SALT]) expect(statSync(join(h.home, f)).mode & 0o777).toBe(0o600);
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : []);
      for (const f of walk(h.home)) {
        if (f.endsWith('runtime-calls.jsonl')) continue; // the stand-in runtime's own log of what it was handed
        expect(readFileSync(f).includes(Buffer.from('plainly-findable-marmoset-words')), f).toBe(false);
      }
    });
  });

  describe('criterion 10: live', () => {
    it('sends {seq} on the thread\'s stream, and the shared stream\'s change only to its member', async () => {
      const t = await open();
      const ac = new AbortController();
      const r = await fetch(`${base}/comms/${t.id}/events`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${tok.jonathan}` }, signal: ac.signal });
      expect(r.status).toBe(200);
      const shared = (token: string) => fetch(`${base}/events`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }, signal: ac.signal });
      const mine = await shared(tok.jonathan);
      const sams = await shared(tok.sam);
      const read = async (res: Response, until: RegExp, ms: number): Promise<string> => {
        const reader = res.body!.getReader();
        let got = '';
        const end = Date.now() + ms;
        while (Date.now() < end && !until.test(got)) {
          const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((res2) => setTimeout(() => res2({ done: true, value: undefined }), Math.max(1, end - Date.now())))]);
          if (chunk.done) break;
          got += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        return got;
      };
      await new Promise((res2) => setTimeout(res2, 200));
      const posted = Date.now();
      await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'live one' });
      const got = await read(r, /event: message\ndata: \{"seq":\d+\}/, 3000);
      expect(got).toMatch(/event: message\ndata: \{"seq":\d+\}\n/);
      expect(Date.now() - posted).toBeLessThan(400);
      expect(got).not.toMatch(/live one/);
      expect(await read(mine, /event: change/, 3500)).toMatch(/event: change/);
      // Readonly resolver opens can report unchanged memory WALs. They are no shared change,
      // even for another member who owns the same agent. Keep the production timer enabled.
      await resolveNeeds(h, pieceCheckers(process.env));
      expect(await read(sams, /event: change/, 2500)).not.toMatch(/event: change/);
      ac.abort();
    });
  });

  describe('criterion 10: reconnecting', () => {
    it('a stream opened with the last seq it had sends the newest at once when it moved', async () => {
      const t = await open();
      const first = await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'one' });
      await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'two' });
      const ac = new AbortController();
      const r = await fetch(`${base}/comms/${t.id}/events?from=${first.body.id}`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${tok.jonathan}` }, signal: ac.signal });
      expect(await readFor(r, /event: message/, 1500)).toMatch(new RegExp(`data: \\{"seq":${Number(first.body.id) + 1}\\}`));
      ac.abort();
      const since = await page(tok.jonathan, 'GET', `/comms/${t.id}/since/${first.body.id}`);
      expect((since.body.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['two']);
    });
  });

  describe('criterion 12: asks inline', () => {
    it('retains a continuation approval in its original thread when a later digest clears needs_owner', async () => {
      const t = await open();
      const other = await open();
      const child = 'cv-0000000000cc';
      writeFileSync(join(h.home, 'runtime-origins.json'), JSON.stringify({ [child]: t.conversation }));
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([{
        text: 'Continue the approved repair?', kind: 'permission', agent: 'art', conversation: child,
        actions: [{ action: 'allow', label: 'Allow', fields: { id: 'a-000000cc' } }, { action: 'deny', label: 'Deny', fields: { id: 'a-000000cc' } }],
      }]));
      clearPieceCache();
      try {
        const asks = async (thread: Thread) => (await page(tok.jonathan, 'GET', `/comms/${thread.id}`)).body.asks as Array<{ ref: string; state: string }>;
        expect(await asks(t)).toContainEqual(expect.objectContaining({ ref: 'approval:a-000000cc', state: 'open' }));
        recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: t.id, at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:origin-test');
        writeDigest(agentDir(h, 'art'), { conversation: t.conversation!, run: 'r-cleared-needs' }, { summary: 'Continued.', needs_owner: null } as never);
        expect(await asks(t)).toContainEqual(expect.objectContaining({ ref: 'approval:a-000000cc', state: 'open' }));
        expect(await asks(other)).not.toContainEqual(expect.objectContaining({ ref: 'approval:a-000000cc' }));
        expect((await page(tok.sam, 'GET', `/comms/${t.id}`)).status).toBe(403);
      } finally {
        rmSync(join(h.home, 'runtime-origins.json'), { force: true });
        rmSync(join(h.home, 'approvals-asks.json'), { force: true }); clearPieceCache();
      }
    });

    it('shows a pending approval only in its own thread: its conversation and its agent both', async () => {
      const t = await open();
      const other = await open();
      const ask = (id: string, conversation: string | undefined, agent: string) => ({
        text: `Can I ${id}?`, why: 'Because.', if_yes: 'I do it.', if_no: 'I don\'t.', fine: `relay · ${id}`, kind: 'permission', tone: 'warn', agent,
        ...(conversation ? { conversation } : {}),
        actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] });
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([
        ask('a-00000001', t.conversation, 'art'),          // this thread's own
        ask('a-00000002', other.conversation, 'art'),      // another thread's
        ask('a-00000003', undefined, 'art'),               // asked from no thread
        ask('a-00000004', t.conversation, 'mark'),         // naming this thread, but mark's: never here
      ]));
      clearPieceCache();
      const r = await page(tok.jonathan, 'GET', `/comms/${t.id}`);
      const asks = r.body.asks as Array<{ ref: string; key: string; state: string; text: string; if_yes: string; decide: { allow: { action: string }; deny: { action: string }; source: { id: string } } }>;
      expect(asks.map((a) => a.ref)).toEqual(['approval:a-00000001']);
      expect(asks[0]).toMatchObject({ state: 'open', kind: 'permission', text: 'Can I a-00000001?', why: 'Because.', if_yes: 'I do it.', fine: 'relay · a-00000001' });
      expect([asks[0].decide.allow.action, asks[0].decide.deny.action, asks[0].decide.source.id]).toEqual(['allow', 'deny', 'approvals']);
      // Whether it's still open, by its Inbox key (web/src/ask-open.ts): yes; and by the approval's id; a made-up one, no.
      expect((await page(tok.jonathan, 'GET', `/inbox/open?k=${asks[0].key}`)).body).toEqual({ open: true });
      expect((await page(tok.jonathan, 'GET', '/inbox/open?a=a-00000001')).body).toEqual({ open: true });
      expect((await page(tok.jonathan, 'GET', '/inbox/open?a=a-0000ffff')).body).toEqual({ open: false });
      // A need that waits on it (its digest's waits_on): the approval is drawn on the need, its own card leaves the
      // Inbox, and it's still open by its id.
      const cv = recordTurn(agentDir(h, 'art'), 'art', { venue: 'wake', place: 'lane:asks', label: 'asks', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' } as never, 'runtime:clock').conversation;
      writeDigest(agentDir(h, 'art'), { conversation: cv, run: 'r-waits' }, { summary: 'Asked.', needs_owner: { ask: 'OK to do the thing?', refs: ['a-00000001'],
        why: 'Because.', if_yes: 'I do it.', if_no: 'I don\'t.', waits_on: { approval: 'a-00000001' } } } as never);
      clearPieceCache();
      expect((await page(tok.jonathan, 'GET', '/inbox/open?a=a-00000001')).body).toEqual({ open: true });
      expect(((await page(tok.jonathan, 'GET', `/comms/${other.id}/since/0`)).body.asks as Array<{ ref: string }>).map((a) => a.ref)).toEqual(['approval:a-00000002']);
      // Another owner of art never sees it: the thread itself is refused.
      expect((await page(tok.sam, 'GET', `/comms/${t.id}`)).status).toBe(403);
      rmSync(join(h.home, 'approvals-asks.json'));
      clearPieceCache();
    });
  });

  describe('t-1979: one ask, in the thread and the Inbox; answered either place, the thread says who and when', () => {
    const permission = (id: string, conversation: string, agent = 'art') => ({ text: `Can I ${id}?`, why: 'Because.', if_yes: 'I do it.', if_no: 'I don\'t.', kind: 'permission', tone: 'warn', agent, conversation,
      at: new Date(Date.now() - 60_000 + Number.parseInt(id.slice(2), 16)).toISOString(),
      actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] });
    const act = (token: string, path: string, fields: Record<string, string>) => fetch(`${base}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-loom-fetch': '1', authorization: `Bearer ${token}` }, body: new URLSearchParams(fields) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as { ok?: boolean; message?: string } }));
    type View = { ref: string; key: string; state: string; text: string; answer?: { verdict: string; by?: string; at?: string }; yesNo?: true; reply?: { action: string; source: { act?: string } } };
    const asksOf = async (t: { id: string }, token = tok.jonathan) => (await page(token, 'GET', `/comms/${t.id}`)).body.asks as View[];

    it('an Allow from the thread (or the Inbox: the same /act) leaves the Inbox, and the thread keeps it, allowed by its member', async () => {
      const t = await open();
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([permission('a-00000021', t.conversation)]));
      rmSync(join(h.home, 'approvals-state.json'), { force: true });
      clearPieceCache();
      try {
        expect((await asksOf(t)).map((a) => [a.ref, a.state])).toEqual([['approval:a-00000021', 'open']]);
        const r = await act(tok.jonathan, '/act/approvals', { _action: 'allow', id: 'a-00000021' });
        expect(r.body).toMatchObject({ ok: true });
        clearPieceCache();
        expect((await page(tok.jonathan, 'GET', '/inbox/open?a=a-00000021')).body).toEqual({ open: false });
        const after = await asksOf(t);
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ ref: 'approval:a-00000021', state: 'answered', text: 'Can I a-00000021?', if_yes: 'I do it.', answer: { verdict: 'allowed', by: 'jonathan' } });
        expect(Date.parse(after[0].answer!.at!)).toBeGreaterThan(Date.now() - 60_000);
        // No buttons on an answered one.
        expect(after[0]).not.toHaveProperty('decide');
      } finally { rmSync(join(h.home, 'approvals-asks.json'), { force: true }); clearPieceCache(); }
    });

    it('one answered in the Inbox before the thread ever showed it is still kept, denied; one that left on its own says how', async () => {
      const t = await open();
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([permission('a-00000022', t.conversation), permission('a-00000023', t.conversation)]));
      rmSync(join(h.home, 'approvals-state.json'), { force: true });
      clearPieceCache();
      try {
        expect((await act(tok.jonathan, '/act/approvals', { _action: 'deny', id: 'a-00000022' })).body).toMatchObject({ ok: true });
        clearPieceCache();
        let v = await asksOf(t);
        expect(v.map((a) => [a.ref, a.state, a.answer?.verdict])).toEqual([['approval:a-00000022', 'answered', 'denied'], ['approval:a-00000023', 'open', undefined]]);
        // a-00000023 expires (the piece's own clock): out of the manifest, its state expired.
        writeFileSync(join(h.home, 'approvals-asks.json'), '[]');
        writeFileSync(join(h.home, 'approvals-state.json'), JSON.stringify({ 'a-00000022': { state: 'denied' }, 'a-00000023': { state: 'expired' } }));
        clearPieceCache();
        v = await asksOf(t);
        expect(v.map((a) => [a.ref, a.state, a.answer?.verdict, a.answer?.by])).toEqual([['approval:a-00000022', 'answered', 'denied', 'jonathan'], ['approval:a-00000023', 'answered', 'expired', undefined]]);
      } finally { rmSync(join(h.home, 'approvals-asks.json'), { force: true }); rmSync(join(h.home, 'approvals-state.json'), { force: true }); clearPieceCache(); }
    });

    it('a needs_owner raised in the thread: Yes and No and words, answered as the Inbox does, then kept: answered yes by its member', async () => {
      mode('ok');
      const t = await open();
      const art = agentDir(h, 'art');
      const cv = recordTurn(art, 'art', { venue: 'loom', place: t.id, label: 'thread', at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:runtime').conversation;
      expect(cv).toBe(t.conversation);
      const d = writeDigest(art, { conversation: cv, run: 'r-ask' }, { summary: 'Asked.', needs_owner: { ask: 'Ship the comm screen?', why: 'CI is green.', if_yes: 'I merge it.', if_no: 'It waits.', refs: ['t-5'], answers: 'yes-no' } } as never) as unknown as { id?: string };
      void d;
      let v = await asksOf(t);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ state: 'open', kind: 'question', text: 'Ship the comm screen?', why: 'CI is green.', if_yes: 'I merge it.', refs: ['t-5'], yesNo: true, reply: { action: 'needs-reply', source: { act: '/a/art/act/loom' } } });
      // Another member can't read it, nor answer it in its thread.
      expect((await page(tok.loren, 'GET', `/comms/${t.id}`)).status).toBe(403);
      const digest = v[0].ref.slice('digest:'.length);
      const r = await act(tok.jonathan, '/a/art/act/loom', { _action: 'needs-answer', conversation: t.conversation, digest, answer: 'yes' });
      expect(r.body).toMatchObject({ ok: true });
      v = await asksOf(t);
      expect(v.map((a) => [a.state, a.answer?.verdict, a.answer?.by])).toEqual([['answered', 'yes', 'jonathan']]);
    });

    it('an ask\'s kept words are sealed like the thread\'s, and swept with them; the answer stays', async () => {
      const t = await open();
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([permission('a-00000041', t.conversation)]));
      clearPieceCache();
      try {
        await asksOf(t);
        const row = () => { const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true }); try { return db.prepare('SELECT words, answer_json FROM comms_asks WHERE thread = ? AND ref = ?').get(t.id, 'approval:a-00000041') as { words: Buffer | null; answer_json: string | null }; } finally { db.close(); } };
        const w = row().words!;
        expect(w.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
        expect(w.toString('latin1')).not.toContain('Can I');
        expect((await act(tok.jonathan, '/act/approvals', { _action: 'allow', id: 'a-00000041' })).body).toMatchObject({ ok: true });
        clearPieceCache();
        sweepComms(h, new Date(Date.now() + 30 * 86_400_000));
        expect(row().words).toBeNull();
        expect(JSON.parse(row().answer_json!)).toMatchObject({ verdict: 'allowed', by: 'jonathan' });
        expect((await asksOf(t)).find((a) => a.ref === 'approval:a-00000041')).toMatchObject({ state: 'answered', text: '', answer: { verdict: 'allowed' } });
        // One a piece says was asked in the future still goes with the thread's words: by when loom kept it.
        writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([{ ...permission('a-00000042', t.conversation), at: new Date(Date.now() + 60 * 86_400_000).toISOString() }]));
        clearPieceCache();
        await asksOf(t);
        const fut = () => { const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true }); try { return db.prepare('SELECT words FROM comms_asks WHERE thread = ? AND ref = ?').get(t.id, 'approval:a-00000042') as { words: Buffer | null }; } finally { db.close(); } };
        expect(fut().words).not.toBeNull();
        sweepComms(h, new Date(Date.now() + 30 * 86_400_000));
        expect(fut().words).toBeNull();
      } finally { rmSync(join(h.home, 'approvals-asks.json'), { force: true }); clearPieceCache(); }
    });

    it('another member\'s answer never puts words into a thread that hadn\'t shown the ask; it answers one it had', async () => {
      // Sam's thread with art: the household owner sees its asks in his own Inbox and may answer them there.
      const t = await open(tok.sam, 'art', 'hi from sam');
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([permission('a-00000051', t.conversation), permission('a-00000052', t.conversation)]));
      rmSync(join(h.home, 'approvals-state.json'), { force: true });
      clearPieceCache();
      try {
        const rows = () => { const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true }); try { return (db.prepare('SELECT ref FROM comms_asks WHERE thread = ? ORDER BY ref').all(t.id) as Array<{ ref: string }>).map((r) => r.ref); } finally { db.close(); } };
        // a-00000051, answered by Jonathan before Sam's thread ever showed it: nothing kept in Sam's thread.
        expect((await act(tok.jonathan, '/act/approvals', { _action: 'allow', id: 'a-00000051' })).body).toMatchObject({ ok: true });
        clearPieceCache();
        expect(rows()).toEqual([]);
        // a-00000052, shown in Sam's thread, then denied by Jonathan: Sam's thread says so, by Jonathan.
        expect((await asksOf(t, tok.sam)).map((a) => [a.ref, a.state])).toEqual([['approval:a-00000052', 'open']]);
        expect((await act(tok.jonathan, '/act/approvals', { _action: 'deny', id: 'a-00000052' })).body).toMatchObject({ ok: true });
        clearPieceCache();
        writeFileSync(join(h.home, 'approvals-state.json'), JSON.stringify({ 'a-00000051': { state: 'allowed' }, 'a-00000052': { state: 'denied' } }));
        const v = await asksOf(t, tok.sam);
        expect(v.map((a) => [a.ref, a.state, a.answer?.verdict, a.answer?.by])).toEqual([['approval:a-00000052', 'answered', 'denied', 'jonathan']]);
        expect(rows()).toEqual(['approval:a-00000052']);
      } finally { rmSync(join(h.home, 'approvals-asks.json'), { force: true }); rmSync(join(h.home, 'approvals-state.json'), { force: true }); clearPieceCache(); }
    });

    it('an agent owner gets no Allow on a kind only the household owner gives, flagged or not; a merge, yes', async () => {
      const t = await open(tok.sam, 'art', 'hi from sam');
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([permission('a-00000061', t.conversation), permission('a-00000062', t.conversation), permission('a-00000063', t.conversation), permission('a-00000064', t.conversation)]));
      // a-63's state names no kind, a-64 the piece doesn't know: neither has an Allow for him.
      writeFileSync(join(h.home, 'approvals-state.json'), JSON.stringify({ 'a-00000061': { state: 'pending', agent: 'art', kind: 'vouch-wake' }, 'a-00000062': { state: 'pending', agent: 'art', kind: 'merge' }, 'a-00000063': { state: 'pending', agent: 'art' } }));
      clearPieceCache();
      try {
        const v = (await page(tok.sam, 'GET', `/comms/${t.id}`)).body.asks as Array<{ ref: string; decide?: unknown; ownerOnly?: true }>;
        expect(v.map((a) => [a.ref, !!a.decide, !!a.ownerOnly])).toEqual([['approval:a-00000061', false, true], ['approval:a-00000062', true, false], ['approval:a-00000063', false, true], ['approval:a-00000064', false, true]]);
      } finally { rmSync(join(h.home, 'approvals-asks.json'), { force: true }); rmSync(join(h.home, 'approvals-state.json'), { force: true }); clearPieceCache(); }
    });

    it('an approval asked from here stays here when a Needs you elsewhere waits on it; a Needs you here never carries another conversation\'s', async () => {
      const t = await open();
      const art = agentDir(h, 'art');
      // a-71, asked from this thread; a Needs you in a wake waits on it.
      const wake = recordTurn(art, 'art', { venue: 'wake', place: 'lane:w71', label: 'w71', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' } as never, 'runtime:clock').conversation;
      writeDigest(art, { conversation: wake, run: 'r-71' }, { summary: 'Waits.', needs_owner: { ask: 'OK to do the wake thing?', refs: ['a-00000071'], waits_on: { approval: 'a-00000071' } } } as never);
      // a-72, asked from the wake; a Needs you here waits on it.
      recordTurn(art, 'art', { venue: 'loom', place: t.id, label: 'thread', at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:runtime');
      writeDigest(art, { conversation: t.conversation, run: 'r-72' }, { summary: 'Waits too.', needs_owner: { ask: 'OK to do the thread thing?', refs: ['a-00000072'], waits_on: { approval: 'a-00000072' }, answers: 'yes-no' } } as never);
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([{ ...permission('a-00000071', t.conversation), text: 'Run the wake thing?' }, { ...permission('a-00000072', wake), text: 'Run the other thing?' }]));
      clearPieceCache();
      try {
        const v = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.asks as Array<{ ref: string; text: string; decide?: { allow: { fields: { id: string } } }; yesNo?: true; reply?: unknown }>;
        const own = v.find((a) => a.ref === 'approval:a-00000071');
        expect(own).toMatchObject({ text: 'Run the wake thing?', decide: { allow: { fields: { id: 'a-00000071' } } } });
        const need = v.find((a) => a.ref.startsWith('digest:'));
        expect(need).toMatchObject({ text: 'OK to do the thread thing?' });
        expect(need).not.toHaveProperty('decide');
        expect(need).not.toHaveProperty('yesNo');
        expect(JSON.stringify(v)).not.toContain('Run the other thing?');
      } finally { rmSync(join(h.home, 'approvals-asks.json'), { force: true }); clearPieceCache(); }
    });

    it('an answer goes through even when its thread can\'t keep it (comms.db read-only)', async () => {
      const t = await open();
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([permission('a-00000081', t.conversation)]));
      clearPieceCache();
      const db = join(h.home, COMMS_DB);
      try {
        await asksOf(t);
        chmodSync(db, 0o400);
        const r = await act(tok.jonathan, '/act/approvals', { _action: 'allow', id: 'a-00000081' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true });
      } finally { chmodSync(db, 0o600); rmSync(join(h.home, 'approvals-asks.json'), { force: true }); clearPieceCache(); }
    });

    it('the brief tells a body its asks show in the thread', async () => {
      const t = await open();
      const d = await api(tok.runtime, 'comms/adapter', { op: 'describe', place: t.id, agent: 'art' });
      const brief = d.body.brief as string[];
      expect(brief.length).toBeLessThanOrEqual(3);
      expect(brief.some((l) => /shows right here in the thread as a card with its buttons/.test(l))).toBe(true);
      expect(brief.every((l) => l.length <= 300)).toBe(true);
    });
  });

  describe('t-1979: the loom things a thread names, as chips, only what its member could open', () => {
    type Card = { kind: string; title: string; status?: string; page?: string; href?: string } | null;
    const refs = async (token: string, t: { id: string }, rs: string[]) => {
      const r = await page(token, 'GET', `/comms/${t.id}/refs?${rs.map((x) => `r=${encodeURIComponent(x)}`).join('&')}`);
      return { status: r.status, refs: r.body.refs as Record<string, Card> };
    };
    it('the household owner: agents, conversations, a pull request; nothing for what isn\'t there', async () => {
      const t = await open();
      // Its conversation, once the runtime has recorded a turn in it.
      recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: t.id, label: 'thread', at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:runtime');
      const r = await refs(tok.jonathan, t, ['agent:art', 'at:mark', t.conversation, 'github:acme/app#3', 'knowledge:no-such-page', 'project:nope', 'person:nobody', 't-99999', 'a-0000beef', 'bogus', 'note:x/y']);
      expect(r.status).toBe(200);
      expect(r.refs['agent:art']).toMatchObject({ kind: 'agent', page: 'a/art' });
      expect(r.refs['at:mark']).toMatchObject({ kind: 'agent', page: 'a/mark' });
      expect(r.refs[t.conversation]).toMatchObject({ kind: 'conv', page: `conversation/${t.conversation}` });
      expect(r.refs['github:acme/app#3']).toMatchObject({ kind: 'pr', title: 'acme/app#3', href: 'https://github.com/acme/app/issues/3' });
      for (const x of ['knowledge:no-such-page', 'project:nope', 'person:nobody', 't-99999', 'a-0000beef', 'note:x/y']) expect(r.refs[x], x).toBeNull();
      // A ref of no known shape isn't answered at all.
      expect(r.refs).not.toHaveProperty('bogus');
    });
    it('the household owner: a knowledge page, a project, a person and a note of the thread\'s agent; an agent owner: none of the first three', async () => {
      await knowledgeWrite(agentDir(h, 'art'), { slug: 'dns-health', title: 'DNS health', domain: 'homelab', body: 'It resolves.',
        citations: [{ claim: 'It resolves.', source_kind: 'docs', source_locator: 'https://example.com/dns', excerpt: 'It resolves.' }] } as never, 'art');
      { const st = openProjectsStore(agentDir(h, 'art'))!; try { st.write({ slug: 'pond', name: 'The Pond' } as never); } finally { st.close(); } }
      { const nt = new Notes(agentDir(h, 'art')); try { nt.write('pond/plan', 'The plan.', { lifespan: 'keep', by: 'art' }); } finally { nt.close(); } }
      const mine = await open();
      const r = await refs(tok.jonathan, mine, ['knowledge:dns-health', 'project:pond', 'person:sam', 'note:pond/plan']);
      expect(r.refs['knowledge:dns-health']).toMatchObject({ kind: 'knowledge', title: 'DNS health', page: 'knowledge/dns-health' });
      expect(r.refs['project:pond']).toMatchObject({ kind: 'project', title: 'The Pond', page: 'projects/pond' });
      expect(r.refs['person:sam']).toMatchObject({ kind: 'person', page: 'people/sam' });
      expect(r.refs['note:pond/plan']).toMatchObject({ kind: 'note', title: 'pond/plan' });
      const sams = await open(tok.sam, 'art', 'hi again');
      // A conversation of mark's (sam owns art only): a card for Jonathan, words for Sam.
      const marks = recordTurn(agentDir(h, 'mark'), 'mark', { venue: 'wake', place: 'lane:x', label: 'mark lane', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' } as never, 'runtime:clock').conversation;
      expect((await refs(tok.jonathan, mine, [marks])).refs[marks]).toMatchObject({ kind: 'conv', title: 'mark lane' });
      expect((await refs(tok.sam, sams, [marks])).refs[marks]).toBeNull();
      const s = await refs(tok.sam, sams, ['knowledge:dns-health', 'project:pond', 'person:sam', 'note:pond/plan']);
      for (const x of ['knowledge:dns-health', 'project:pond', 'person:sam']) expect(s.refs[x], x).toBeNull();
      // The note is his own thread's agent's.
      expect(s.refs['note:pond/plan']).toMatchObject({ kind: 'note' });
    });
    it('an agent owner: their own agent only; another agent, Knowledge, people and projects stay words; another\'s thread is refused', async () => {
      const t = await open(tok.sam, 'art', 'hi from sam');
      const r = await refs(tok.sam, t, ['agent:art', 'at:mark', 'agent:mark', 'knowledge:dns', 'person:jonathan', 'project:pond']);
      expect(r.refs['agent:art']).toMatchObject({ kind: 'agent' });
      for (const x of ['at:mark', 'agent:mark', 'knowledge:dns', 'person:jonathan', 'project:pond']) expect(r.refs[x], x).toBeNull();
      expect((await refs(tok.loren, t, ['agent:art'])).status).toBe(403);
      expect((await refs(tok.jonathan, t, ['agent:art'])).status).toBe(403);
    });
    it('an approval pending in the reader\'s own Inbox, from elsewhere, is a chip too', async () => {
      const t = await open();
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([{ text: 'Can I deploy?', kind: 'permission', agent: 'art', conversation: 'cv-0000000000aa',
        actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id: 'a-00000091' } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id: 'a-00000091' } }] }]));
      clearPieceCache();
      try {
        expect((await refs(tok.jonathan, t, ['a-00000091'])).refs['a-00000091']).toMatchObject({ kind: 'approval', title: 'Can I deploy?', status: 'Waiting on you' });
        // Loren (pond-bot's owner) has no such approval in his Inbox: words.
        const lorens = await open(tok.loren, 'pond-bot', 'hi');
        expect((await refs(tok.loren, lorens, ['a-00000091'])).refs['a-00000091']).toBeNull();
      } finally { rmSync(join(h.home, 'approvals-asks.json'), { force: true }); clearPieceCache(); }
    });
    it('answers at most 60 refs a read, and only refs of a known shape', async () => {
      const t = await open();
      const asked = Array.from({ length: 70 }, (_, i) => `agent:a${i}`);
      expect(Object.keys((await refs(tok.jonathan, t, asked)).refs)).toHaveLength(60);
      const odd = await refs(tok.jonathan, t, ['evil:x', 'note:a/../b', 't-1"x', 'agent:art']);
      expect(Object.keys(odd.refs)).toEqual(['agent:art']);
    });
    it('a task: the tasks piece\'s card for the household owner, at most 20 a read; for an agent owner, only what his thread\'s work knows', async () => {
      const t = await open();
      const r = await refs(tok.jonathan, t, ['t-7', 't-5000']);
      expect(r.refs['t-7']).toMatchObject({ kind: 'task', title: 'Task t-7', status: 'Closed', page: 'p/tasks/task/t-7' });
      expect(r.refs['t-5000']).toBeNull();
      const many = await refs(tok.jonathan, t, Array.from({ length: 30 }, (_, i) => `t-${100 + i}`));
      expect(Object.values(many.refs).filter((x) => x !== null)).toHaveLength(20);
      const sams = await open(tok.sam, 'art', 'tasks?');
      expect((await refs(tok.sam, sams, ['t-7'])).refs['t-7']).toBeNull();
    });
    it('an approval is a chip in its own thread, with its state', async () => {
      const t = await open();
      writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify([{ text: 'Can I merge?', kind: 'permission', agent: 'art', conversation: t.conversation,
        actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id: 'a-00000031' } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id: 'a-00000031' } }] }]));
      clearPieceCache();
      try {
        expect((await refs(tok.jonathan, t, ['a-00000031'])).refs['a-00000031']).toMatchObject({ kind: 'approval', title: 'Can I merge?', status: 'Waiting on you', page: 'inbox' });
        // Sam owns art too, but the thread isn't his: refused whole.
        expect((await refs(tok.sam, t, ['a-00000031'])).status).toBe(403);
      } finally { rmSync(join(h.home, 'approvals-asks.json'), { force: true }); clearPieceCache(); }
    });
  });

  describe('criterion 12: asks inline, scoped as the Inbox is', () => {
    it('an agent owner sees no ask from a household-only piece; the household owner does', async () => {
      const mine = await open();
      const lorens = await open(tok.loren, 'pond-bot', 'pond things');
      const ask = (id: string, conversation: string, agent: string) => ({ text: `Can I ${id}?`, kind: 'permission', agent, conversation,
        actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] });
      writeFileSync(join(h.home, 'household-asks.json'), JSON.stringify([ask('a-0000000a', mine.conversation, 'art'), ask('a-0000000b', lorens.conversation, 'pond-bot')]));
      clearPieceCache();
      try {
        expect(((await page(tok.jonathan, 'GET', `/comms/${mine.id}`)).body.asks as Array<{ ref: string; decide: { source: { id: string } } }>).map((a) => [a.ref, a.decide.source.id])).toEqual([['ask:deskonly:a-0000000a', 'deskonly']]);
        expect((await page(tok.loren, 'GET', `/comms/${lorens.id}`)).body.asks).toEqual([]);
        expect((await page(tok.loren, 'GET', `/comms/${lorens.id}/since/0`)).body.asks).toEqual([]);
        // Another piece's ask, allowed from the thread (the same /act): kept answered, never taken for an approval's id.
        const r = await fetch(`${base}/act/deskonly`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}` },
          body: new URLSearchParams({ _action: 'allow', id: 'a-0000000a' }) });
        expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
        clearPieceCache();
        const after = (await page(tok.jonathan, 'GET', `/comms/${mine.id}`)).body.asks as Array<{ ref: string; state: string; answer?: { verdict: string; by: string } }>;
        expect(after.map((a) => [a.ref, a.state, a.answer?.verdict, a.answer?.by])).toEqual([['ask:deskonly:a-0000000a', 'answered', 'allowed', 'jonathan']]);
      } finally { rmSync(join(h.home, 'household-asks.json')); clearPieceCache(); }
    });
  });

  describe('t-1881: on its way, delivered, or not; working only while the runtime says so', () => {
    const state = async (t: { id: string }) => (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.thread as { state: { working: boolean; failed: boolean } };
    it('working clears when the runtime says done', async () => {
      const t = await open();
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'working' });
      expect((await state(t)).state.working).toBe(true);
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done' });
      expect((await state(t)).state.working).toBe(false);
    });
    it('working clears when the runtime stops saying it (its body gone, its done lost), and comes back with its next word', async () => {
      const t = await open();
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'working' });
      // Its beat, within the window: still working.
      expect(settleThread(h.home, t.id, new Date(Date.now() + WORKING_STALE_MS - 5000))).toBe(false);
      expect((await state(t)).state.working).toBe(true);
      // Past it, with no word: recorded as not working.
      expect(settleThread(h.home, t.id, new Date(Date.now() + WORKING_STALE_MS + 1000))).toBe(true);
      expect((await state(t)).state.working).toBe(false);
      await api(tok.runtime, 'comms/activity', { conversation: t.conversation, run: 'r9', cards: [{ id: 'k1', at: new Date().toISOString(), tool: 'Read', summary: 'Read a file', state: 'running' }] });
      expect((await state(t)).state.working).toBe(true);
    });
    it('a send cut off (loom restarted under it) is recorded not delivered, and Send again delivers it once', async () => {
      const t = await open();
      const id = mid(n++);
      const before = deliveries().length;
      const a = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'cut off' });
      await settled(t.id);
      // As if its delivery's process died: back on its way, begun long ago.
      const db = new BetterSqlite3(join(h.home, COMMS_DB));
      try { db.prepare('UPDATE comms_messages SET delivered = NULL, sending_at = ? WHERE thread = ? AND seq = ?').run(Date.now() - SEND_STALE_MS - 1000, t.id, a.body.seq); } finally { db.close(); }
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ seq: number; kind: string; delivery?: string; text: string }>;
      expect(msgs.find((m) => m.seq === a.body.seq)?.delivery).toBe('failed');
      expect(msgs.at(-1)).toMatchObject({ kind: 'error', text: 'Art couldn\'t be reached: loom restarted while it was delivering it.' });
      expect((await state(t)).state.failed).toBe(true);
      const again = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'cut off' });
      expect(again.body).toMatchObject({ seq: a.body.seq, delivery: 'sending', repeat: true });
      await settled(t.id);
      // The same delivery id both times: its first try had reached the runtime, so core answers the kept answer and the
      // runtime hears it once, never a second body; the message is delivered.
      expect(deliveries().length - before).toBe(1);
      expect(deliveries().at(-1)!.id).toBe(`comms:${t.id}:${id}`);
      const after = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ seq: number; delivery?: string }>;
      expect(after.find((m) => m.seq === a.body.seq)?.delivery).toBe('delivered');
      expect((await state(t)).state.failed).toBe(false);
    });
    it('Send again takes a failed message back on its way once: a second take, while it\'s on its way, takes nothing', async () => {
      const t = await open();
      const db = new BetterSqlite3(join(h.home, COMMS_DB));
      const seq = (() => { try { return (db.prepare("SELECT seq FROM comms_messages WHERE thread = ? AND kind = 'message'").get(t.id) as { seq: number }).seq; } finally { db.close(); } })();
      const d2 = new BetterSqlite3(join(h.home, COMMS_DB));
      try { d2.prepare('UPDATE comms_messages SET delivered = 0, sending_at = NULL WHERE thread = ? AND seq = ?').run(t.id, seq); } finally { d2.close(); }
      expect(resendMessage(h, t as unknown as Thread, seq)).toBe(true);
      expect(resendMessage(h, t as unknown as Thread, seq)).toBe(false);
    });
    it('a store made before t-1881 gains its columns in place: a send, a read and the sweep all work on it', async () => {
      const home = mkdtempSync(join(tmpdir(), 'loom-comms-old-'));
      try {
        const m = new BetterSqlite3(join(home, COMMS_DB));
        m.exec(`CREATE TABLE comms_messages (thread TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, sender TEXT NOT NULL, id TEXT NOT NULL,
          hash TEXT, text BLOB, card_json TEXT, run TEXT, delivered INTEGER, PRIMARY KEY (thread, seq))`);
        m.prepare("INSERT INTO comms_messages VALUES ('th:aaaaaaaaaa', 1, ?, 'message', 'jonathan', 'aaaaaaaaaaaaaaaa', NULL, NULL, NULL, NULL, 0)").run(new Date().toISOString());
        m.close();
        const t = new BetterSqlite3(join(home, 'household.db'));
        t.exec(`CREATE TABLE comms_threads (id TEXT PRIMARY KEY, agent TEXT NOT NULL, member TEXT NOT NULL, conversation TEXT NOT NULL, title TEXT, titled_by TEXT,
          project TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived TEXT, opened TEXT NOT NULL, last TEXT NOT NULL, read_seq INTEGER NOT NULL DEFAULT 0,
          channel INTEGER NOT NULL, first_id TEXT NOT NULL, first_hash TEXT NOT NULL, working_since TEXT, queued_since TEXT, last_failed INTEGER NOT NULL DEFAULT 0,
          stop INTEGER NOT NULL DEFAULT 0, in_front INTEGER, updated INTEGER NOT NULL)`);
        t.prepare("INSERT INTO comms_threads (id, agent, member, conversation, opened, last, channel, first_id, first_hash, working_since, updated) VALUES ('th:aaaaaaaaaa', 'art', 'jonathan', 'cv-0123456789ab', ?, ?, 1, 'aaaaaaaaaaaaaaaa', 'x', ?, 0)")
          .run(new Date().toISOString(), new Date().toISOString(), new Date(Date.now() - 3_600_000).toISOString());
        t.close();
        expect(settleThread(home, null)).toBe(true);
        expect(threadState(home, 'th:aaaaaaaaaa')).toContain('null');
        const cols = (f: string, table: string) => { const d = new BetterSqlite3(join(home, f), { readonly: true }); try { return (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name); } finally { d.close(); } };
        expect(cols(COMMS_DB, 'comms_messages')).toEqual(expect.arrayContaining(['sending_at', 'delivery_json']));
        expect(cols('household.db', 'comms_threads')).toContain('working_beat');
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('a message on its way, not stale, is not marked failed by a read', async () => {
      const t = await open();
      const db = new BetterSqlite3(join(h.home, COMMS_DB));
      const seq = (() => { try { return (db.prepare("SELECT seq FROM comms_messages WHERE thread = ? AND kind = 'message'").get(t.id) as { seq: number }).seq; } finally { db.close(); } })();
      const d2 = new BetterSqlite3(join(h.home, COMMS_DB));
      try { d2.prepare('UPDATE comms_messages SET delivered = NULL, sending_at = ? WHERE thread = ? AND seq = ?').run(Date.now() - 1000, t.id, seq); } finally { d2.close(); }
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ seq: number; delivery?: string }>;
      expect(msgs.find((m) => m.seq === seq)?.delivery).toBe('sending');
    });
  });

  describe('criterion 13: errors, in words', () => {
    it('a send without age is refused, nothing delivered, and the thread says why', async () => {
      const t = await open();
      const before = deliveries().length;
      const saved2 = process.env.LOOM_AGE;
      process.env.LOOM_AGE = join(h.home, 'no-such-age');
      try {
        const r = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id: mid(n++), text: 'no age here' });
        expect(r.status).toBe(503);
      } finally { if (saved2 === undefined) delete process.env.LOOM_AGE; else process.env.LOOM_AGE = saved2; }
      expect(deliveries().length).toBe(before);
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string }>;
      expect(msgs.at(-1)).toMatchObject({ kind: 'error', text: 'loom can\'t keep messages safely right now: the age program is missing.' });
      expect(msgs.some((m) => m.text === 'no age here')).toBe(false);
    });
    it('a loop pause is stated in words', async () => {
      const t = await open();
      const r = await api(tok.runtime, 'conversations/turn', { agent: 'art', venue: 'loom', place: t.id, at: new Date().toISOString(), from: { kind: 'agent', id: 'art' }, kind: 'note', run: 'run-1', outcome: 'deferred' });
      expect(r.status).toBe(200);
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string }>;
      expect(msgs.at(-1)).toMatchObject({ kind: 'error', text: 'Paused: Art was repeating itself.' });
    });
    describe('t-1946: a start that fails after the runtime answered queued', () => {
      type M = { kind: string; id: string; seq: number; text: string; card: Record<string, unknown> | null };
      const msgs = async (t: { id: string }) => (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as M[];
      const errs = async (t: { id: string }) => (await msgs(t)).filter((m) => m.kind === 'error');
      const row = (t: { id: string }) => {
        const db = new BetterSqlite3(join(h.home, 'household.db'), { readonly: true });
        try { return db.prepare('SELECT queued_since, last_failed FROM comms_threads WHERE id = ?').get(t.id) as { queued_since: string | null; last_failed: number }; } finally { db.close(); }
      };
      const queued = async () => { mode('queued'); const t = await open(); mode('ok'); const first = (await msgs(t)).find((m) => m.kind === 'message')!; return { t, delivery: `comms:${t.id}:${first.id}` }; };
      const notice = (t: { id: string }, body: Record<string, unknown>) => api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', ...body });
      const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

      it("a continuation report from another run leaves the holder's queued message waiting (review of loom#682)", async () => {
        const { t } = await queued();
        expect(row(t).queued_since).not.toBeNull();
        const report = { op: 'post', agent: 'art', place: t.id, text: 'Follow-up from an earlier run', expiresAt: Date.now() + 60000, run: 'run-0123456789ab', ref: `continuation-${'9'.repeat(64)}` };
        expect((await api(tok.runtime, 'comms/adapter', report)).body).toMatchObject({ ok: true });
        expect(row(t).queued_since).not.toBeNull(); // the busy line can still follow
        expect((await api(tok.runtime, 'comms/adapter', { op: 'post', agent: 'art', place: t.id, text: 'The answer' })).body).toMatchObject({ ok: true });
        expect(row(t).queued_since).toBeNull();
      });
      it('says it is retrying, one line per message moved on by later attempts, and a start-failed of the same attempt still lands', async () => {
        const { t, delivery } = await queued();
        expect(row(t).queued_since).not.toBeNull();
        expect((await notice(t, { status: 'start-retry', messages: [delivery], attempt: 1, retry_at: at(1), reason: 'host timed out in 60 s' })).body).toEqual({ ok: true });
        expect(row(t).queued_since).toBeNull(); // no busy line follows
        let e = await errs(t);
        expect(e).toHaveLength(1);
        expect(e[0]).toMatchObject({ text: 'Art couldn\'t start; retrying.', card: { error: 'start-retry', attempt: 1, reason: 'host timed out in 60 s' } });
        expect(typeof e[0].card?.retry_at).toBe('string');
        // The same attempt again, then an older one after a newer: nothing moves.
        await notice(t, { status: 'start-retry', messages: [delivery], attempt: 1, retry_at: at(1) });
        await notice(t, { status: 'start-retry', messages: [delivery], attempt: 2, retry_at: at(4) });
        await notice(t, { status: 'start-retry', messages: [delivery], attempt: 1, retry_at: at(1) });
        e = await errs(t);
        expect(e).toHaveLength(1);
        expect(e[0]).toMatchObject({ text: 'Art couldn\'t start (2 tries so far); retrying.', card: { attempt: 2 } });
        // Given up at the same attempt as the last retry: still said.
        await notice(t, { status: 'start-failed', messages: [delivery], attempt: 2, reason: 'no house would start' });
        e = await errs(t);
        expect(e).toHaveLength(1);
        // Fixed words: the runtime's reason is the trace's, never the headline.
        expect(e[0]).toMatchObject({ text: 'Art couldn\'t start after 2 tries.', card: { error: 'start-failed', attempt: 2, reason: 'no house would start' } });
        expect(e[0].card?.retry_at).toBeUndefined();
        expect(row(t).last_failed).toBe(1);
        const traced = (() => { const db = new BetterSqlite3(join(h.home, 'household.db'), { readonly: true }); try { return traceOf(h.home, db.prepare('SELECT * FROM comms_threads WHERE id = ?').get(t.id) as Parameters<typeof traceOf>[1]); } finally { db.close(); } })();
        expect(traced.messages.filter((m) => m.error).at(-1)?.error).toEqual({ code: 'start-failed', words: 'Art couldn\'t start after 2 tries.', reason: 'no house would start' });
        // After a start-failed, a delayed retry never brings the line back.
        await notice(t, { status: 'start-retry', messages: [delivery], attempt: 3, retry_at: at(10) });
        expect((await errs(t))[0].card).toMatchObject({ error: 'start-failed' });
      });

      it('updates the line the first answer made, rather than adding a second', async () => {
        const { t, delivery } = await queued();
        const seq = (await msgs(t)).find((m) => m.kind === 'message')!.seq;
        // As if the first answer had said "no body could start" (t-1918): its card is e<seq>.
        await notice(t, { status: 'start-retry', messages: [delivery], attempt: 1, retry_at: at(1) });
        expect((await errs(t)).map((m) => m.id)).toEqual([`e${seq}`]);
      });

      it('a late notice changes nothing once the body is going, or after it', async () => {
        const { t, delivery } = await queued();
        await notice(t, { status: 'start-retry', messages: [delivery], attempt: 1, retry_at: at(1) });
        await notice(t, { status: 'working', messages: [delivery] });
        await notice(t, { status: 'start-retry', messages: [delivery], attempt: 2, retry_at: at(4) });
        await notice(t, { status: 'done' });
        await notice(t, { status: 'start-retry', messages: [delivery], attempt: 3, retry_at: at(10) });
        await notice(t, { status: 'start-failed', messages: [delivery], attempt: 3 });
        const e = await errs(t);
        expect(e).toHaveLength(1);
        expect(e[0]).toMatchObject({ text: 'Art couldn\'t start at first.', card: { error: 'start-retry', attempt: 1, settled: true } });
        expect(row(t).last_failed).toBe(0);
        // A message already answered: its first notice, arriving late, adds no line.
        const second = await queued();
        await api(tok.runtime, 'comms/adapter', { op: 'post', place: second.t.id, agent: 'art', text: 'here now' });
        await notice(second.t, { status: 'start-retry', messages: [second.delivery], attempt: 1, retry_at: at(1) });
        expect(await errs(second.t)).toEqual([]);
      });

      it('refuses a bad shape, and takes one for a thread that is gone', async () => {
        const { t, delivery } = await queued();
        for (const bad of [
          { status: 'start-retry', messages: [delivery], retry_at: at(1) },
          { status: 'start-retry', messages: [delivery], attempt: 0, retry_at: at(1) },
          { status: 'start-retry', messages: [delivery], attempt: 1 },
          { status: 'start-retry', messages: [delivery], attempt: 1, retry_at: 'soon' },
          { status: 'start-failed', messages: [delivery], attempt: 1, retry_at: at(1) },
          { status: 'start-failed', messages: [delivery], attempt: 1, reason: 'two\nlines' },
          { status: 'start-failed', messages: [delivery], attempt: 1, reason: 'x'.repeat(201) },
          { status: 'start-failed', messages: 'one', attempt: 1 },
          { status: 'sleeping' },
        ]) expect((await notice(t, bad)).status).toBe(400);
        expect(await errs(t)).toEqual([]);
        const gone = await queued();
        await page(tok.jonathan, 'POST', `/comms/${gone.t.id}/archive`, {});
        expect((await notice(gone.t, { status: 'start-failed', messages: [gone.delivery], attempt: 1 })).body).toEqual({ ok: true });
      });
    });

    it('says a start that failed in words', async () => {
      mode('failed');
      const t = await open();
      mode('ok');
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string }>;
      expect(msgs.find((m) => m.kind === 'error')?.text).toBe('Art couldn\'t start: no box is logged in.');
    });
    it('says a refusal in words, never a bare code', async () => {
      mode('refuse');
      const t = await open();
      mode('ok');
      const e = ((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string }>).find((m) => m.kind === 'error')!;
      expect(e.text).toBe('Art didn\'t get that: no such thing.');
      expect(e.text).not.toMatch(/^\d{3}$/);
    });
  });
  it('runtime continuation receipts survive retries and bind the entire payload behind runtime auth', async () => {
    mode('ok');
    const t = await open();
    const other = await open();
    const q = { op: 'post', agent: 'art', place: t.id, text: 'Continuation finished', expiresAt: Date.now() + 60000, run: 'run-0123456789ab', on: 'Codex', ref: `continuation-${'a'.repeat(64)}` };
    // Neither an agent, owner-member, nor unrelated piece can use this adapter.
    const pieceToken = createToken(h, { role: { kind: 'piece', piece: 'runtime', subject: 'x' }, label: 'continuation-negative' }).token;
    for (const token of [tok.art, tok.jonathan, pieceToken]) {
      expect((await api(token, 'comms/adapter', q)).status).toBe(403);
    }
    const first = await api(tok.runtime, 'comms/adapter', q);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, id: expect.any(String) });
    const retries = await Promise.all(Array.from({ length: 4 }, () => api(tok.runtime, 'comms/adapter', q)));
    for (const retry of retries) expect(retry).toEqual(first);
    for (const change of [{ text: 'changed' }, { place: other.id }, { agent: 'mark' }, { run: 'run-ffffffffffff' }, { on: 'Claude' }, { expiresAt: q.expiresAt + 1 }]) {
      expect((await api(tok.runtime, 'comms/adapter', { ...q, ...change })).status).toBe(409);
    }
    expect((await api(tok.runtime, 'comms/adapter', { ...q, ref: 'continuation-forged' })).status).toBe(400);
    const messages = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ text: string }>;
    expect(messages.filter(m => m.text === q.text)).toHaveLength(1);
    // First submissions racing across requests also yield one row and one receipt.
    const race = { ...q, ref: `continuation-${'b'.repeat(64)}`, text: 'Concurrent first submission' };
    const answers = await Promise.all(Array.from({ length: 4 }, () => api(tok.runtime, 'comms/adapter', race)));
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS n FROM comms_messages WHERE id = ?").get(race.ref)).toEqual({ n: 1 }); } finally { db.close(); }
  }, 20000);
  it('fences continuation cutoff, legacy lookup, reconciliation and persistent clock rollback', async () => {
    mode('ok');
    const t = await open();
    const q = { op: 'post', agent: 'art', place: t.id, text: 'Cutoff report', expiresAt: Date.now() + 60000, ref: `continuation-${'1'.repeat(64)}` };
    for (const value of [null, '123', 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect((await api(tok.runtime, 'comms/adapter', { ...q, expiresAt: value })).status).toBe(400);
    }
    const first = await api(tok.runtime, 'comms/adapter', q);
    expect(first.body.ok).toBe(true);
    const missing = { ...q, ref: `continuation-${'2'.repeat(64)}` };
    expect((await api(tok.runtime, 'comms/adapter', { ...missing, op: 'reconcile' })).body.state).toBe('unresolved');
    for (const token of [tok.art, tok.jonathan]) expect((await api(token, 'comms/adapter', { ...q, op: 'reconcile' })).status).toBe(403);
    // Model an already persisted pre-deadline-protocol receipt without rewriting its hash.
    const old = { op: 'post', agent: 'art', place: t.id, text: 'Legacy accepted report', ref: `continuation-${'5'.repeat(64)}` };
    const accepted = await api(tok.runtime, 'comms/adapter', { ...old, expiresAt: q.expiresAt });
    const legacyDb = new BetterSqlite3(join(h.home, COMMS_DB));
    legacyDb.prepare('UPDATE comms_messages SET hash = ? WHERE id = ?').run(wordsHash(h.home, JSON.stringify({ agent: old.agent, place: old.place, text: old.text, run: null, on: null })), old.ref);
    legacyDb.close();
    expect(await api(tok.runtime, 'comms/adapter', old)).toEqual(accepted);
    expect((await api(tok.runtime, 'comms/adapter', { ...old, op: 'reconcile' })).body).toMatchObject({ state: 'delivered', id: accepted.body.id });
    expect((await api(tok.runtime, 'comms/adapter', { ...old, expiresAt: q.expiresAt })).status).toBe(409);
    const realNow = Date.now();
    try {
      vi.spyOn(Date, 'now').mockReturnValue(q.expiresAt);
      expect(adapterCall(h, process.env, q)).toEqual(first.body);
      expect(adapterCall(h, process.env, { ...q, op: 'reconcile' })).toMatchObject({ state: 'delivered', id: first.body.id });
      expect(adapterCall(h, process.env, { ...missing, op: 'reconcile' })).toMatchObject({ state: 'not-accepted' });
      expect(() => adapterCall(h, process.env, missing)).toThrow('deadline reached');
      expect(() => adapterCall(h, process.env, { ...q, expiresAt: q.expiresAt + 1 })).toThrow('different payload');
      // Reopening the store with a backwards wall clock holds both admission and negative reconciliation.
      vi.spyOn(Date, 'now').mockReturnValue(realNow);
      expect(adapterCall(h, process.env, { ...missing, op: 'reconcile' })).toMatchObject({ state: 'unresolved' });
      expect(() => adapterCall(h, process.env, missing)).toThrow('clock moved backwards');
      // A hold, not a refusal: 503, so the runtime retries the same ref rather than giving the report up.
      try { adapterCall(h, process.env, missing); } catch (e) { expect((e as { status?: number }).status).toBe(503); }
      const { expiresAt: _, ...legacy } = missing;
      expect(adapterCall(h, process.env, { ...legacy, op: 'reconcile' })).toMatchObject({ state: 'unresolved' });
      expect(() => adapterCall(h, process.env, legacy)).toThrow();
    } finally {
      vi.restoreAllMocks();
      const db = new BetterSqlite3(join(h.home, COMMS_DB));
      db.prepare('DELETE FROM comms_continuation_clock').run(); db.close();
    }
    const locked = new BetterSqlite3(join(h.home, COMMS_DB));
    locked.exec('BEGIN IMMEDIATE');
    try {
      expect((await api(tok.runtime, 'comms/adapter', { ...missing, op: 'reconcile', expiresAt: realNow - 1 })).body).toMatchObject({ ok: true, state: 'unresolved' });
    } finally { locked.exec('ROLLBACK'); locked.close(); }
  }, 20000);

  it('checks the authoritative cutoff after slow encryption rather than request arrival', async () => {
    mode('ok'); const t = await open();
    const dir = mkdtempSync(join(tmpdir(), 'slow-comms-age-'));
    const age = spawnSync('sh', ['-c', 'command -v age'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(dir, 'age'), `#!${process.execPath}
      const fs = require('node:fs'); const cp = require('node:child_process');
      const input = fs.readFileSync(0);
      fs.writeFileSync(${JSON.stringify(join(dir, 'encrypted'))}, 'called');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      const r = cp.spawnSync(${JSON.stringify(age)}, process.argv.slice(2), { input });
      process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status);
    `); chmodSync(join(dir, 'age'), 0o755);
    const q = { op: 'post', agent: 'art', place: t.id, text: 'Delayed past cutoff', expiresAt: Date.now() + 150, ref: `continuation-${'3'.repeat(64)}` };
    try {
      expect(() => adapterCall(h, { ...process.env, PATH: `${dir}:${process.env.PATH}` }, q)).toThrow('deadline reached');
      expect(existsSync(join(dir, 'encrypted'))).toBe(true);
      expect(adapterCall(h, process.env, { ...q, op: 'reconcile' })).toMatchObject({ state: 'not-accepted' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('waits for an earlier accepted writer before reconciling after cutoff', async () => {
    mode('ok'); const t = await open();
    const dir = mkdtempSync(join(tmpdir(), 'comms-cutoff-race-'));
    const q = { op: 'post', agent: 'art', place: t.id, text: 'Earlier writer', expiresAt: Date.now() + 3000, ref: `continuation-${'4'.repeat(64)}` };
    const worker = (script: string) => {
      const child = spawnChild(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(), env: { ...process.env, CUTOFF_QUERY: JSON.stringify(q), CUTOFF_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
      const done = new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${code}: ${err}`))));
      return { child, done, output: () => out };
    };
    const imports = `
      import Database from 'better-sqlite3';
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { adapterCall } from './src/comms.ts';
      import { loadHousehold } from './src/household.ts';
      const dir = process.env.CUTOFF_DIR, q = JSON.parse(process.env.CUTOFF_QUERY);
    `;
    const writer = worker(imports + `
      const prepare = Database.prototype.prepare;
      Database.prototype.prepare = function(sql) {
        const st = prepare.call(this, sql);
        if (sql.startsWith('INSERT INTO comms_messages ')) {
          const run = st.run.bind(st);
          st.run = (...args) => {
            writeFileSync(join(dir, 'paused'), 'yes');
            const end = Date.now() + 15000;
            while (!existsSync(join(dir, 'release'))) {
              if (Date.now() > end) throw new Error('writer release timeout');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
            return run(...args);
          };
        }
        return st;
      };
      console.log(JSON.stringify(adapterCall(loadHousehold(process.env.LOOM_HOME), process.env, q)));
    `);
    let fence: ReturnType<typeof worker> | undefined;
    const wait = async (predicate: () => boolean) => {
      const end = Date.now() + 12000;
      while (!predicate()) {
        if (Date.now() > end) throw new Error('race checkpoint timeout');
        await new Promise(r => setTimeout(r, 20));
      }
    };
    try {
      await wait(() => existsSync(join(dir, 'paused')));
      expect(Date.now()).toBeLessThan(q.expiresAt);
      await new Promise(r => setTimeout(r, Math.max(1, q.expiresAt - Date.now() + 30)));
      fence = worker(imports + `
        writeFileSync(join(dir, 'fencing'), 'yes');
        console.log(JSON.stringify(adapterCall(loadHousehold(process.env.LOOM_HOME), process.env, { ...q, op: 'reconcile' })));
      `);
      await wait(() => existsSync(join(dir, 'fencing')));
      await new Promise(r => setTimeout(r, 150));
      expect(fence.output()).toBe('');
      writeFileSync(join(dir, 'release'), 'yes');
      await Promise.all([writer.done, fence.done]);
      const receipt = JSON.parse(writer.output());
      expect(JSON.parse(fence.output())).toEqual({ ...receipt, state: 'delivered' });
      expect((await api(tok.runtime, 'comms/adapter', q)).body).toEqual(receipt);
    } finally {
      writeFileSync(join(dir, 'release'), 'yes');
      writer.child.kill('SIGKILL'); fence?.child.kill('SIGKILL');
      await Promise.allSettled([writer.done, ...(fence ? [fence.done] : [])]);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25000);

  it('retries one continuation after killing the core writer after commit and before its reply', async () => {
    mode('ok');
    const t = await open();
    const q = { op: 'post', agent: 'art', place: t.id, text: 'Durable acceptance before SIGKILL', expiresAt: Date.now() + 60000, ref: `continuation-${'c'.repeat(64)}` };
    // Execute the actual core adapter/database in another process. Its caller
    // receives no receipt: the worker stops at the post-commit boundary.
    const worker = spawnChild(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { adapterCall } from './src/comms.ts';
      import { loadHousehold } from './src/household.ts';
      adapterCall(loadHousehold(process.env.LOOM_HOME), process.env, JSON.parse(process.env.CONTINUATION_TEST_POST));
      process.stdout.write('committed\\n');
      setInterval(() => {}, 1000);
    `], { cwd: process.cwd(), env: { ...process.env, CONTINUATION_TEST_POST: JSON.stringify(q) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    worker.stderr.on('data', b => { stderr += b; });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`writer never committed: ${stderr}`)), 15000);
        worker.stdout.once('data', () => { clearTimeout(deadline); resolve(); });
        worker.once('exit', code => { clearTimeout(deadline); reject(new Error(`writer exited ${code}: ${stderr}`)); });
      });
      const ended = new Promise<void>(resolve => worker.once('exit', (_code, signal) => { expect(signal).toBe('SIGKILL'); resolve(); }));
      worker.kill('SIGKILL');
      await ended;
      // A different core process (the HTTP listener) reopens the database and
      // recovers the original sequence, without any in-memory receipt cache.
      const first = await api(tok.runtime, 'comms/adapter', q);
      expect(first.status).toBe(200);
      expect(await api(tok.runtime, 'comms/adapter', q)).toEqual(first);
      const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true });
      try {
        expect(db.prepare("SELECT seq, COUNT(*) AS n FROM comms_messages WHERE id = ?").get(q.ref)).toEqual({ seq: Number(first.body.id), n: 1 });
      } finally { db.close(); }
    } finally { worker.kill('SIGKILL'); }
  }, 25000);
  it('runtime spawns appear as their own Comms thread, return reports once, and owner steering reaches the same conversation', async () => {
    mode('ok');
    const parent = await open();
    recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: parent.id, at: new Date().toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' }, 'runtime:runtime');
    const child = recordTurn(agentDir(h, 'art'), 'art', { venue: 'spawn', place: 'sp-test', label: 'spawn test', at: new Date().toISOString(), from: { kind: 'agent', id: 'art' }, kind: 'message' }, 'runtime:runtime');
    const q = { op: 'spawn', agent: 'art', conversation: child.conversation, parent: parent.conversation, text: 'Reply ok', run: 'run-0123456789ab' };
    expect((await api(tok.art, 'comms/adapter', q)).status).toBe(403);
    const a = await api(tok.runtime, 'comms/adapter', q);
    expect(a.status).toBe(200);
    const id = a.body.id as string;
    expect(id).toMatch(/^th:/);
    expect((await api(tok.runtime, 'comms/adapter', q)).body.id).toBe(id);
    const thread = await page(tok.jonathan, 'GET', `/comms/${id}`);
    expect(thread.body.thread).toMatchObject({ conversation: child.conversation, title: 'spawn test' });
    expect(thread.body.messages[0]).toMatchObject({ kind: 'message', from: 'art' });
    // Assigned ownership permits reading a job; it does not make it a personal chat.
    expect((await page(tok.jonathan, 'GET', '/comms')).body.threads.map((t: Thread) => t.id)).not.toContain(id);
    expect((await page(tok.jonathan, 'GET', '/comms?background=1')).body.threads.map((t: Thread) => t.id)).toContain(id);
    expect((await page(tok.sam, 'GET', '/comms?background=1')).body.threads.map((t: Thread) => t.id)).not.toContain(id);
    expect((await page(tok.jonathan, 'GET', '/comms/agents')).body.agents.find((a: {agent: string}) => a.agent === 'art').last.thread).not.toBe(id);
    expect((await page(tok.sam, 'GET', `/comms/${id}`)).status).toBe(403);
    expect(JSON.stringify((await page(tok.jonathan, 'GET', `/comms/${parent.id}`)).body.messages)).toContain(id.replace(/^th:/, ''));
    const post = { op: 'post', agent: 'art', place: id, text: 'ok', run: 'run-0123456789ab', ref: 'spawn-run-0123456789ab' };
    await api(tok.runtime, 'comms/adapter', post);
    await api(tok.runtime, 'comms/adapter', post);
    const msgs = (await page(tok.jonathan, 'GET', `/comms/${id}`)).body.messages as Array<{text: string}>;
    expect(msgs.filter((m) => m.text === 'ok')).toHaveLength(1);
    await page(tok.jonathan, 'POST', `/comms/${id}/send`, { id: mid(n++), text: 'Try yes instead' });
    await settled(id);
    expect(deliveries().at(-1)).toMatchObject({ venue: 'spawn', place: 'sp-test', from: { kind: 'person', slug: 'jonathan' }, text: 'Try yes instead' });
    expect((await page(tok.jonathan, 'GET', '/comms')).body.threads.map((t: Thread) => t.id)).toContain(id);
    expect((await page(tok.jonathan, 'GET', '/comms?background=1')).body.threads.map((t: Thread) => t.id)).not.toContain(id);
  });


});
