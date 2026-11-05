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
import { COMMS_DB, COMMS_FILES, COMMS_KEY, COMMS_SALT, placeFor, sweepComms } from './comms.js';
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
  const open = async (token = tok.jonathan, agent = 'art', text = 'hello art') => {
    const r = await page(token, 'POST', '/comms/new', { agent, id: mid(n++), text });
    expect(r.status).toBe(200);
    return (r.body.thread as { id: string; conversation: string; channel: number });
  };

  beforeAll(async () => {
    clearPieceCache();
    h = household('loom-comms-');
    process.env.LOOM_HOME = h.home;
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
      const b = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'second' });
      expect(a.body).toMatchObject({ delivered: true });
      expect(b.body).toMatchObject({ seq: a.body.seq, delivered: true, repeat: true });
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
      expect(a.body).toMatchObject({ delivered: false });
      mode('ok');
      const before = deliveries().length;
      const b = await page(tok.jonathan, 'POST', `/comms/${t.id}/send`, { id, text: 'try me' });
      expect(b.body).toMatchObject({ seq: a.body.seq, delivered: true });
      expect(deliveries().length - before).toBe(1);
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; delivered: boolean | null; seq: number }>;
      expect(msgs.find((m) => m.seq === a.body.seq)?.delivered).toBe(true);
    });
  });

  describe('criterion 4: the adapter route', () => {
    it('posts a reply to a live thread, and refuses for good where it can\'t', async () => {
      const t = await open();
      const ok = await api(tok.runtime, 'comms/adapter', { op: 'post', place: t.id, agent: 'art', text: 'hi jonathan' });
      expect(ok.body).toMatchObject({ ok: true });
      const msgs = (await page(tok.jonathan, 'GET', `/comms/${t.id}`)).body.messages as Array<{ kind: string; text: string; from: string }>;
      expect(msgs.at(-1)).toMatchObject({ kind: 'reply', text: 'hi jonathan', from: 'art' });
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
    });

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
