/**
 * Remote mode end to end (t-1472): the CLI against a real loom-http on an
 * ephemeral port, compared with the same CLI run locally on the server's
 * stack. Parity is the point: same stdout, same --json, same exit codes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { cliEndpoint } from './remote.js';
import { runCliLocal } from './index.js';
import { Readable } from 'node:stream';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

const TOKEN = 'remote-cli-secret';

describe('loom CLI remote mode', () => {
  let stack: string;      // the server's stack
  let elsewhere: string;  // what the client's own (empty) context dir would be
  let tokenFile: string;
  let handle: HttpServeHandle;
  let url: string;

  beforeEach(async () => {
    stack = await mkdtemp(join(tmpdir(), 'loom-remote-stack-'));
    elsewhere = await mkdtemp(join(tmpdir(), 'loom-remote-client-'));
    await writeFile(join(stack, 'IDENTITY.md'), '# Creed');
    await remember(stack, { category: 'reference', title: 'blue widget', content: 'Specs for the blue widget prototype' });
    tokenFile = join(elsewhere, 'token');
    await writeFile(tokenFile, `${TOKEN}\n`);
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    url = `http://127.0.0.1:${handle.port}/mcp`;
  });
  afterEach(async () => {
    await handle.close();
    await rm(stack, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  /** The client's env: LOOM_URL + token, and a context dir that ISN'T the server's. */
  const remoteEnv = () => ({ LOOM_URL: url, LOOM_TOKEN_FILE: tokenFile, LOOM_CONTEXT_DIR: elsewhere });
  const local = (argv: string[], stdin?: string) => runCliCaptured(argv, { contextDir: stack, stdin });
  const remote = (argv: string[], stdin?: string) => runCliCaptured(argv, { env: remoteEnv(), stdin });

  it('recall matches the local CLI, human and --json', async () => {
    const human = [await local(['recall', 'blue widget']), await remote(['recall', 'blue widget'])];
    expect(human[1].code).toBe(0);
    expect(human[1].stdout).toBe(human[0].stdout);
    expect(human[1].stdout).toMatch(/blue widget/);

    // A recall stamps lastAccessed, so two calls in a row differ there and only there.
    const json = async (r: Promise<{ stdout: string; code: number }>) => {
      const { stdout, code } = await r;
      expect(code).toBe(0);
      return (JSON.parse(stdout) as Array<Record<string, unknown>>).map(({ lastAccessed: _, ...m }) => m);
    };
    const l = await json(local(['recall', 'blue widget', '--json']));
    expect(await json(remote(['recall', 'blue widget', '--json']))).toEqual(l);
    expect(l[0]).toHaveProperty('title', 'blue widget');
  });

  it('carries non-zero exit codes: person show of a missing card is 3 both ways', async () => {
    const [l, r] = [await local(['person', 'show', 'nobody']), await remote(['person', 'show', 'nobody'])];
    expect(l.code).toBe(3);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(l.stderr);
  });

  it('remember --json writes the piped body to the SERVER stack and returns the ref', async () => {
    const r = await remote(['remember', 'tank note', '--category', 'project', '--json'], 'written from a tank');
    expect(r.code).toBe(0);
    const ref = JSON.parse(r.stdout) as { ref: string; title: string };
    expect(ref.title).toBe('tank note');
    const found = await local(['recall', 'written from a tank', '--json']);
    expect(JSON.parse(found.stdout)[0]).toHaveProperty('title', 'tank note');
    // ...and nothing landed in the client's own context dir.
    const mine = await runCliCaptured(['recall', 'written from a tank', '--json'], { contextDir: elsewhere });
    expect(JSON.parse(mine.stdout)).toEqual([]);
  });

  it('an empty body is refused the same way it is locally', async () => {
    const r = await remote(['remember', 'empty', '--category', 'project'], '');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/body cannot be empty/);
  });

  it('--url works without LOOM_URL, in front of the verb too', async () => {
    const r = await runCliCaptured(['--url', url, 'recall', 'blue widget'], { env: { LOOM_TOKEN_FILE: tokenFile, LOOM_CONTEXT_DIR: elsewhere } });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/blue widget/);
  });

  it('a wrong token or no token is a 401, exit 1', async () => {
    await writeFile(tokenFile, 'wrong');
    const wrong = await remote(['recall', 'x']);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/401/);
    const none = await runCliCaptured(['recall', 'x'], { env: { LOOM_URL: url } });
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/401/);
  });

  it('refuses --context-dir with a remote URL before sending anything', async () => {
    const r = await remote(['recall', 'x', '--context-dir', stack]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/local stack/);
  });

  it('local-only verbs ignore LOOM_URL, and refuse an explicit --url', async () => {
    const r = await runCliCaptured(['doctor', '--url', url], { env: remoteEnv() });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/runs locally/);
  });

  it('update --confirm reads no body: no stdin, no $EDITOR, even on a TTY', async () => {
    const r0 = await remote(['remember', 'pref', '--category', 'feedback', '--json'], 'likes short replies');
    const { ref } = JSON.parse(r0.stdout) as { ref: string };
    // No stdin given = a TTY in the test helper. A wrongly-read body would run VISUAL and fail.
    const r = await runCliCaptured(['update', ref, '--confirm'], { env: { ...remoteEnv(), VISUAL: 'false' } });
    expect(r.stderr).not.toMatch(/editor/);
    expect(r.code).toBe(0);
  });

  it('--url with no value is an error, not a silent local run', async () => {
    const r = await runCliCaptured(['recall', 'x', '--url'], { contextDir: stack });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--url needs a value/);
  });

  it('an unreachable server is exit 1 with the endpoint named', async () => {
    const port = handle.port;
    await handle.close();
    const r = await remote(['recall', 'x']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`127.0.0.1:${port}/cli`);
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
  });
});

