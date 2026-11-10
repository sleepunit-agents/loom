import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPieceCache, expirePieceManifests, pieceManifests, SERVED_CACHE_MS } from './pieces.js';
import { clearPieceCache as actedOn } from './pieces.js';
import { closePieceSockets, manifestSocket, socketManifest } from './piece-socket.js';

// t-2114: a managed piece's manifest from its own service over <home>/run/ui.sock, instead of a `ui --json` process.
describe('a piece\'s manifest from its service socket', () => {
  const dirs: string[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    closePieceSockets();
    clearPieceCache();
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A managed piece `gizmo` whose `ui --json` logs its run and answers `exec`. */
  function managed() {
    const root = mkdtempSync(join(tmpdir(), 'loom-sock-'));
    dirs.push(root);
    const home = join(root, 'home');
    const bin = join(home, 'pieces', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, 'pieces', 'gizmo'), { recursive: true });
    writeFileSync(join(home, 'pieces', 'gizmo', 'piece.json'), JSON.stringify({ v: 1, name: 'gizmo', source: { kind: 'local', path: root }, package: 'gizmo', version: '1', installed: '', bins: ['loom-gizmo'], loom: { settings: [] } }));
    const path = join(bin, 'loom-gizmo');
    writeFileSync(path, `#!/bin/sh\necho ran >> ${join(root, 'ran')}\necho '{"v":2,"asks":[],"tile":{"label":"Gizmo","value":"exec"}}'\n`);
    chmodSync(path, 0o755);
    const env = { PATH: `/usr/bin:/bin`, LOOM_HOME: home };
    const ran = () => (existsSync(join(root, 'ran')) ? readFileSync(join(root, 'ran'), 'utf8').trim().split('\n').length : 0);
    return { root, home, path, env, ran, sock: join(home, 'pieces', 'gizmo', 'run', 'ui.sock') };
  }

  /** A service at `at` answering each request with `answer(id)` (a line), counting requests. */
  async function serve(at: string, answer: (id: number) => string, opts: { dirMode?: number; sockMode?: number } = {}) {
    mkdirSync(join(at, '..'), { recursive: true, mode: 0o700 });
    chmodSync(join(at, '..'), opts.dirMode ?? 0o700);
    const seen: unknown[] = [];
    const server = createServer((c) => {
      let buf = '';
      c.setEncoding('utf-8');
      c.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const m = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          seen.push(m);
          c.write(answer(m.id));
        }
      });
    });
    await new Promise<void>((r) => server.listen(at, r));
    chmodSync(at, opts.sockMode ?? 0o600);
    servers.push(server);
    return seen;
  }

  const ver = (path: string) => { const r = realpathSync(path); return `${r}@${statSync(r).mtimeMs}`; };
  const ok = (version: string, value = 'served', extra: Record<string, unknown> = {}) => (id: number) =>
    JSON.stringify({ id, ok: true, version, at: Date.now(), stdout: JSON.stringify({ v: 2, asks: [], tile: { label: 'Gizmo', value }, ...extra }) + '\n' }) + '\n';

  it('answers from the socket with no process, and only a manifest request goes over it', async () => {
    const p = managed();
    expect(manifestSocket(p.path, p.env)).toBe(p.sock);
    const seen = await serve(p.sock, ok(ver(p.path)));
    const r = await pieceManifests(p.env);
    expect(r.pieces.find((x) => x.piece === 'gizmo')?.manifest.tile?.value).toBe('served');
    expect(p.ran()).toBe(0);
    // Nothing about the viewer: an id and the op, nothing else.
    expect(seen).toEqual([{ id: expect.any(Number), op: 'manifest', version: ver(p.path), since: expect.any(Number) }]);
  });

  it('a served piece is asked again after SERVED_CACHE_MS, on the same connection', async () => {
    const p = managed();
    const seen = await serve(p.sock, ok(ver(p.path)));
    const t = Date.now();
    await pieceManifests(p.env, t);
    await pieceManifests(p.env, t + 1);
    expect(seen.length).toBe(1);
    await pieceManifests(p.env, t + SERVED_CACHE_MS + 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBe(2);
    expect(p.ran()).toBe(0);
  });

  it('runs `ui --json` when the service runs another version', async () => {
    const p = managed();
    await serve(p.sock, ok('/somewhere/else/cli.mjs'));
    const r = await pieceManifests(p.env);
    expect(r.pieces.find((x) => x.piece === 'gizmo')?.manifest.tile?.value).toBe('exec');
    expect(p.ran()).toBe(1);
  });

  it('never asks a socket others may reach: group bits on it or its directory', async () => {
    const p = managed();
    const seen = await serve(p.sock, ok(ver(p.path)), { sockMode: 0o660 });
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024 })).toBeUndefined();
    chmodSync(p.sock, 0o600);
    chmodSync(join(p.sock, '..'), 0o750);
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024 })).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('no socket, or an unmanaged piece: the one-shot way', async () => {
    const p = managed();
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024 })).toBeUndefined();
    expect(manifestSocket('/usr/bin/loom-gizmo', p.env)).toBeUndefined();
    const r = await pieceManifests(p.env);
    expect(r.pieces.find((x) => x.piece === 'gizmo')?.manifest.tile?.value).toBe('exec');
  });

  it('an answer out of turn, too large or too slow drops the connection and falls back, then leaves it alone a while', async () => {
    const p = managed();
    const seen = await serve(p.sock, (id) => JSON.stringify({ id: id + 1, ok: true, version: ver(p.path), stdout: '{}' }) + '\n');
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024 })).toBeUndefined();
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024 })).toBeUndefined();
    expect(seen.length).toBe(1);   // the second didn't ask: failed lately
    closePieceSockets();
    const big = await (async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); return serve(p.sock, ok(ver(p.path), 'x'.repeat(5000))); })();
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024 })).toBeUndefined();
    expect(big.length).toBe(1);
    closePieceSockets();
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    await serve(p.sock, () => '');
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024, waitMs: 50 })).toBeUndefined();
  });

  it('requests wait their turn on one connection', async () => {
    const p = managed();
    const seen = await serve(p.sock, ok(ver(p.path)));
    const rs = await Promise.all([1, 2, 3].map(() => socketManifest(p.path, p.env, { maxBytes: 1024 })));
    expect(rs.every((r) => r?.ok)).toBe(true);
    expect(seen.length).toBe(3);
  });

  it('a service that can\'t make its manifest falls back to ui --json and is left alone a while (W1)', async () => {
    const p = managed();
    const seen = await serve(p.sock, (id) => JSON.stringify({ id, ok: false, version: ver(p.path) }) + '\n');
    const r = await pieceManifests(p.env);
    expect(r.pieces.find((x) => x.piece === 'gizmo')?.manifest.tile?.value).toBe('exec');
    expect(p.ran()).toBe(1);
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024 })).toBeUndefined();
    expect(seen.length).toBe(1);
  });

  it('never takes a manifest that reads the viewer\'s scope from a socket (W3)', async () => {
    const p = managed();
    await serve(p.sock, ok(ver(p.path), 'served', { scope: true }));
    const r = await pieceManifests({ ...p.env, LOOM_SCOPE: 'mark' });
    expect(r.pieces.find((x) => x.piece === 'gizmo')?.manifest.tile?.value).toBe('exec');
    expect(p.ran()).toBe(1);
  });

  it('asks for an answer made since the piece last moved, and refuses an older one (W2)', async () => {
    const p = managed();
    const seen = await serve(p.sock, (id) => JSON.stringify({ id, ok: true, version: ver(p.path), at: 1, stdout: '{"v":2,"asks":[]}' }) + '\n') as Array<{ since: number }>;
    expirePieceManifests();
    const before = Date.now();
    expect(await socketManifest(p.path, p.env, { maxBytes: 1024, since: before })).toBeUndefined();
    expect(seen[0].since).toBe(before);
  });

  it('one waiting behind a slow answer gives up from when it asked (N4)', async () => {
    const p = managed();
    await serve(p.sock, () => '');
    const t = Date.now();
    const rs = await Promise.all([1, 2].map(() => socketManifest(p.path, p.env, { maxBytes: 1024, waitMs: 80 })));
    expect(rs).toEqual([undefined, undefined]);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('since: a piece\'s own word asks no newer answer than it has; an action on it does, and on another piece doesn\'t (R2-3)', async () => {
    const p = managed();
    const seen = await serve(p.sock, ok(ver(p.path))) as Array<{ since: number }>;
    const wait = () => new Promise((r) => setTimeout(r, 5));
    await wait();
    const t0 = Date.now();
    await wait();
    actedOn('/elsewhere/loom-other');
    expirePieceManifests(p.path);
    await pieceManifests(p.env);
    expect(seen.at(-1)!.since).toBeLessThan(t0);
    await wait();
    const t = Date.now();
    actedOn(p.path);
    await pieceManifests(p.env);
    expect(seen.at(-1)!.since).toBeGreaterThanOrEqual(t);
  });
});
