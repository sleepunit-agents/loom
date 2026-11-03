/**
 * An old piece name (PIECE_ALIASES, src/cli/pieces-managed.ts; resolvePieceName, src/cli/pieces.ts):
 * the installed `box` piece is swapped for the renamed package, whose loom.name is `runtime` (its
 * bins are loom-runtime and, for old callers, loom-box). Callers that still say `box` reach the
 * runtime, while no piece named box is installed:
 *  1. /api/box/… routing, /api/box/run included;
 *  2. /p/box/… and /a/<agent>/p/box/… pages, a 308 to the runtime's;
 *  3. a piece:box/<subject> credential acts as piece:runtime/<subject>;
 *  4. a house's remote `loom box …` (LOOM_URL);
 *  5. the first-run STARTERS;
 *  6. the page lists the runtime once (its loom-box bin isn't a second Boxes).
 * An installed box (or a loom-box on PATH that isn't the runtime's own bin) wins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { resolvePieceName } from './cli/pieces.js';
import { runCliCaptured } from './cli/test-helpers.js';
import { STARTERS } from './ui/handler.js';
import { CACHE_MS, pieceManifests } from './ui/pieces.js';

const OWNER = 'owner-token-for-the-page-0123456789';

/** The runtime's stub: one script behind both its bins, answering the API with who it is and what it got. */
const RUNTIME_CLI = `#!${process.execPath}
const name = require('node:path').basename(process.argv[1]);
const a = process.argv.slice(2);
if (a[0] === 'ui' && a[1] === '--json') { console.log(JSON.stringify({ v: 2, tab: { label: 'Runtime' }, pages: true })); process.exit(0); }
if (a[0] !== 'api') process.exit(3);
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const r = JSON.parse(s);
  const said = { bin: name, piece: process.env.LOOM_PIECE_NAME, caller: r.caller, path: r.path, body: r.body };
  if (r.path === 'run') return console.log(JSON.stringify({ body: { exit: 0, stdout: JSON.stringify(said) + '\\n', stderr: '' } }));
  console.log(JSON.stringify({ body: said }));
});
`;

function managed(home: string, name: string, bins: string[], loom: Record<string, unknown>, body: string): void {
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'sleepunit-agents/loom-box', commit: 'a'.repeat(40) }, package: `loom-${name}`, version: '1', installed: 'x',
    bins, loom: { settings: [], services: [], ...loom } }));
  const cli = join(dir, 'current', 'cli');
  writeFileSync(cli, body);
  chmodSync(cli, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  for (const b of bins) {
    rmSync(join(home, 'pieces', 'bin', b), { force: true });
    symlinkSync(cli, join(home, 'pieces', 'bin', b));
  }
}

