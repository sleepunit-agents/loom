import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createFoundation } from '../app.js';
import { FakeClock } from '../clock.js';
import { installTouched, listenForTouches, touched, touchSocketPath } from './index.js';
const dirs: string[] = [], closes: (() => void | Promise<void>)[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'touch-net-')); dirs.push(dir); return dir; };
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('binds inside a private directory even with permissive umask; refuses a competitor and removes its endpoint', async () => {
  const dir = home(), app = createFoundation({ home: home(), clock: new FakeClock() }); closes.push(() => app.close());
  installTouched(app.operations, (_viewer, c) => c);
  const source = { directory: dir, viewer: { kind: 'agent' as const, id: 'art' }, resolve: (c: { type: string; id: string }) => c };
  const oldMask = process.umask(0);
  let close: () => Promise<void>;
  const resources = process.getActiveResourcesInfo();
  try { close = await listenForTouches(app.operations, source); } finally { process.umask(oldMask); }
  expect(statSync(join(dir, '.loom-live')).mode & 0o777).toBe(0o700);
  expect(statSync(touchSocketPath(dir)).mode & 0o777).toBe(0o600);
  for (const resource of ['Timeout', 'FSEventWrap', 'StatWatcher']) {
    expect(process.getActiveResourcesInfo().filter(r => r === resource).length).toBe(resources.filter(r => r === resource).length);
  }
  await expect(listenForTouches(app.operations, source)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  await close!();
  expect(existsSync(touchSocketPath(dir))).toBe(false);
  // An unusable endpoint is best-effort too; no unhandled connection error may escape.
  writeFileSync(touchSocketPath(dir), 'stale endpoint');
  expect(() => touched(dir, 'memory', 'ref')).not.toThrow();
});
it('an absolute deadline closes a connected silent receiver at 250 ms using the fake clock', async () => {
  const dir = home(), app = createFoundation({ home: home(), clock: new FakeClock() }); closes.push(() => app.close());
  // Create the same private endpoint directory, then replace the receiver with a silent local server.
  const close = await listenForTouches(app.operations, { directory: dir, viewer: { kind: 'agent', id: 'art' }, resolve: () => undefined }); await close();
  const server = createServer();
  await new Promise<void>(resolve => server.listen(touchSocketPath(dir), resolve));
  closes.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const accepted = once(server, 'connection');
  const clock = new FakeClock();
  touched(dir, 'memory', 'ref', clock);
  const [connection] = await accepted; connection.resume();
  const ended = once(connection, 'end');
  clock.advance(249); expect(connection.destroyed).toBe(false);
  clock.advance(1); await ended;
});