describe('runCliLocal (what POST /cli runs)', () => {
  it('never goes remote: LOOM_URL is ignored and the local stack answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-cli-local-'));
    try {
      await writeFile(join(dir, 'IDENTITY.md'), '# Creed');
      await remember(dir, { category: 'reference', title: 'local only', content: 'answered locally' });
      let stdout = '';
      const code = await runCliLocal(['recall', 'answered locally'], {
        stdout: (t) => { stdout += t; },
        stderr: () => {},
        stdin: Readable.from(['']),
        stdinIsTTY: false,
        // A dead port: any attempt to go remote would fail the call.
        env: { LOOM_CONTEXT_DIR: dir, LOOM_URL: 'http://127.0.0.1:9/mcp' },
      });
      expect(code).toBe(0);
      expect(stdout).toMatch(/local only/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cliEndpoint', () => {
  it.each([
    ['http://h:8787/mcp', 'http://h:8787/cli'],
    ['http://h:8787/mcp/', 'http://h:8787/cli'],
    ['http://h:8787', 'http://h:8787/cli'],
    ['http://h:8787/', 'http://h:8787/cli'],
    ['https://h/loom/mcp', 'https://h/loom/cli'],
    ['https://h/loom/', 'https://h/loom/cli'],
  ])('%s → %s', (url, expected) => {
    expect(cliEndpoint(url).href).toBe(expected);
  });
});

describe('the client never takes a malformed answer for success', () => {
  it.each([
    ['{}'],
    ['{"exitCode":null,"stdout":"","stderr":""}'],
    ['{"exitCode":0,"stdout":1,"stderr":""}'],
    ['not json'],
  ])('%s → exit 1', async (answer) => {
    const fake = createServer((_req, res) => { res.writeHead(200); res.end(answer); });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const port = (fake.address() as { port: number }).port;
    try {
      const r = await runCliCaptured(['recall', 'x'], { env: { LOOM_URL: `http://127.0.0.1:${port}/mcp` } });
      expect(r.code).toBe(1);
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });
});

describe('POST /cli refusals (the server half)', () => {
  let stack: string;
  let handle: HttpServeHandle;

  beforeEach(async () => {
    stack = await mkdtemp(join(tmpdir(), 'loom-cli-endpoint-'));
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
  });
  afterEach(async () => {
    await handle.close();
    await rm(stack, { recursive: true, force: true });
  });

  const post = (body: unknown, token = TOKEN) =>
    fetch(`http://127.0.0.1:${handle.port}/cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it.each([
    [{ argv: ['doctor'] }, /doesn't run remotely/],
    [{ argv: ['inject', '--all'] }, /doesn't run remotely/],
    [{ argv: ['--json', 'memory', 'recall-stats'] }, /no MCP tool/],
    [{ argv: ['memory', '--json', 'recall-stats'] }, /no MCP tool/],
    [{ argv: ['recall', 'x', '--context-dir', '/etc'] }, /only serves its own/],
    [{ argv: ['recall', 'x', '--context-dir=/etc'] }, /only serves its own/],
    [{ argv: ['recall', 'x'], env: { HOME: '/tmp' } }, /only carry LOOM_CLIENT and LOOM_MODEL/],
    [{ argv: [] }, /argv must be/],
    [{ argv: 'recall x' }, /argv must be/],
  ])('refuses %j with a 400', async (body, error) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(error);
  });

  it('runs memory recompute-salience (a consolidation lane in a house, t-1544): it has an MCP tool now', async () => {
    const res = await post({ argv: ['memory', 'recompute-salience'] });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/recomputed salience for \d+ memories/);
  });

  it('sits behind the bearer gate', async () => {
    const res = await post({ argv: ['recall', 'x'] }, 'wrong');
    expect(res.status).toBe(401);
  });

  it('refuses what a browser could send cross-site: a simple text/plain POST, or any Origin', async () => {
    const url = `http://127.0.0.1:${handle.port}/cli`;
    const body = JSON.stringify({ argv: ['recall', 'x'] });
    const plain = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${TOKEN}` }, body });
    expect(plain.status).toBe(415);
    const withOrigin = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` },
      body,
    });
    expect(withOrigin.status).toBe(403);
  });

  it('a daemon with no bearer token has no /cli, though its /mcp still serves', async () => {
    const open = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${open.port}/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ argv: ['recall', 'x'] }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/LOOM_BEARER_TOKEN/);
    } finally {
      await open.close();
    }
  });

  it('a scoped (knowledge-only) server has no /cli', async () => {
    const scoped = await startHttpServer({
      contextDir: stack,
      host: '127.0.0.1',
      port: 0,
      tokens: { art: TOKEN },
      createServer: () => { throw new Error('not reached'); },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${scoped.port}/cli`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ argv: ['recall', 'x'] }),
      });
      expect(res.status).toBe(404);
    } finally {
      await scoped.close();
    }
  });
});
