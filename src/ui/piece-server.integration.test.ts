/**
 * A managed piece's declared api_serve paths go to its long-lived server, with the call's grant in the request and
 * never in the server's env; any other path runs `api --json` as before (t-2065).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pieceApi } from './pieces.js';
import { stopPieceServers } from './piece-server.js';

describe('pieceApi with api_serve', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let bin: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-serve-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# art\n');
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art' }));
    const dir = join(home, 'pieces', 'runner');
    mkdirSync(join(dir, 'current'), { recursive: true });
    writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name: 'runner', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'runner', version: '1', installed: 'x',
      bins: ['loom-runner'], loom: { settings: [], services: [], api_serve: ['body-sync'] } }));
    const cli = join(dir, 'current', 'cli');
    writeFileSync(cli, `#!${process.execPath}
const answer = (req, grant) => ({ ...(req.path === 'write' || req.path === 'body-sync' ? { changed: true } : req.path === 'odd' ? { changed: 'yes' } : {}), body: { how: process.argv.includes('--serve') ? 'served' : 'once', pid: process.pid, path: req.path, grant: grant ?? null, envGrant: process.env.LOOM_STORE_GRANT ? 'set' : null } });
if (process.argv.includes('--serve')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
    const m = JSON.parse(l);
    process.stdout.write(JSON.stringify({ id: m.id, exit: 0, stdout: JSON.stringify(answer(m.request, m.grant ? 'set' : null)) + '\\n' }) + '\\n');
  });
} else {
  let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => console.log(JSON.stringify(answer(JSON.parse(s), process.env.LOOM_STORE_GRANT ? 'set' : null))));
}
`);
    chmodSync(cli, 0o755);
    mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
    bin = join(home, 'pieces', 'bin', 'loom-runner');
    symlinkSync(cli, bin);
    env = { ...process.env, LOOM_HOME: home };
    delete env.LOOM_STORE_GRANT;
  });
  afterAll(() => { stopPieceServers(); rmSync(home, { recursive: true, force: true }); });

  type B = { how: string; pid: number; path: string; grant: string | null; envGrant: string | null };
  const call = async (path: string) => (await pieceApi(bin, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path, body: {} }, env)) as { status: number; body: B };

  it('a declared path is served from one process, the grant in each request and none in its env', async () => {
    const a = await call('body-sync');
    const b = await call('body-sync');
    expect(a.status).toBe(200);
    expect(a.body.how).toBe('served');
    expect(b.body.pid).toBe(a.body.pid);
    expect([a.body.grant, a.body.envGrant]).toEqual(['set', null]);
  });

  it('says the call wrote only on the piece\'s own changed: true, served or run once, and never in the body', async () => {
    const out = (path: string) => pieceApi(bin, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path, body: {} }, env);
    for (const path of ['write', 'body-sync']) {
      const r = await out(path);
      expect(r.changed, path).toBe(true);
      expect(r.body).not.toHaveProperty('changed');
    }
    for (const path of ['odd', 'send']) expect(await out(path), path).not.toHaveProperty('changed');
  });

  it('any other path runs once, as before, with its grant in its env', async () => {
    const r = await call('send');
    expect(r.body.how).toBe('once');
    expect(r.body.envGrant).toBe('set');
  });
});

describe('api_serve in the loom block', () => {
  it('is a short list of path names, never one a caller with no token reaches', async () => {
    const { parseLoomBlock } = await import('../cli/pieces-managed.js');
    expect(parseLoomBlock({ api_serve: ['body-sync'] })).toMatchObject({ api_serve: ['body-sync'] });
    expect(typeof parseLoomBlock({ api_serve: 'body-sync' })).toBe('string');
    expect(typeof parseLoomBlock({ api_serve: ['a', 'a'] })).toBe('string');
    expect(parseLoomBlock({ strangers: ['join-request'], api_serve: ['join-request'] })).toMatch(/strangers/);
  });
});
