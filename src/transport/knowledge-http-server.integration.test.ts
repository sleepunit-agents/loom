/**
 * t-677 — the standalone knowledge-only HTTP service, driven by a real MCP
 * client (and one raw fetch for the session-hijack check). Covers:
 *   - tool scoping: knowledge_* only, no identity/memory/dossier tools
 *   - per-identity bearer resolves the acting identity server-side
 *   - attribution: created_by defaults to the writer; reads are stamped
 *     per-identity in knowledge_access without corrupting the shared aggregate
 *   - auth: wrong/missing token refused; refuses to boot unauthenticated
 *   - a session is pinned to the identity that opened it
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, type HttpServeHandle } from './http-server.js';
import { createKnowledgeOnlyServer } from './knowledge-server.js';
import { createKnowledgeBackend } from '../backends/index.js';

const TOKENS = { art: 'art-secret-123', mark: 'mark-secret-456' };

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
}

async function connect(port: number, token?: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'loom-knowledge-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return { client, transport };
}

describe('t-677: knowledge-only HTTP service', () => {
  let tmpDir: string;
  let handle: HttpServeHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-knowledge-http-'));
    handle = await startHttpServer({
      contextDir: tmpDir,
      host: '127.0.0.1',
      port: 0,
      tokens: TOKENS,
      createServer: createKnowledgeOnlyServer,
    });
  });

  afterEach(async () => {
    await handle.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes knowledge_* tools only — no identity, memory, or dossier tools', async () => {
    const { client } = await connect(handle.port, TOKENS.art);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toContain('knowledge_write');
    expect(names).toContain('knowledge_recall');
    expect(names).toContain('knowledge_maintain');
    expect(names.every((n) => n.startsWith('knowledge_'))).toBe(true);

    for (const forbidden of ['identity', 'dossier', 'remember', 'recall', 'memory_list', 'forget']) {
      expect(names).not.toContain(forbidden);
    }
    await client.close();
  });

  it('refuses a connection with no token or a wrong token', async () => {
    await expect(connect(handle.port, undefined)).rejects.toThrow();
    await expect(connect(handle.port, 'not-a-real-token')).rejects.toThrow();
  });

  it('refuses to boot a scoped server with no tokens configured', async () => {
    await expect(
      startHttpServer({
        contextDir: tmpDir,
        host: '127.0.0.1',
        port: 0,
        createServer: createKnowledgeOnlyServer,
      }),
    ).rejects.toThrow(/tokens map/);
  });

  it("per-identity bearer attributes writes (created_by) and reads (knowledge_access) to the right identity", async () => {
    const { client: artClient } = await connect(handle.port, TOKENS.art);
    const written = await artClient.callTool({
      name: 'knowledge_write',
      arguments: {
        title: 'wake chain spec',
        domain: 'ours/art-ops',
        body: 'Art self-schedules work via the wake CLI.',
        citations: [{ claim: 'x', source_kind: 'repo', source_locator: 'Art/wake@HEAD', excerpt: 'x' }],
      },
    });
    expect(textOf(written)).toMatch(/created|updated/);
    await artClient.close();

    const { client: markClient } = await connect(handle.port, TOKENS.mark);
    const recalled = await markClient.callTool({
      name: 'knowledge_recall',
      arguments: { slug: 'wake-chain-spec' },
    });
    expect(textOf(recalled)).toMatch(/wake chain spec/i);
    await markClient.close();

    // Second read by art — same page, different identity.
    const { client: artClient2 } = await connect(handle.port, TOKENS.art);
    await artClient2.callTool({ name: 'knowledge_recall', arguments: { slug: 'wake-chain-spec' } });
    await artClient2.close();

    const backend = createKnowledgeBackend(tmpDir);
    try {
      const page = await backend.getPage('wake-chain-spec');
      expect(page!.created_by).toBe('art'); // defaulted from the writer's identity, ours/ domain
      expect(page!.hit_count).toBe(2); // shared aggregate: both reads, any identity

      const stats = await backend.getAccessStats(page!.id);
      const byIdentity = Object.fromEntries(stats.map((s) => [s.identity, s.hit_count]));
      expect(byIdentity.mark).toBe(1);
      expect(byIdentity.art).toBe(1);
    } finally {
      backend.close();
    }
  });

  it("refuses a request that replays another identity's token against an existing session", async () => {
    const { transport } = await connect(handle.port, TOKENS.art);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();

    const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKENS.mark}`,
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });

    expect(res.status).toBe(401);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toMatch(/different identity/);
  });
});
