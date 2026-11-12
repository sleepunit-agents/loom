import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { runCliCaptured } from './test-helpers.js';
import { domainOf, nudgedSince, withLog, liveDbPath, TICK } from '../collections/log.js';

it('marks a known local domain through core, with the same answer for an unknown domain', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-cli-nudge-'));
  withLog(home, db => domainOf(db, 'tasks/task', 'fixture'));
  const known = await runCliCaptured(['collections', 'nudge', 'tasks/task'], { env: { LOOM_HOME: home } });
  expect(known).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(Number(readFileSync(join(home, 'collections', TICK), 'utf8'))).toBeGreaterThan(0);
  expect(withLog(home, db => nudgedSince(db, 0))).toEqual([{ domain: 'tasks/task', nudged: expect.any(Number) }]);
  expect(await runCliCaptured(['collections', 'nudge', 'missing/type'], { env: { LOOM_HOME: home } })).toEqual(known);
});

it('help and invalid arguments do not create a store', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-cli-nudge-'));
  for (const args of [['--help'], ['nudge'], ['nudge', '../bad'], ['nudge', 'tasks/task', 'extra'], ['nudge', 'tasks/task', '--typo'], ...['--client', '--model', '--context-dir', '--url'].map(f => ['nudge', 'tasks/task', f])]) {
    const r = await runCliCaptured(['collections', ...args], { env: { LOOM_HOME: home } });
    expect(r.code).toBe(args[0] === '--help' ? 0 : 2);
    expect(existsSync(liveDbPath(home))).toBe(false);
  }
});

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
it('remote houses use only the existing nudge API and token file, preserving proxy prefixes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-cli-nudge-'));
  const token = join(home, 'token'); writeFileSync(token, 'test-token\n');
  const seen: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push([req.method, req.url, req.headers.authorization, JSON.parse(Buffer.concat(chunks).toString())]);
    res.writeHead(202); res.end('{"ok":true}');
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/prefix/mcp`;
  const env = { LOOM_URL: url, LOOM_HOME: home, LOOM_TOKEN_FILE: token };
  expect((await runCliCaptured(['collections', 'nudge', 'tasks/task'], { env })).code).toBe(0);
  expect(seen).toEqual([['POST', '/prefix/api/loom/collections/nudge', 'Bearer test-token', { domain: 'tasks/task' }]]);
  expect(existsSync(liveDbPath(home))).toBe(false);
  expect((await runCliCaptured(['--url', url, 'collections', 'nudge', 'tasks/*'], { env: { ...env, LOOM_URL: 'bad' } })).code).toBe(0);
  expect((await runCliCaptured(['collections', 'nudge', 'tasks/task', '--context-dir', home], { env })).code).toBe(2);
  expect((await runCliCaptured(['collections', 'nudge', 'tasks/task', '--client'], { env })).code).toBe(2);
  expect((await runCliCaptured(['collections', 'nudge', 'tasks/task'], { env: { ...env, LOOM_TOKEN_FILE: join(home, 'missing') } })).code).toBe(1);
  expect(existsSync(liveDbPath(home))).toBe(false);
  expect(seen).toHaveLength(2);
});

it('remote failures never fall back to a local store', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-cli-nudge-'));
  const server = createServer((_req, res) => { res.writeHead(403); res.end(); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const target of [url, 'bad']) {
    expect((await runCliCaptured(['collections', 'nudge', 'tasks/task'], { env: { LOOM_URL: target, LOOM_HOME: home } })).code).not.toBe(0);
    expect(existsSync(liveDbPath(home))).toBe(false);
  }
});
