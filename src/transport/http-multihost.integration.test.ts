import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
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
  try {
    await expect(startHttpServer({ contextDir, host: ['127.0.0.1', '127.0.0.2'], port })).rejects.toThrow(/EADDRINUSE/);
    const retry = await startHttpServer({ contextDir, host: '127.0.0.1', port });
    await retry.close();
  } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); rmSync(contextDir, { recursive: true, force: true }); }
});
