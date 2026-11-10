import { it, expect, vi } from 'vitest';
import { Agent, get, Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from './http-server.js';
import { createKnowledgeOnlyServer } from './knowledge-server.js';

it('advertises a backend keep-alive window longer than Traefik idle reuse', async () => {
  const contextDir = mkdtempSync(join(tmpdir(), 'loom-keepalive-'));
  const agent = new Agent({ keepAlive: true });
  const listen = Server.prototype.listen;
  const observed: number[][] = [];
  const spy = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
    observed.push([this.keepAliveTimeout, this.headersTimeout]);
    return (listen as (...a: unknown[]) => Server).apply(this, args);
  } as typeof listen);
  const handle = await startHttpServer({ contextDir, host: '127.0.0.1', port: 0,
    tokens: { art: 'fixture' }, createServer: createKnowledgeOnlyServer });
  try {
    const headers = await new Promise<import('node:http').IncomingHttpHeaders>((resolve, reject) => {
      get(`http://127.0.0.1:${handle.port}/health`, { agent }, res => {
        res.resume(); res.once('end', () => resolve(res.headers));
      }).once('error', reject);
    });
    // Capture before the global test harness disables idle timers at listen.
    // Before the fix this was [5000, 60000].
    expect(observed).toEqual([[120_000, 125_000]]);
    expect(headers.connection).toBe('keep-alive');

  } finally {
    spy.mockRestore(); agent.destroy(); await handle.close(); rmSync(contextDir, { recursive: true, force: true });
  }
});
