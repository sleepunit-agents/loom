/**
 * Tests for the MCP server factory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLoomServer, type LoomServerConfig } from './server.js';
import { CURRENT_STACK_VERSION } from './config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContextDir(base: string): string {
  const contextDir = join(base, 'context');
  mkdirSync(join(contextDir, 'memories'), { recursive: true });

  return contextDir;
}

function makeConfig(base: string): LoomServerConfig {
  return { contextDir: makeContextDir(base) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createLoomServer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a server without errors', () => {
    const config = makeConfig(tmpDir);
    const { server } = createLoomServer(config);
    expect(server).toBeDefined();
  });

  it('creates multiple independent server instances', () => {
    const config = makeConfig(tmpDir);
    const { server: s1 } = createLoomServer(config);
    const { server: s2 } = createLoomServer(config);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1).not.toBe(s2);
  });

  // t-415: every tool must declare ToolAnnotations so clients that gate on
  // readOnlyHint/destructiveHint under approval:never (e.g. Codex) can tell
  // a read from a write without a human in the loop. undefined means
  // "not asserted" here, not "false" — most tools only carry readOnlyHint,
  // and destructiveHint/idempotentHint are only meaningful when
  // readOnlyHint is false (MCP spec).
  const EXPECTED_ANNOTATIONS: Record<string, {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  }> = {
    identity: { readOnlyHint: true, openWorldHint: false },
    dossier: { readOnlyHint: true, openWorldHint: false },
    remember: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    recall: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    forget: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    memory_prune: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    memory_list: { readOnlyHint: true, openWorldHint: false },
    episodes: { readOnlyHint: true, openWorldHint: false },
    find_similar: { readOnlyHint: true, openWorldHint: false },
    memory_audit: { readOnlyHint: true, openWorldHint: false },
    memory_archive: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    memory_restore: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    memory_propose: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    memory_proposals: { readOnlyHint: true, openWorldHint: false },
    memory_ratify: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    memory_reject: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    update_identity: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    bootstrap: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    harness_init: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    harness_describe: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    knowledge_write: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    knowledge_recall: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    knowledge_maintain: { readOnlyHint: true, openWorldHint: false },
    knowledge_archive: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    knowledge_restore: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    knowledge_move: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    knowledge_merge: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    knowledge_supersede: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    knowledge_purge: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    knowledge_verify: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    knowledge_history: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    memory_history: { readOnlyHint: true, openWorldHint: false },
    memory_revision_restore: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  };

  it('advertises correct ToolAnnotations for every registered tool', async () => {
    const { server } = createLoomServer(makeConfig(tmpDir));
    const client = new Client({ name: 'annotation-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      const expectedNames = Object.keys(EXPECTED_ANNOTATIONS);
      const actualNames = tools.map((t) => t.name);
      // Catches drift: a new tool landing with no entry here (and no
      // annotations) would otherwise pass silently.
      expect(actualNames.sort()).toEqual(expectedNames.slice().sort());

      for (const [name, expected] of Object.entries(EXPECTED_ANNOTATIONS)) {
        const annotations = byName.get(name)?.annotations;
        expect(annotations?.readOnlyHint, `${name}.readOnlyHint`).toBe(expected.readOnlyHint);
        expect(annotations?.openWorldHint, `${name}.openWorldHint`).toBe(expected.openWorldHint);
        if (expected.destructiveHint !== undefined) {
          expect(annotations?.destructiveHint, `${name}.destructiveHint`).toBe(expected.destructiveHint);
        }
        if (expected.idempotentHint !== undefined) {
          expect(annotations?.idempotentHint, `${name}.idempotentHint`).toBe(expected.idempotentHint);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('createLoomServer — stack version', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-version-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes CURRENT_STACK_VERSION on boot for a fresh context dir', () => {
    const contextDir = makeContextDir(tmpDir);
    const stampPath = join(contextDir, 'LOOM_STACK_VERSION');
    expect(existsSync(stampPath)).toBe(false);

    createLoomServer({ contextDir });

    expect(existsSync(stampPath)).toBe(true);
    expect(readFileSync(stampPath, 'utf-8')).toBe(`${CURRENT_STACK_VERSION}\n`);
  });

  it('leaves an existing in-range LOOM_STACK_VERSION alone', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), '1\n');

    createLoomServer({ contextDir });

    expect(readFileSync(join(contextDir, 'LOOM_STACK_VERSION'), 'utf-8')).toBe('1\n');
  });

  it('throws on boot when on-disk version is ahead of what loom understands', () => {
    const contextDir = makeContextDir(tmpDir);
    const ahead = CURRENT_STACK_VERSION + 1;
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), `${ahead}\n`);

    expect(() => createLoomServer({ contextDir })).toThrow(new RegExp(`is version ${ahead}`, 'i'));
  });

  it('throws on boot when LOOM_STACK_VERSION is unparseable', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), 'banana');

    expect(() => createLoomServer({ contextDir })).toThrow(/unparseable/i);
  });
});

describe('createLoomServer — blank identity guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-bootguard-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('boots normally for a non-default contextDir even with no IDENTITY.md', () => {
    // All existing tests exercise this path — non-default dir, no enforcement
    const contextDir = join(tmpDir, 'explicit-context');
    mkdirSync(join(contextDir, 'memories'), { recursive: true });
    expect(() => createLoomServer({ contextDir })).not.toThrow();
  });

  it('boots normally for a non-default contextDir that has IDENTITY.md', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'IDENTITY.md'), '# Test\n');
    expect(() => createLoomServer({ contextDir })).not.toThrow();
  });
});
