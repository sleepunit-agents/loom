import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBuiltInAdapter, loadClientAdapter } from './clients.js';

describe('getBuiltInAdapter', () => {
  it('returns adapter for claude-code', () => {
    const adapter = getBuiltInAdapter('claude-code');
    expect(adapter).toContain('Claude Code');
    expect(adapter).toContain('mcp__loom__');
  });

  it('returns adapter for gemini-cli', () => {
    const adapter = getBuiltInAdapter('gemini-cli');
    expect(adapter).toContain('Gemini');
    expect(adapter).toContain('`mcp_loom_identity`');
    expect(adapter).not.toContain('mcp__loom__');
  });

  it('returns null for unknown client', () => {
    expect(getBuiltInAdapter('unknown-runtime')).toBeNull();
  });

  it('all adapters include the identity tool', () => {
    for (const client of ['claude-code', 'gemini-cli']) {
      expect(getBuiltInAdapter(client)).toContain('identity');
    }
  });
});

describe('loadClientAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-clients-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns built-in adapter when no override exists', async () => {
    const adapter = await loadClientAdapter(tempDir, 'claude-code');
    expect(adapter).toContain('Claude Code');
  });

  it('returns user override when present', async () => {
    await mkdir(join(tempDir, 'clients'), { recursive: true });
    await writeFile(join(tempDir, 'clients', 'custom.md'), '## Custom Adapter\nCustom content');

    const adapter = await loadClientAdapter(tempDir, 'custom');
    expect(adapter).toContain('Custom Adapter');
  });

  it('returns null for unknown client with no override', async () => {
    const adapter = await loadClientAdapter(tempDir, 'unknown-runtime');
    expect(adapter).toBeNull();
  });
});

describe('loadClientAdapter — path-segment validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-clients-pathsafety-'));
    // A file OUTSIDE clients/ that traversal would reach
    await writeFile(join(tempDir, 'secret.md'), 'TOP-SECRET-CONTENT');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('throws on a client name with path traversal', async () => {
    await expect(loadClientAdapter(tempDir, '../secret')).rejects.toThrow(/client name/);
    await expect(loadClientAdapter(tempDir, '../../etc/passwd')).rejects.toThrow(/client name/);
  });

  it('throws on backslash separators and empty names', async () => {
    await expect(loadClientAdapter(tempDir, '..\\secret')).rejects.toThrow(/client name/);
    await expect(loadClientAdapter(tempDir, '')).rejects.toThrow(/client name/);
  });

  it('still loads a legitimate override', async () => {
    await mkdir(join(tempDir, 'clients'), { recursive: true });
    await writeFile(join(tempDir, 'clients', 'my-runtime.md'), '## Runtime: Mine\nHello');
    const adapter = await loadClientAdapter(tempDir, 'my-runtime');
    expect(adapter).toContain('Runtime: Mine');
  });
});
