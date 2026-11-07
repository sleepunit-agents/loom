/**
 * Comms (docs/specs/comms.md): the core venue `loom`, its thread store, and the owner-only rule enforced by the
 * server. Each describe names the spec's acceptance criterion. Needs the `age` and `age-keygen` programs (CI installs
 * age).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { parseLoomBlock, runtimePieces } from './cli/pieces-managed.js';
import { conversationId, createConversationTables, recordTurn, writeDigest } from './backends/conversations.js';
import { COMMS_DB, COMMS_FILES, COMMS_KEY, COMMS_SALT, placeFor, resendMessage, SEND_STALE_MS, settleThread, sweepComms, threadState, WORKING_STALE_MS, type Thread } from './comms.js';
import { createHash, createHmac } from 'node:crypto';
import { clearPieceCache } from './ui/pieces.js';
import { stopCommsWatch } from './ui/comms-live.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'api') {
    fs.appendFileSync(home + '/runtime-api.jsonl', input + '\\n');
    return console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: '{}', stderr: '' } }));
  }
  fs.appendFileSync(home + '/runtime-calls.jsonl', input + '\\n');
  const mode = fs.existsSync(home + '/runtime-mode') ? fs.readFileSync(home + '/runtime-mode', 'utf-8').trim() : 'ok';
  if (mode === 'said') { console.log(JSON.stringify({ status: 503, error: 'no house free for art' })); process.exit(1); }
  if (mode === 'refuse') { console.log(JSON.stringify({ status: 400, error: 'bad-input: no such thing' })); process.exit(1); }
  const d = JSON.parse(input);
  console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: 1, body: mode === 'failed' ? 'failed' : 'started', ...(mode === 'failed' ? { reason: 'no box is logged in' } : {}) }));
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
  const mode = (m: 'ok' | 'said' | 'refuse' | 'failed') => writeFileSync(join(h.home, 'runtime-mode'), m);
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
if (process.argv[2] === 'ui' && process.argv[3] === '--json') {
  const f = process.env.LOOM_HOME + '/approvals-asks.json';
  console.log(JSON.stringify({ v: 2, owners: 2, asks: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : [] }));
} else process.exit(2);
`);
    // A piece that doesn't understand agent owners (no owners: 2): the household owner's only, as the Inbox has it.
    piece(h.home, 'deskonly', {}, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'ui' && process.argv[3] === '--json') {
  const f = process.env.LOOM_HOME + '/household-asks.json';
  console.log(JSON.stringify({ v: 2, asks: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : [] }));
} else process.exit(2);
`);
    piece(h.home, 'runtime', { role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'], venues: { relay: { label: 'Relay', kind: 'agent', send: ['loom-runtime', 'relay-send'] } } }, RUNTIME_BIN);
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
        ['POST', `/comms/${t.id}/stop`, {}], ['POST', `/comms/${t.id}/delete`, {}],
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

    it('shows working, clears it on done, and answers stop once after Stop', async () => {
      const t = await open();
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'working' });
      expect(((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.thread as { state: { working: boolean } }).state.working).toBe(true);
      await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'done' });
      expect(((await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.thread as { state: { working: boolean } }).state.working).toBe(false);
      await page(tok.jonathan, 'POST', `/comms/${t.id}/stop`, {});
      expect((await api(tok.runtime, 'comms/adapter', { op: 'status', place: t.id, agent: 'art', status: 'working' })).body).toEqual({ ok: true, stop: true });
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

  describe('criterion 5 (core): activity', () => {
    const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, at: new Date().toISOString(), tool: 'Bash', summary: 'Ran the tests', state: 'running', ...extra });
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
      expect(apiCalls().some((c) => JSON.stringify(c).includes(`"deliver","end","${t.conversation}"`))).toBe(true);
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
      const asks = r.body.asks as Array<{ id: string; piece: string; text: string; if_yes: string; actions: Array<{ action: string }> }>;
      expect(asks.map((a) => a.id)).toEqual(['a-00000001']);
      expect(asks[0]).toMatchObject({ piece: 'approvals', text: 'Can I a-00000001?', if_yes: 'I do it.' });
      expect(asks[0].actions.map((a) => a.action)).toEqual(['allow', 'deny']);
      // Whether it's still open, by the id the thread's answer gives (web/src/ask-open.ts): yes; a made-up one, no.
      expect((await page(tok.jonathan, 'GET', `/inbox/open?a=${asks[0].id}`)).body).toEqual({ open: true });
      expect((await page(tok.jonathan, 'GET', '/inbox/open?a=a-0000ffff')).body).toEqual({ open: false });
      // A need that waits on it (its digest's waits_on): the approval is drawn on the need, its own card leaves the
      // Inbox, and it's still open by its id.
      const cv = recordTurn(agentDir(h, 'art'), 'art', { venue: 'wake', place: 'lane:asks', label: 'asks', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' } as never, 'runtime:clock').conversation;
      writeDigest(agentDir(h, 'art'), { conversation: cv, run: 'r-waits' }, { summary: 'Asked.', needs_owner: { ask: 'OK to do the thing?', refs: ['a-00000001'],
        why: 'Because.', if_yes: 'I do it.', if_no: 'I don\'t.', waits_on: { approval: 'a-00000001' } } } as never);
      clearPieceCache();
      expect((await page(tok.jonathan, 'GET', `/inbox/open?a=${asks[0].id}`)).body).toEqual({ open: true });
      expect(((await page(tok.jonathan, 'GET', `/comms/${other.id}/since/0`)).body.asks as Array<{ id: string }>).map((a) => a.id)).toEqual(['a-00000002']);
      // Another owner of art never sees it: the thread itself is refused.
      expect((await page(tok.sam, 'GET', `/comms/${t.id}`)).status).toBe(403);
      rmSync(join(h.home, 'approvals-asks.json'));
      clearPieceCache();
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
        expect(((await page(tok.jonathan, 'GET', `/comms/${mine.id}`)).body.asks as Array<{ id: string; piece: string }>).map((a) => [a.id, a.piece])).toEqual([['a-0000000a', 'deskonly']]);
        expect((await page(tok.loren, 'GET', `/comms/${lorens.id}`)).body.asks).toEqual([]);
        expect((await page(tok.loren, 'GET', `/comms/${lorens.id}/since/0`)).body.asks).toEqual([]);
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
});
