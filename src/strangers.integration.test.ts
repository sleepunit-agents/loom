/**
 * A caller with no token (a box asking to join) reaches only a path a managed
 * piece declared open in its loom block (loom.strangers, fixed at install), as
 * {kind:'stranger', address}, with a small body. Everything else still needs
 * a token: another path, another piece, a piece that declared none.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { loadHousehold, type Household } from './household.js';

describe('strangers on the piece API', () => {
  let h: Household;
  let handle: HttpServeHandle;
  const saved = { LOOM_HOME: process.env.LOOM_HOME };

  const piece = (home: string, name: string, strangers?: string[]) => {
    const dir = join(home, 'pieces', name);
    mkdirSync(join(dir, 'current'), { recursive: true });
    writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
      bins: [`loom-${name}`], loom: { settings: [], services: [], ...(strangers ? { strangers } : {}) } }));
    const bin = join(dir, 'current', 'cli');
    writeFileSync(bin, `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => console.log(JSON.stringify({ body: JSON.parse(s) })));
`);
    chmodSync(bin, 0o755);
    mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
    symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
  };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-strangers-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# art\n');
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art' }));
    piece(home, 'door', ['join-request']);
    piece(home, 'closed');
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
  });
  afterAll(async () => {
    if (saved.LOOM_HOME === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved.LOOM_HOME;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('a declared path takes a stranger, as one, and nothing else does', async () => {
    const r = await post('/api/door/join-request', { name: 'one-loom' });
    expect(r.status).toBe(200);
    const got = await r.json() as { caller: { kind: string; address: string }; path: string };
    expect(got.caller.kind).toBe('stranger');
    expect(got.caller.address).toMatch(/127\.0\.0\.1/);
    expect(got.path).toBe('join-request');
    expect((await post('/api/door/other', {})).status).toBe(401);
    expect((await post('/api/closed/join-request', {})).status).toBe(401);
    expect((await post('/api/door/join-request', { pad: 'x'.repeat(9000) })).status).toBe(413);
    // A wrong token is refused as such, never taken for a stranger.
    expect((await post('/api/door/join-request', {}, { authorization: 'Bearer loom_nope' })).status).toBe(401);
  });
});
