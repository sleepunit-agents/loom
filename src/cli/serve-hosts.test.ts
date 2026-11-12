import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../transport/http-server.js', () => ({ startHttpServer: vi.fn(async () => { throw new Error('captured startup'); }) }));
import { startHttpServer } from '../transport/http-server.js';
import { acquireHttpLock } from '../transport/http-lock.js';
import { run } from './serve.js';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-serve-host-')); dirs.push(dir);
  vi.stubEnv('LOOM_CONTEXT_DIR', dir); vi.stubEnv('LOOM_HTTP_HOST', '127.0.0.1,127.0.0.2');
  return dir;
}
const io = { stdout: () => {}, stderr: () => {} };
it('reads comma-separated environment hosts', async () => {
  const dir = setup();
  await expect(run(['--http'], io)).rejects.toThrow('captured startup');
  expect(startHttpServer).toHaveBeenCalledWith(expect.objectContaining({ host: ['127.0.0.1', '127.0.0.2'] }));
  acquireHttpLock(dir)(); // A failed startup released the lock.
});
it('repeated flags override environment hosts', async () => {
  setup();
  await expect(run(['--http', '--host', '127.0.0.3', '--host', '127.0.0.4'], io)).rejects.toThrow('captured startup');
  expect(startHttpServer).toHaveBeenCalledWith(expect.objectContaining({ host: ['127.0.0.3', '127.0.0.4'] }));
});
it('refuses a second serve before initializing any jobs or sockets', async () => {
  const release = acquireHttpLock(setup());
  try {
    await expect(run(['--http'], io)).rejects.toThrow(/already running/);
    expect(startHttpServer).not.toHaveBeenCalled();
  } finally { release(); }
});
