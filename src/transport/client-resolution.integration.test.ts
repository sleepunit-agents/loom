/**
 * Handshake-derived client (c-loom-identity: ac-li-client-from-handshake).
 * The connecting MCP peer's clientInfo.name picks the harness; LOOM_CLIENT is
 * the fallback; an explicit `client` param overrides both.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveClientFromPeer } from '../tools/identity.js';
import { startHttpServer, type HttpServeHandle } from './http-server.js';

describe('resolveClientFromPeer (the mapping)', () => {
  it('maps known peers, normalizing case/spacing', () => {
    expect(resolveClientFromPeer('claude-code')).toBe('claude-code');
    expect(resolveClientFromPeer('Claude Code')).toBe('claude-code');
    expect(resolveClientFromPeer('claude-ai')).toBe('claude-desktop'); // Desktop
    expect(resolveClientFromPeer('Claude_Desktop')).toBe('claude-desktop');
    expect(resolveClientFromPeer('gemini-cli')).toBe('gemini-cli');
  });
  it('strips a proxy annotation like "(via mcp-remote 0.1.37)"', () => {
    // The real clientInfo Claude Desktop sends through mcp-remote.
    expect(resolveClientFromPeer('claude-ai (via mcp-remote 0.1.37)')).toBe('claude-desktop');
    expect(resolveClientFromPeer('claude-code (via mcp-remote 0.2.0)')).toBe('claude-code');
  });
  it('returns undefined for unknown/proxy peers so LOOM_CLIENT wins (no regression)', () => {
    expect(resolveClientFromPeer(undefined)).toBeUndefined();
    expect(resolveClientFromPeer('')).toBeUndefined();
    expect(resolveClientFromPeer('mcp-remote')).toBeUndefined();
    expect(resolveClientFromPeer('some-random-client')).toBeUndefined();
  });
});

describe('c-loom-identity: harness from the handshake', () => {
  let tmpDir: string;
  let handle: HttpServeHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-clientres-'));
    writeFileSync(join(tmpDir, 'IDENTITY.md'), '# creed\nI am the test.\n');
    mkdirSync(join(tmpDir, 'harnesses'), { recursive: true });
    writeFileSync(join(tmpDir, 'harnesses', 'claude-code.md'), '---\nharness: claude-code\n---\nCODE-HARNESS-MARKER\n');
    writeFileSync(join(tmpDir, 'harnesses', 'claude-desktop.md'), '---\nharness: claude-desktop\n---\nDESKTOP-HARNESS-MARKER\n');
    handle = await startHttpServer({ contextDir: tmpDir, host: '127.0.0.1', port: 0 });
  });
  afterEach(async () => {
    await handle.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function identityAs(peerName: string, args: Record<string, unknown> = {}): Promise<string> {
    const client = new Client({ name: peerName, version: '0.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/`)));
    const r = await client.callTool({ name: 'identity', arguments: args });
    const text = ((r.content ?? []) as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    await client.close();
    return text;
  }

  it('a claude-ai peer (Desktop) gets the desktop harness', async () => {
    const out = await identityAs('claude-ai');
    expect(out).toContain('DESKTOP-HARNESS-MARKER');
    expect(out).not.toContain('CODE-HARNESS-MARKER');
  });

  it('a claude-code peer gets the code harness', async () => {
    const out = await identityAs('claude-code');
    expect(out).toContain('CODE-HARNESS-MARKER');
    expect(out).not.toContain('DESKTOP-HARNESS-MARKER');
  });

  it('an explicit client param overrides the peer', async () => {
    const out = await identityAs('claude-ai', { client: 'claude-code' });
    expect(out).toContain('CODE-HARNESS-MARKER');
    expect(out).not.toContain('DESKTOP-HARNESS-MARKER');
  });

  // An unknown runtime gets the self-describe onboarding prompt (via its own
  // normalized name) — NOT silently served someone else's harness.
  it('an unknown peer gets the harness onboarding prompt', async () => {
    const out = await identityAs('mystery-x-runtime');
    expect(out).toMatch(/harness_describe/);
    expect(out).toMatch(/unknown/i);
    expect(out).not.toContain('DESKTOP-HARNESS-MARKER');
    expect(out).not.toContain('CODE-HARNESS-MARKER');
  });
  it('identity MCP forwards work profile and explicit full restores the complete identity', async () => {
    writeFileSync(join(tmpDir, 'work-identity.md'), 'WORK-IDENTITY-MARKER');
    writeFileSync(join(tmpDir, 'preferences.md'), 'FULL-PREFERENCES-MARKER');
    mkdirSync(join(tmpDir, 'roles')); mkdirSync(join(tmpDir, 'projects'));
    writeFileSync(join(tmpDir, 'roles', 'coding.md'), 'INTEGRATED-ROLE');
    writeFileSync(join(tmpDir, 'projects', 'repo.md'), 'INTEGRATED-PROJECT');
    const work = await identityAs('claude-code', { profile: 'work', role: 'coding', project: 'repo', people: ['loren'] });
    expect(work).toContain('INTEGRATED-ROLE');
    expect(work).toContain('INTEGRATED-PROJECT');
    expect(work).toContain('_(no card for loren)_');
    expect(work).toContain('WORK-IDENTITY-MARKER');
    expect(work).not.toContain('I am the test.');
    expect(work).not.toContain('FULL-PREFERENCES-MARKER');
    expect(work).not.toContain('CODE-HARNESS-MARKER');
    const full = await identityAs('claude-code', { profile: 'full' });
    expect(full).toContain('I am the test.');
    expect(full).toContain('FULL-PREFERENCES-MARKER');
    expect(full).toContain('CODE-HARNESS-MARKER');
    expect(full).not.toContain('WORK-IDENTITY-MARKER');
  });

});