describe('box is the runtime now (PIECE_ALIASES)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = { home: process.env.LOOM_HOME, path: process.env.PATH };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-alias-'));
    for (const a of ['art']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    h = loadHousehold(home)!;
    process.env.LOOM_HOME = home;
    process.env.PATH = ['/usr/bin', '/bin'].join(delimiter);
    managed(home, 'runtime', ['loom-runtime', 'loom-box'], { name: 'runtime', role: 'runtime' }, RUNTIME_CLI);
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art', house: 'h-1' }, label: 'art · house h-1' }).token;
    // A joined box's credential, minted while the piece was called box.
    tok.thor = createToken(h, { role: { kind: 'piece', piece: 'box', subject: 'thor' }, label: 'box · thor' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h, token: OWNER });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    await handle?.close();
    process.env.LOOM_HOME = saved.home;
    process.env.PATH = saved.path;
    rmSync(h.home, { recursive: true, force: true });
  });

  const api = async (path: string, token: string, body: unknown = {}) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  it('resolvePieceName: box is runtime while runtime is installed and box isn\'t; other names are themselves', () => {
    expect(resolvePieceName(process.env, 'box')).toBe('runtime');
    expect(resolvePieceName(process.env, 'runtime')).toBe('runtime');
    expect(resolvePieceName(process.env, 'tasks')).toBe('tasks');
  });

  it('1. /api/box/… and /api/box/run reach the runtime, run as its own bin', async () => {
    const r = await api('/api/box/houses', tok.art, { x: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bin: 'loom-runtime', piece: 'runtime', caller: { kind: 'agent', agent: 'art' }, path: 'houses', body: { x: 1 } });
    const run = await api('/api/box/run', tok.art, { argv: ['list'] });
    expect(run.status).toBe(200);
    expect(JSON.parse(String(run.body.stdout))).toMatchObject({ bin: 'loom-runtime', path: 'run', body: { argv: ['list'] } });
  });

  it('3. a piece:box/<subject> credential is piece:runtime/<subject>: the runtime\'s API under either name, and its store', async () => {
    for (const p of ['/api/box/join-poll', '/api/runtime/join-poll']) {
      const r = await api(p, tok.thor);
      expect(r.status, p).toBe(200);
      expect(r.body).toMatchObject({ bin: 'loom-runtime', caller: { kind: 'piece', subject: 'thor' }, path: 'join-poll' });
    }
    // The store checks see runtime: its own store, under either name; another piece's, no.
    expect((await api('/api/loom/store/runtime/list', tok.thor, { collection: 'boxes' })).status).toBe(200);
    expect((await api('/api/loom/store/box/list', tok.thor, { collection: 'boxes' })).status).toBe(200);
    expect((await api('/api/loom/store/tasks/list', tok.thor, { collection: 'boxes' })).status).toBe(403);
    // It reaches no other piece.
    expect((await api('/api/tasks/x', tok.thor)).status).toBe(403);
  });

  it('2. /p/box/… and /a/<agent>/p/box/… are a 308 to the runtime\'s page, path and query kept', async () => {
    for (const [from, to] of [['/p/box', '/p/runtime'], ['/p/box/houses?state=up', '/p/runtime/houses?state=up'], ['/a/art/p/box/boxes/thor', '/a/art/p/runtime/boxes/thor']]) {
      const r = await fetch(`${base}${from}`, { redirect: 'manual' });
      expect(r.status, from).toBe(308);
      expect(r.headers.get('location'), from).toBe(to);
    }
    // Anything else is left alone.
    expect((await fetch(`${base}/p/runtime`, { redirect: 'manual' })).status).not.toBe(308);
    expect((await fetch(`${base}/p/boxes`, { redirect: 'manual' })).status).not.toBe(308);
  });

  it('4. a house\'s `loom box …` (LOOM_URL, no local piece) runs on the runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-alias-house-'));
    try {
      writeFileSync(join(dir, 'token'), `${tok.art}\n`);
      const env = { PATH: ['/usr/bin', '/bin'].join(delimiter), LOOM_HOME: join(dir, 'home'), LOOM_URL: `${base}/mcp`, LOOM_TOKEN_FILE: join(dir, 'token') };
      const r = await runCliCaptured(['box', 'list', '--json'], { env });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ bin: 'loom-runtime', piece: 'runtime', path: 'run', body: { argv: ['list', '--json'] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6. the page shows the runtime once: its loom-box bin is the runtime, not a second piece', async () => {
    const { pieces } = await pieceManifests(process.env, Date.now() + 10 * CACHE_MS);
    expect(pieces.map((p) => p.piece)).toContain('runtime');
    expect(pieces.map((p) => p.piece)).not.toContain('box');
  });

  it('5. the first-run starters name runtime, not box', () => {
    expect(STARTERS).toContain('runtime');
    expect(STARTERS).not.toContain('box');
  });

  it('an installed box wins: the alias stands aside, and box is box', async () => {
    managed(h.home, 'box', ['loom-box'], {}, `#!/bin/sh\necho '{"body":{"bin":"the old box"}}'\n`);
    try {
      expect(resolvePieceName(process.env, 'box')).toBe('box');
      expect((await api('/api/box/houses', tok.art)).body).toEqual({ bin: 'the old box' });
      expect((await fetch(`${base}/p/box`, { redirect: 'manual' })).status).not.toBe(308);
      // A box of its own is a piece of its own on the page too: asked for its manifest (this stub has none to give).
      const m = await pieceManifests(process.env, Date.now() + 20 * CACHE_MS);
      expect([...m.pieces, ...m.skipped].map((p) => p.piece)).toContain('box');
    } finally {
      rmSync(join(h.home, 'pieces', 'box'), { recursive: true, force: true });
      // Give the runtime its loom-box bin back.
      managed(h.home, 'runtime', ['loom-runtime', 'loom-box'], { name: 'runtime', role: 'runtime' }, RUNTIME_CLI);
    }
  });

  it('so does a loom-box on PATH that isn\'t the runtime\'s; with no runtime installed, box stays box', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-alias-path-'));
    try {
      // A runtime that doesn't ship loom-box, and a hand-made loom-box on PATH: that one is `loom box`.
      const home = join(dir, 'home');
      managed(home, 'runtime', ['loom-runtime'], { name: 'runtime', role: 'runtime' }, RUNTIME_CLI);
      mkdirSync(join(dir, 'path'));
      writeFileSync(join(dir, 'path', 'loom-box'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, 'path', 'loom-box'), 0o755);
      expect(resolvePieceName({ LOOM_HOME: home, PATH: [join(dir, 'path'), '/usr/bin'].join(delimiter) }, 'box')).toBe('box');
      // Without it, box is the runtime; without the runtime, box is box.
      expect(resolvePieceName({ LOOM_HOME: home, PATH: '/usr/bin' }, 'box')).toBe('runtime');
      expect(resolvePieceName({ LOOM_HOME: join(dir, 'nothing'), PATH: '/usr/bin' }, 'box')).toBe('box');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
