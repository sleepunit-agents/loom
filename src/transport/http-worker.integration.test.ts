import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from './http-server.js';

it('private supervised worker keeps the bearer gate on MCP requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-worker-'));
  const socketPath = join(dir, 'worker.sock');
  const prior = process.env.LOOM_WORKER_SOCKET;
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  process.env.LOOM_WORKER_SOCKET = socketPath;
  Object.defineProperty(process, 'connected', { value: true, configurable: true });
  let handle;
  try {
    handle = await startHttpServer({ contextDir: dir, host: '127.0.0.1', port: 0, token: 'worker-test-token' });
    const call = (token?: string) => new Promise<number>((resolve, reject) => {
      const req = request({ socketPath, path: '/mcp', method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'worker-test', version: '1' } } }));
    });
    expect(await call()).toBe(401);
    expect(await call('wrong')).toBe(401);
    expect(await call('worker-test-token')).toBe(200);
  } finally {
    if (connected) Object.defineProperty(process, 'connected', connected);
    else Reflect.deleteProperty(process, 'connected');
    if (prior === undefined) delete process.env.LOOM_WORKER_SOCKET;
    else process.env.LOOM_WORKER_SOCKET = prior;
    await handle?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
