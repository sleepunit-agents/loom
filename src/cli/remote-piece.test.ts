/**
 * Remote pieces (t-1737, docs/specs/agent-runtime.md "Seams this needs from
 * core" 1 and test 8): with LOOM_URL set and no local piece, `loom <piece> …`
 * posts {argv} to /api/<piece>/run as the token file's token and prints the
 * answer. Tested against a stub piece API, not a real loom-http.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { runCliCaptured } from './test-helpers.js';
import { pieceRunEndpoint } from './remote.js';

const TOKEN = 'house-token-xyz';

interface Seen { method?: string; url?: string; auth?: string; type?: string; body: unknown }

describe('loom <piece> against a remote loom', () => {
  let dir: string;
  let tokenFile: string;
  let server: Server;
  let url: string;
  let seen: Seen[];
  /** What the stub answers next: a status and a body (an object is sent as JSON). */
  let reply: { status: number; body: unknown };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-remote-piece-'));
    tokenFile = join(dir, 'token');
    await writeFile(tokenFile, `${TOKEN}\n`);
    seen = [];
    reply = { status: 200, body: { exit: 0, stdout: '', stderr: '' } };
    server = createServer(async (req: IncomingMessage, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* keep raw */ }
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  /** A house's env: no piece on PATH (only the system dirs), LOOM_URL and the token file. */
  const houseEnv = (extra: Record<string, string> = {}) => ({
    PATH: ['/usr/bin', '/bin'].join(delimiter),
    LOOM_HOME: join(dir, 'home'),
    LOOM_URL: url,
    LOOM_TOKEN_FILE: tokenFile,
    ...extra,
  });

  it('posts {argv} to /api/<piece>/run with the token file\'s token (spec test 8)', async () => {
    reply = { status: 200, body: { exit: 0, stdout: '[]\n', stderr: '' } };
    const r = await runCliCaptured(['zzremote', 'list', '--status', 'open'], { env: houseEnv() });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      method: 'POST',
      url: '/api/zzremote/run',
      auth: `Bearer ${TOKEN}`,
      type: 'application/json',
      body: { argv: ['list', '--status', 'open'] },
    });
    expect(r.stdout).toBe('[]\n');
    expect(r.code).toBe(0);
  });

  it('passes the answer\'s stdout, stderr and exit code through', async () => {
    reply = { status: 200, body: { exit: 3, stdout: 'some out\n', stderr: 'some err\n' } };
    const r = await runCliCaptured(['zzremote', 'show', 't-1'], { env: houseEnv() });
    expect(r.stdout).toBe('some out\n');
    expect(r.stderr).toBe('some err\n');
    expect(r.code).toBe(3);
  });

  it('reads a big stdout sent as stdoutGz (gzip, base64), the way the tasks piece answers', async () => {
    const big = 'x'.repeat(300 * 1024) + '\n';
    reply = { status: 200, body: { exit: 0, stdoutGz: gzipSync(big).toString('base64'), stderr: '' } };
    const r = await runCliCaptured(['zzremote', 'list'], { env: houseEnv() });
    expect(r.stdout).toBe(big);
    expect(r.code).toBe(0);
  });

  it('a local piece wins: on PATH, the remote loom is never asked', async () => {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'loom-zzremote'), '#!/bin/sh\necho "local: $*"\n');
    await chmod(join(bin, 'loom-zzremote'), 0o755);
    const r = await runCliCaptured(['zzremote', 'list'], { env: houseEnv({ PATH: [bin, '/usr/bin', '/bin'].join(delimiter) }) });
    expect(r.stdout).toBe('local: list\n');
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('a managed piece wins too: the remote loom is never asked', async () => {
    const bin = join(dir, 'home', 'pieces', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'loom-zzremote'), '#!/bin/sh\necho "managed: $*"\n');
    await chmod(join(bin, 'loom-zzremote'), 0o755);
    const r = await runCliCaptured(['zzremote', 'list'], { env: houseEnv() });
    expect(r.stdout).toBe('managed: list\n');
    expect(seen).toHaveLength(0);
  });

  it('an unreachable loom exits 1 and says where it tried', async () => {
    // A port nothing listens on: take one, then let it go.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const dead = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const r = await runCliCaptured(['zzremote', 'list'], { env: houseEnv({ LOOM_URL: `http://127.0.0.1:${dead}/mcp` }) });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^loom: can't reach http:\/\/127\.0\.0\.1:\d+\/api\/zzremote\/run for the zzremote piece: /);
  });

  it('a non-200 exits 1 with loom\'s own words', async () => {
    reply = { status: 403, body: { error: 'forbidden: only the owner and this store\'s agents' } };
    const r = await runCliCaptured(['zzremote', 'list'], { env: houseEnv() });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('answered 403: forbidden: only the owner');
  });

  it('a 404 or 502 says the piece may not answer run there', async () => {
    reply = { status: 502, body: { error: 'bad-gateway: the piece answered nothing' } };
    const r = await runCliCaptured(['zzremote', 'list'], { env: houseEnv() });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/answered 502: .*zzremote isn't installed here, and the loom at .* doesn't run it/);
  });

  it('an answer without an integer exit is never read as success', async () => {
    reply = { status: 200, body: { stdout: 'looks fine\n', stderr: '' } };
    const r = await runCliCaptured(['zzremote', 'list'], { env: houseEnv() });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/malformed run answer/);
  });

  it('without LOOM_URL an unknown piece is still unknown, and nothing is posted', async () => {
    const { LOOM_URL: _, ...env } = houseEnv();
    const r = await runCliCaptured(['zzremote', 'list'], { env });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Unknown subcommand: zzremote/);
    expect(seen).toHaveLength(0);
  });

  it('global flags in front of a remote piece are refused, as for a local one', async () => {
    const r = await runCliCaptured(['--json', 'zzremote', 'list'], { env: houseEnv() });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/don't apply to pieces/);
    expect(seen).toHaveLength(0);
  });

  it('pieceRunEndpoint sits beside /mcp and keeps a proxy prefix', () => {
    expect(pieceRunEndpoint('http://h:8787/mcp', 'tasks').href).toBe('http://h:8787/api/tasks/run');
    expect(pieceRunEndpoint('https://h/loom/mcp/', 'tasks').href).toBe('https://h/loom/api/tasks/run');
    expect(pieceRunEndpoint('http://h:8787', 'clock').href).toBe('http://h:8787/api/clock/run');
  });
});
