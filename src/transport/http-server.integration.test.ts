/**
 * c-loom-transport end-to-end — the HTTP daemon driven by the real MCP client.
 * Greens: ac-lt-envelope-ok (parity), ac-lt-envelope-bad-input, ac-lt-dispatch-total,
 *          ac-lt-auth-gate (over the wire), ac-lt-no-cloud-callback (witness).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, type HttpServeHandle } from './http-server.js';
import { recall } from '../tools/recall.js';

const TOKEN = 'test-bearer-secret';

async function connectClient(port: number, token?: string): Promise<Client> {
  const client = new Client({ name: 'loom-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
}

describe('c-loom-transport: HTTP daemon', () => {
  let tmpDir: string;
  let handle: HttpServeHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-http-'));
    handle = await startHttpServer({ contextDir: tmpDir, host: '127.0.0.1', port: 0, token: TOKEN });
  });
  afterEach(async () => {
    await handle.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ac-lt-envelope-ok + ac-lt-envelope-ok parity
  it('serves a tool call over HTTP with the SAME result as the in-process tool (parity)', async () => {
    const client = await connectClient(handle.port, TOKEN);
    const httpResult = await client.callTool({ name: 'recall', arguments: { query: 'nothing here' } });
    const direct = await recall(tmpDir, { query: 'nothing here' });
    expect(textOf(httpResult)).toBe(direct); // transport is a carrier, not a semantic
    expect(textOf(httpResult)).toMatch(/No memories found/);
    await client.close();
  });

  // ac-lt-dispatch-total: unknown tool -> a typed JSON-RPC error, not a panic.
  // Split-SDK behavior change (t-886): the 1.x McpServer answered an unknown
  // tool name with a CallToolResult{isError:true}; the 2.x McpServer answers
  // it at the protocol level (-32602, thrown client-side as McpError) and
  // reserves isError:true for a known tool whose execution/validation fails
  // (see the next test). Either way dispatch totality holds — the session
  // survives and serves the next call — so this asserts the new shape.
  it('returns a protocol-level error for an unknown tool (dispatch totality)', async () => {
    const client = await connectClient(handle.port, TOKEN);
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/no_such_tool/);
    // server still alive for the next call — no panic path
    const ok = await client.callTool({ name: 'recall', arguments: { query: 'x' } });
    expect(textOf(ok)).toMatch(/No memories found/);
    await client.close();
  });

  // ac-lt-envelope-bad-input: malformed args -> typed error envelope
  it('returns a typed error for malformed tool arguments', async () => {
    const client = await connectClient(handle.port, TOKEN);
    // remember requires content/title/category; empty args fail validation
    const r = await client.callTool({ name: 'remember', arguments: {} });
    expect(r.isError).toBe(true);
    await client.close();
  });

  // ac-lt-auth-gate: over the wire
  it('refuses a connection with no bearer token, and one with a wrong token', async () => {
    await expect(connectClient(handle.port, undefined)).rejects.toThrow();
    await expect(connectClient(handle.port, 'wrong-token')).rejects.toThrow();
  });
});

describe('c-loom-transport: session lifecycle (no-stream + recovery)', () => {
  let tmpDir: string;
  let handle: HttpServeHandle;
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-sess-'));
    handle = await startHttpServer({ contextDir: tmpDir, host: '127.0.0.1', port: 0 });
  });
  afterEach(async () => {
    await handle.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // A GET with no established session can't attach a stream -> 405.
  it('returns 405 for a GET with no session', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  // An expired/unknown session must be 404 so the client RE-INITIALIZES rather
  // than bricking on a 400 (the Desktop failure mode).
  it('returns 404 for a tool call against an unknown session (triggers re-init)', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'ghost-session-that-does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'recall', arguments: { query: 'x' } } }),
    });
    expect(res.status).toBe(404);
  });
});

describe('c-loom-transport: SSE heartbeat keeps the session alive', () => {
  it('survives several heartbeat cycles (live client pongs; session not reaped)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loom-hb-'));
    // Fast heartbeat so several cycles elapse within the test.
    const handle = await startHttpServer({ contextDir: tmpDir, host: '127.0.0.1', port: 0, heartbeatMs: 120 });
    try {
      const client = new Client({ name: 'loom-test', version: '0.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/`)));
      // Let ~6 heartbeat pings fire; a dead-detection bug would close the session.
      await new Promise((r) => setTimeout(r, 800));
      const r = await client.callTool({ name: 'recall', arguments: { query: 'x' } });
      const text = ((r.content ?? []) as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      expect(text).toMatch(/No memories found/); // session still alive after the heartbeats
      await client.close();
    } finally {
      await handle.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('c-loom-transport: open token + bind-safety', () => {
  // ac-lt-auth-gate (no token configured -> open, network is the boundary)
  it('serves without a token when none is configured', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loom-http-open-'));
    const handle = await startHttpServer({ contextDir: tmpDir, host: '127.0.0.1', port: 0 });
    try {
      const client = await connectClient(handle.port, undefined);
      const r = await client.callTool({ name: 'recall', arguments: { query: 'x' } });
      expect(textOf(r)).toMatch(/No memories found/);
      await client.close();
    } finally {
      await handle.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ac-lt-bind-safety: a public bind is refused before a socket opens
  it('refuses to start on a public/0.0.0.0 bind', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loom-http-bind-'));
    try {
      await expect(
        startHttpServer({ contextDir: tmpDir, host: '0.0.0.0', port: 0 }),
      ).rejects.toThrow(/unsafe-bind/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
