import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { PeriodicOwner } from './periodic-owner.js';
import { startHttpServer } from './http-server.js';

it('shares an MCP session across sockets and checks every bind before startup', async () => {
  const contextDir = mkdtempSync(join(tmpdir(), 'loom-hosts-'));
  const host = ['127.0.0.1', '127.0.0.2'];
  let handle;
  try {
    await expect(startHttpServer({ contextDir, host: [...host, '0.0.0.0'], port: 0 })).rejects.toThrow();
    handle = await startHttpServer({ contextDir, host, port: 0, token: 'test' });
    const headers = { authorization: 'Bearer test', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const response = await fetch(`http://${host[0]}:${handle.port}/mcp`, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'multi', version: '1' } } }) });
    expect(response.status).toBe(200);
    await response.text();
    const session = response.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();
    const removed = await fetch(`http://${host[1]}:${handle.port}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } });
    expect([200, 204]).toContain(removed.status);
    await removed.text();
    expect((await fetch(`http://${host[1]}:${handle.port}/mcp`)).status).toBe(401);
  } finally { await handle?.close(); rmSync(contextDir, { recursive: true, force: true }); }
});

it('closes all sockets after a partial bind failure so startup can be retried', async () => {
  const contextDir = mkdtempSync(join(tmpdir(), 'loom-host-failure-'));
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.2', resolve));
  const port = (blocker.address() as { port: number }).port;
  const eligibility = vi.spyOn(PeriodicOwner.prototype, 'setEligible');
  try {
    await expect(startHttpServer({ contextDir, host: ['127.0.0.1', '127.0.0.2'], port })).rejects.toThrow(/EADDRINUSE/);
    expect(eligibility).not.toHaveBeenCalledWith(true);
    const retry = await startHttpServer({ contextDir, host: '127.0.0.1', port });
    await retry.close();
  } finally { eligibility.mockRestore(); await new Promise<void>(resolve => blocker.close(() => resolve())); rmSync(contextDir, { recursive: true, force: true }); }
});

it('registers and executes the same periodic jobs once regardless of socket count', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const run = vi.spyOn(PeriodicOwner.prototype, 'run').mockResolvedValue();
  const timers = vi.spyOn(globalThis, 'setInterval');
  const eligibility = vi.spyOn(PeriodicOwner.prototype, 'setEligible');
  const dirs: string[] = [];
  async function measure(host: string | string[]) {
    const contextDir = mkdtempSync(join(tmpdir(), 'loom-job-count-')); dirs.push(contextDir);
    run.mockClear(); timers.mockClear(); eligibility.mockClear();
    const handle = await startHttpServer({ contextDir, host, port: 0 });
    const registrations = timers.mock.calls.map(call => call[1]);
    expect(eligibility.mock.calls.filter(call => call[0])).toHaveLength(1);
    run.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    const jobs = run.mock.calls.map(call => call[0]);
    expect(jobs.filter(name => name === 'audit and measures sweep')).toHaveLength(1);
    await handle.close();
    return { registrations, jobs };
  }
  try { expect(await measure(['127.0.0.1', '127.0.0.2'])).toEqual(await measure('127.0.0.1')); }
  finally { vi.restoreAllMocks(); vi.useRealTimers(); dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })); }
});
