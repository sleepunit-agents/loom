import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { installTouched, listenForTouches, touchSocketPath, type TouchSource } from './index.js';
import { listenForTouchSources } from './group.js';

const dirs: string[] = [], closes: Array<() => void | Promise<void>> = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'touch-group-')); dirs.push(dir); return dir; };
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const source = (id: string): TouchSource => ({ directory: directory(), viewer: { kind: 'agent', id }, resolve: change => ({ ...change, id: id + '/' + change.id }) });
async function fixture() {
  const app = await startLoom({ home: directory(), clock: new FakeClock(), install(app) {
    installTouched(app.operations, (_viewer, change) => change);
  } });
  closes.push(() => app.close());
  return app;
}
async function announce(source: TouchSource) {
  const socket = createConnection(touchSocketPath(source.directory));
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    const reply = once(socket, 'data');
    socket.write(JSON.stringify({ type: 'memory', id: 'same' }) + '\n');
    expect(JSON.parse(String((await reply)[0]))).toEqual({ ok: true, value: null });
  } finally { socket.destroy(); }
}
it('owns all source listeners and supports concurrent repeated shutdown and restart', async () => {
  const app = await fixture(), sources = [source('art'), source('mark')];
  const changed = vi.spyOn(app.live, 'changed');
  const close = await listenForTouchSources(app.operations, sources); closes.push(close);
  for (const s of sources) await announce(s);
  expect(changed.mock.calls.flatMap(call => call[0])).toEqual([{ type: 'memory', id: 'art/same' }, { type: 'memory', id: 'mark/same' }]);
  await Promise.all([close(), close()]);
  for (const s of sources) expect(existsSync(touchSocketPath(s.directory))).toBe(false);
  closes.push(await listenForTouchSources(app.operations, sources));
});
it('rolls back earlier listeners when a later endpoint is owned by another server', async () => {
  const app = await fixture(), first = source('art'), occupied = source('mark');
  closes.push(await listenForTouches(app.operations, occupied));
  await expect(listenForTouchSources(app.operations, [first, occupied])).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(existsSync(touchSocketPath(first.directory))).toBe(false);
  expect(existsSync(touchSocketPath(occupied.directory))).toBe(true);
  await announce(occupied);
  closes.push(await listenForTouchSources(app.operations, [first]));
});
it('empty source inventory has an idempotent shutdown', async () => {
  const app = await fixture(), close = await listenForTouchSources(app.operations, []);
  await close(); await close();
});
