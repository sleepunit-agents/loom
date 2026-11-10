import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pieceServerCount, serveCall, stopPieceServers } from './piece-server.js';

// A piece bin that speaks `api --serve`: answers each line with its pid, the grant it was handed, and whether its own
// env holds one. MODE=slow never answers; MODE=junk answers out of turn.
function bin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'piece-server-'));
  const p = join(dir, 'loom-fake');
  writeFileSync(p, `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (process.env.MODE === 'slow') return;
  if (process.env.MODE === 'junk') { process.stdout.write('{"id":0,"exit":0,"stdout":"x"}\\n'); return; }
  const body = { pid: process.pid, grant: m.grant, envGrant: process.env.LOOM_STORE_GRANT ?? null, path: m.request.path };
  process.stdout.write(JSON.stringify({ id: m.id, exit: m.request.path === 'fail' ? 3 : 0, stdout: JSON.stringify({ body }) + '\\n' }) + '\\n');
});
`);
  chmodSync(p, 0o755);
  return p;
}
const opts = { timeoutMs: 2000, maxBytes: 1 << 20 };
const body = (r: Awaited<ReturnType<typeof serveCall>>) => {
  if (!r || !r.ok) throw Error(JSON.stringify(r));
  return JSON.parse(r.stdout).body as { pid: number; grant: string | null; envGrant: string | null };
};

afterEach(() => stopPieceServers());

describe('piece API servers (t-2065)', () => {
  it('answers request after request from one process, each with its own grant and none in its env', async () => {
    const p = bin();
    const a = body(await serveCall(p, 'v1', { PATH: process.env.PATH }, 'g-one', { path: 'body-sync' }, opts));
    const b = body(await serveCall(p, 'v1', { PATH: process.env.PATH }, undefined, { path: 'body-sync' }, opts));
    expect(b.pid).toBe(a.pid);
    expect([a.grant, b.grant]).toEqual(['g-one', null]);
    expect([a.envGrant, b.envGrant]).toEqual([null, null]);
    expect(pieceServerCount(p)).toBe(1);
  });

  it('a non-zero exit is the call\'s, as a one-shot\'s, and the server stays', async () => {
    const p = bin();
    const r = await serveCall(p, 'v1', { PATH: process.env.PATH }, undefined, { path: 'fail' }, opts);
    expect(r).toEqual({ ok: false, reason: 'no ui', code: 3 });
    expect(pieceServerCount(p)).toBe(1);
  });

  it('a new version of the bin, or another env, is a new server; the old one goes once idle', async () => {
    const p = bin();
    const a = body(await serveCall(p, 'v1', { PATH: process.env.PATH }, undefined, { path: 'x' }, opts));
    const b = body(await serveCall(p, 'v2', { PATH: process.env.PATH }, undefined, { path: 'x' }, opts));
    expect(b.pid).not.toBe(a.pid);
    expect(pieceServerCount(p)).toBe(1);
    const c = body(await serveCall(p, 'v2', { PATH: process.env.PATH, SETTING: 'changed' }, undefined, { path: 'x' }, opts));
    expect(c.pid).not.toBe(b.pid);
  });

  it('all busy: no server for this call, so it runs the one-shot way', async () => {
    const p = bin();
    const env = { PATH: process.env.PATH, MODE: 'slow' };
    const one = serveCall(p, 'v1', env, undefined, { path: 'x' }, { ...opts, timeoutMs: 300 });
    const two = serveCall(p, 'v1', env, undefined, { path: 'x' }, { ...opts, timeoutMs: 300 });
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(serveCall(p, 'v1', env, undefined, { path: 'x' }, opts)).toBeUndefined();
    // Timed out: each is killed and the call fails as a one-shot's would.
    expect(await one).toEqual({ ok: false, reason: 'timed out' });
    expect(await two).toEqual({ ok: false, reason: 'timed out' });
    expect(pieceServerCount(p)).toBe(0);
  });

  it('an answer out of turn ends the server and fails the call', async () => {
    const p = bin();
    const r = await serveCall(p, 'v1', { PATH: process.env.PATH, MODE: 'junk' }, undefined, { path: 'x' }, opts);
    expect(r).toEqual({ ok: false, reason: 'the piece\'s server answered out of turn' });
    expect(pieceServerCount(p)).toBe(0);
  });

  it('a bin that isn\'t there fails the call; nothing is left up', async () => {
    const r = await serveCall('/nonexistent/loom-none', 'v1', { PATH: process.env.PATH }, undefined, { path: 'x' }, opts);
    expect(r && r.ok).toBe(false);
    expect(pieceServerCount('/nonexistent/loom-none')).toBe(0);
  });
});
