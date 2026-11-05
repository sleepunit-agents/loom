/**
 * Work in a Comms thread (docs/specs/comms.md, "Work in this thread", criteria 20–23), through the server: the refs
 * index as messages land, the sweep and delete, the backfill, the panel's route over fake pieces, the owners gate,
 * the `from` block on a piece's page, and the hub's --conversation. Needs `age` (CI installs it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { parseLoomBlock, runtimePieces } from './cli/pieces-managed.js';
import { createConversationTables } from './backends/conversations.js';
import { COMMS_DB, sweepComms } from './comms.js';
import { backfillRefs, refsOf } from './comms-work.js';
import { managedPieceSections, threadFeedArgs } from './project-feeds.js';
import { clearPieceCache } from './ui/pieces.js';
import { stopCommsWatch } from './ui/comms-live.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

const RUNTIME_BIN = `#!${process.execPath}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'api') return console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: '{}', stderr: '' } }));
  console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: 1, body: 'started' }));
});
`;

/** A fake piece with a thread feed: it records its argv and stdin, and answers the file `<name>-answer.json`. */
const feedPiece = (name: string, owners: boolean) => `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
if (process.argv[2] === 'ui' && process.argv[3] === '--json') {
  console.log(JSON.stringify({ v: 2, ${owners ? 'owners: 2, ' : ''}tab: { label: '${name}' }, asks: [] }));
  process.exit(0);
}
if (process.argv[2] === 'ui' && process.argv[3] === 'page') {
  const f = home + '/${name}-page.json';
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : JSON.stringify({ title: 'x', sections: [] }));
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(home + '/${name}-calls.jsonl', JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + '\\n');
  if (process.argv[2] === 'project-feed') return console.log(JSON.stringify({ groups: [] }));
  const f = home + '/${name}-answer.json';
  if (fs.existsSync(home + '/${name}-fail')) process.exit(3);
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : JSON.stringify({ items: [] }));
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

function household(): Household {
  const home = mkdtempSync(join(tmpdir(), 'loom-work-'));
  for (const a of ['art', 'pond-bot']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({
    v: 1, agents: ['art', 'pond-bot'], default: 'art', github: 'acme', members: [
      { person: 'jonathan', role: 'owner', agents: '*' },
      { person: 'sam', role: 'owner', agents: ['art'] },
      { person: 'loren', role: 'owner', agents: ['pond-bot'] },
    ],
  }));
  return loadHousehold(home)!;
}

const mid = (n: number) => `a${String(n).padStart(15, '0').replace(/[0189]/g, (d) => ({ '0': 'a', '1': 'b', '8': 'c', '9': 'd' } as Record<string, string>)[d])}`;
const PLANT = 'zebracorn';

describe.skipIf(!hasAge)('Work in this thread', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;
  let n = 300;

  const req = async (token: string | undefined, method: string, path: string, body?: unknown, accept = 'application/json') => {
    const r = await fetch(`${base}${path}`, {
      method, headers: { accept, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* a page */ }
    return { status: r.status, body: json, text };
  };
  const open = async (text: string, token = tok.jonathan) => {
    const r = await req(token, 'POST', '/comms/new', { agent: 'art', id: mid(n++), text });
    expect(r.status, r.text).toBe(200);
    return r.body.thread as { id: string; conversation: string };
  };
  const reply = async (place: string, text: string) => {
    const r = await fetch(`${base}/api/loom/comms/adapter`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.runtime}` },
      body: JSON.stringify({ op: 'post', place, agent: 'art', text }) });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  };
  const calls = (name: string) => {
    const f = join(h.home, `${name}-calls.jsonl`);
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; stdin: string }) : [];
  };

  beforeAll(async () => {
    clearPieceCache();
    h = household();
    process.env.LOOM_HOME = h.home;
    piece(h.home, 'runtime', { role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'] }, RUNTIME_BIN);
    piece(h.home, 'tasks', { sections: { project: { label: 'Tasks', argv: ['loom-tasks', 'project-feed'] }, thread: { label: 'Tasks', argv: ['loom-tasks', 'thread-feed', '--json'] } } }, feedPiece('tasks', true));
    piece(h.home, 'changes', { sections: { thread: { label: 'Changes', argv: ['loom-changes', 'thread-feed', '--json'] } } }, feedPiece('changes', false));
    piece(h.home, 'old', { sections: { project: { label: 'Old', argv: ['loom-old', 'project-feed'] } } }, feedPiece('old', true));
    for (const m of ['jonathan', 'sam', 'loren']) tok[m] = createToken(h, { role: { kind: 'owner', member: m }, label: m }).token;
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

  describe('criterion 20: the index', () => {
    it('keeps the refs a message and a reply name, and no words', async () => {
      const t = await open(`see t-12, acme/app#3 and note:pond/plan, ${PLANT} at-12 x/acme/app#4 notes:x cv-0123456789ab https://e.test/p`);
      await reply(t.id, 'made t-40, and web#7 too');
      expect(refsOf(h.home, t.id).map((r) => r.ref).sort()).toEqual(['github:acme/app#3', 'github:acme/web#7', 'note:pond/plan', 't-12', 't-40']);
      const db = new BetterSqlite3(join(h.home, 'household.db'), { readonly: true });
      const rows = JSON.stringify(db.prepare('SELECT * FROM comms_refs').all());
      db.close();
      expect(rows).not.toContain(PLANT);
      expect(readFileSync(join(h.home, 'household.db')).includes(Buffer.from(PLANT))).toBe(false);
    });

    it('outlives the sweep, and goes with a delete', async () => {
      const t = await open('about t-77');
      const db = new BetterSqlite3(join(h.home, COMMS_DB));
      db.prepare("UPDATE comms_messages SET at = '2026-01-01T00:00:00.000Z' WHERE thread = ?").run(t.id);
      db.close();
      sweepComms(h);
      const m = await req(tok.jonathan, 'GET', `/comms/${t.id}`);
      expect((m.body.messages as Array<{ text: unknown }>)[0].text).toBeNull();
      expect(refsOf(h.home, t.id).map((r) => r.ref)).toEqual(['t-77']);
      expect((await req(tok.jonathan, 'POST', `/comms/${t.id}/delete`, {})).status).toBe(200);
      expect(refsOf(h.home, t.id)).toEqual([]);
    });

    it('keeps at most 200 per thread, dropping the one named longest ago', async () => {
      const t = await open('first, t-1');
      await reply(t.id, Array.from({ length: 200 }, (_, i) => `t-${1000 + i}`).join(' '));
      let refs = refsOf(h.home, t.id).map((r) => r.ref);
      expect(refs).toHaveLength(200);
      expect(refs).not.toContain('t-1');
      const u = await open(Array.from({ length: 201 }, (_, i) => `t-${2000 + i}`).join(' '));
      refs = refsOf(h.home, u.id).map((r) => r.ref);
      expect(refs).toHaveLength(200);
      expect(refs).not.toContain('t-2000');
      expect(refs).toContain('t-2200');
      expect(refs[0]).toBe('t-2200');
    });

    it('backfills older threads once, and a second start reads nothing', async () => {
      const t = await open('the old one, t-901');
      const hh = new BetterSqlite3(join(h.home, 'household.db'));
      hh.prepare('DELETE FROM comms_refs WHERE thread = ?').run(t.id);
      hh.prepare("DELETE FROM comms_meta WHERE key = 'refs_backfilled'").run();
      hh.close();
      expect(await backfillRefs(h, process.env)).toBeGreaterThan(0);
      expect(refsOf(h.home, t.id).map((r) => r.ref)).toEqual(['t-901']);
      const again = new BetterSqlite3(join(h.home, 'household.db'));
      again.prepare('DELETE FROM comms_refs WHERE thread = ?').run(t.id);
      expect(again.prepare("SELECT value FROM comms_meta WHERE key = 'refs_backfilled'").get()).toBeTruthy();
      again.close();
      expect(await backfillRefs(h, process.env)).toBe(0);
      expect(refsOf(h.home, t.id)).toEqual([]);
    });

    it('runs at daemon start', async () => {
      const t = await open('started fresh, t-902');
      const hh = new BetterSqlite3(join(h.home, 'household.db'));
      hh.prepare('DELETE FROM comms_refs WHERE thread = ?').run(t.id);
      hh.prepare("DELETE FROM comms_meta WHERE key = 'refs_backfilled'").run();
      hh.close();
      const second = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
      try {
        for (let i = 0; i < 100 && !refsOf(h.home, t.id).length; i++) await new Promise((r) => setTimeout(r, 50));
        expect(refsOf(h.home, t.id).map((r) => r.ref)).toEqual(['t-902']);
      } finally { await second.close(); }
    });
  });

  describe('criterion 21: the feed', () => {
    it('asks each piece with the conversation, the refs newest first and the caller; merges, dedupes and orders', async () => {
      const t = await open('look at t-1');
      await reply(t.id, 'and acme/app#3');
      writeFileSync(join(h.home, 'tasks-answer.json'), JSON.stringify({ items: [
        { title: 'Old task', ref: 't-1', status: 'Open', when: '2026-11-01T00:00:00Z', page: 'task/t-1' },
        { title: 'Blocked task', ref: 't-2', status: 'Blocked', tone: 'bad', when: '2026-11-02T00:00:00Z', page: 'task/t-2', made: true },
        { title: 'Same change', ref: 'github:acme/app#3', status: 'Open', page: 'task/t-3' },
      ] }));
      writeFileSync(join(h.home, 'changes-answer.json'), JSON.stringify({ items: [
        { title: 'app#3 Fix', ref: 'github:acme/app#3', status: 'Waiting on you', tone: 'warn', when: '2026-11-03T00:00:00Z', page: 'c/github/acme/app/3', made: true },
        { title: 'app#9 Merged', ref: 'github:acme/app#9', status: 'Merged', tone: 'ok', when: '2026-11-04T00:00:00Z', href: 'https://github.com/acme/app/pull/9' },
      ] }));
      const r = await req(tok.jonathan, 'GET', `/comms/${t.id}/work`);
      expect(r.status, r.text).toBe(200);
      const items = r.body.items as Array<{ ref: string; status: string; url?: string; made?: true; from: string }>;
      expect(items.map((i) => i.ref)).toEqual(['t-2', 'github:acme/app#3', 'github:acme/app#9', 't-1']);
      expect(items[1]).toMatchObject({ status: 'Waiting on you', made: true, from: 'changes', url: '/p/changes/c/github/acme/app/3' });
      expect(items[0].url).toBe('/p/tasks/task/t-2');
      expect(r.body.failed).toEqual([]);
      const c = calls('tasks').at(-1)!;
      expect(c.argv).toEqual(['thread-feed', '--json', '--conversation', t.conversation, '--ref', 'github:acme/app#3', '--ref', 't-1']);
      expect(JSON.parse(c.stdin)).toEqual({ caller: { kind: 'owner', who: 'jonathan', agents: '*' } });
    });

    it('a broken answer is that piece alone, by its label', async () => {
      const t = await open('t-1 again');
      writeFileSync(join(h.home, 'changes-answer.json'), JSON.stringify({ items: [{ title: 'x', ref: 'x', status: 'x'.repeat(25) }] }));
      const r = await req(tok.jonathan, 'GET', `/comms/${t.id}/work`);
      expect(r.body.failed).toEqual(['Changes']);
      expect((r.body.items as unknown[]).length).toBeGreaterThan(0);
      writeFileSync(join(h.home, 'tasks-fail'), '');
      const r2 = await req(tok.jonathan, 'GET', `/comms/${t.id}/work`);
      expect(r2.body.failed).toEqual(['Changes', 'Tasks']);
      rmSync(join(h.home, 'tasks-fail'));
    });

    it('is a 403 for a member who doesn\'t own the agent and for a second owner; a partial owner asks only owners: 2 pieces', async () => {
      const t = await open('mine, t-1');
      expect((await req(tok.loren, 'GET', `/comms/${t.id}/work`)).status).toBe(403);
      expect((await req(tok.sam, 'GET', `/comms/${t.id}/work`)).status).toBe(403);
      // A piece with owners: 2 and nothing else to show (no tab, no asks) is still asked.
      piece(h.home, 'quiet', { sections: { thread: { label: 'Quiet', argv: ['loom-quiet', 'thread-feed'] } } }, feedPiece('quiet', true).replace("tab: { label: 'quiet' }, ", ''));
      clearPieceCache();
      const ts = await open('sam\'s own, t-1', tok.sam);
      const before = calls('changes').length;
      const r = await req(tok.sam, 'GET', `/comms/${ts.id}/work`);
      expect(r.status).toBe(200);
      expect(calls('changes').length).toBe(before); // changes has no owners: 2: never asked for sam
      expect(JSON.parse(calls('tasks').at(-1)!.stdin).caller).toEqual({ kind: 'owner', who: 'sam', agents: ['art'] });
      expect(calls('quiet').length).toBe(1);
      rmSync(join(h.home, 'pieces', 'bin', 'loom-quiet'));
      rmSync(join(h.home, 'pieces', 'quiet'), { recursive: true });
      clearPieceCache();
    });
  });

  describe('the brief names the source to pass', () => {
    it('describe\'s first line gives the thread\'s conversation as --source', async () => {
      const t = await open('brief me');
      const r = await fetch(`${base}/api/loom/comms/adapter`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.runtime}` },
        body: JSON.stringify({ op: 'describe', place: t.id, agent: 'art' }) });
      const brief = ((await r.json()) as { brief: string[] }).brief;
      expect(brief[0]).toContain(`its source: conversation:${t.conversation}`);
      expect(brief[0].length).toBeLessThanOrEqual(300);
    });
  });

  describe('criterion 22: from', () => {
    it('draws the block per viewer: a link for the thread\'s member, words for anyone else, nothing of the thread', async () => {
      const t = await open('the frame');
      expect((await req(tok.jonathan, 'POST', `/comms/${t.id}/title`, { title: 'Comm screen frame' })).status).toBe(200);
      writeFileSync(join(h.home, 'tasks-page.json'), JSON.stringify({ title: 'A task', sections: [
        { id: 'from', place: 'side', blocks: [{ type: 'from', conversation: t.conversation }] },
        { id: 'other', blocks: [{ type: 'from', conversation: 'cv-ffffffffffff' }] },
        { id: 'sheet', blocks: [{ type: 'panel', rows: [{ label: 'Where', value: 'see', sheet: { blocks: [{ type: 'from', conversation: t.conversation }] } }] }] },
      ] }));
      clearPieceCache();
      const blocks = async (who: string) => {
        const r = await req(tok[who], 'GET', '/p/tasks/task/t-1');
        expect(r.status, r.text).toBe(200);
        return { json: r.text, blocks: ((r.body as { page: { sections: Array<{ blocks: Array<Record<string, unknown>> }> } }).page.sections).map((s) => s.blocks[0]) };
      };
      const j = await blocks('jonathan');
      expect(j.blocks[0]).toEqual({ type: 'link', text: 'From: Comm screen frame', page: `loom:comms/${t.id}` });
      expect(j.blocks[1]).toMatchObject({ type: 'text', text: 'From a conversation' });
      const s = await blocks('sam');
      expect(s.blocks[0]).toMatchObject({ type: 'text', text: 'From a Comms thread' });
      const l = await blocks('loren');
      expect(l.blocks[0]).toMatchObject({ type: 'text', text: 'From a conversation' });
      expect(JSON.stringify(j.blocks[2])).toContain('From: Comm screen frame');
      expect(JSON.stringify(s.blocks[2])).toContain('From a Comms thread');
      for (const x of [s, l]) {
        expect(x.json).not.toContain('Comm screen frame');
        expect(x.json).not.toContain(t.id);
      }
      const html = await req(tok.sam, 'GET', '/p/tasks/task/t-1', undefined, 'text/html');
      expect(html.text).not.toContain('Comm screen frame');
    });
  });

  describe('criterion 23: the hub', () => {
    it('passes --conversation for the project\'s filed threads, newest first', async () => {
      const db = new BetterSqlite3(join(h.home, 'household.db'));
      const any = db.prepare('SELECT id, conversation FROM comms_threads LIMIT 1').get() as { id: string; conversation: string };
      db.prepare("UPDATE comms_threads SET project = 'pond' WHERE id = ?").run(any.id);
      db.close();
      expect(threadFeedArgs(agentDir(h, 'art'), 'pond', { ...process.env, LOOM_HOME: h.home })).toEqual(['--conversation', any.conversation]);
      const env = { ...process.env, LOOM_HOME: h.home };
      await managedPieceSections(env)({ card: { slug: 'pond', name: 'Pond', status: 'active', links: {} } as never, since: new Date().toISOString(), contextDir: agentDir(h, 'art') });
      expect(calls('tasks').at(-1)!.argv.slice(-2)).toEqual(['--conversation', any.conversation]);
      expect(calls('old').at(-1)!.argv).not.toContain('--conversation');
    });
  });
});
