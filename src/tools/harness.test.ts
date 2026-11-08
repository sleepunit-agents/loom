import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { harnessInit, harnessDescribe } from './harness.js';

describe('harnessInit (MCP)', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-harness-mcp-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('creates a manifest and returns summary text', async () => {
    const text = await harnessInit(ctx, { name: 'claude-code' });
    expect(text).toMatch(/claude-code/);
    expect(text).toMatch(/created/);
    const body = await readFile(resolve(ctx, 'harnesses', 'claude-code.md'), 'utf-8');
    expect(body).toContain('harness: claude-code');
  });

  it('reports skipped-exists on re-init', async () => {
    await harnessInit(ctx, { name: 'codex' });
    const text = await harnessInit(ctx, { name: 'codex' });
    expect(text).toMatch(/skipped-exists/);
  });

  it('overwrites with overwrite=true', async () => {
    await harnessInit(ctx, { name: 'codex' });
    await writeFile(resolve(ctx, 'harnesses', 'codex.md'), '# custom\n', 'utf-8');
    const text = await harnessInit(ctx, { name: 'codex', overwrite: true });
    expect(text).toMatch(/overwritten/);
  });

  it('throws for invalid names', async () => {
    await expect(harnessInit(ctx, { name: '' })).rejects.toThrow(/name/);
    await expect(harnessInit(ctx, { name: 'foo/bar' })).rejects.toThrow(/name/);
  });
});

describe('harnessInit with target — managed block injection', () => {
  let ctx: string;
  let dir: string;

  beforeEach(async () => {
    ctx = await mkdtemp(join(tmpdir(), 'loom-harness-mcp-ctx-'));
    dir = await mkdtemp(join(tmpdir(), 'loom-harness-mcp-target-'));
  });
  afterEach(async () => {
    await rm(ctx, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a managed block with markers and hash comment on first call', async () => {
    const target = join(dir, 'CLAUDE.md');
    const text = await harnessInit(ctx, { name: 'claude-code', target });
    expect(text).toContain('Managed block:');
    expect(text).toContain('created');
    const body = await readFile(target, 'utf-8');
    expect(body).toContain('<!-- loom:start v1 harness=claude-code -->');
    expect(body).toMatch(/<!-- loom:hash [0-9a-f]{16} -->/);
    expect(body).toContain('<!-- loom:end -->');
    expect(body).toContain('mcp__loom__identity');
  });

  it('returns no-change on a second identical call (hash matches)', async () => {
    const target = join(dir, 'CLAUDE.md');
    await harnessInit(ctx, { name: 'claude-code', target });
    const text = await harnessInit(ctx, { name: 'claude-code', target });
    expect(text).toContain('no-change');
  });

  it('reinstalls (updated) when block content between markers is corrupted', async () => {
    const target = join(dir, 'CLAUDE.md');
    await harnessInit(ctx, { name: 'claude-code', target });
    // Corrupt the inner body (leaving markers intact)
    const original = await readFile(target, 'utf-8');
    const corrupted = original.replace('Persistent identity via loom', 'CORRUPTED by user');
    await writeFile(target, corrupted, 'utf-8');
    const text = await harnessInit(ctx, { name: 'claude-code', target });
    expect(text).toContain('updated');
    const restored = await readFile(target, 'utf-8');
    expect(restored).toContain('Persistent identity via loom');
    expect(restored).not.toContain('CORRUPTED by user');
  });

  it('appends block to existing file that has no markers', async () => {
    const target = join(dir, 'CLAUDE.md');
    await writeFile(target, '# My project\n\nHand-written content.\n', 'utf-8');
    const text = await harnessInit(ctx, { name: 'claude-code', target });
    expect(text).toContain('appended');
    const body = await readFile(target, 'utf-8');
    expect(body).toContain('# My project');
    expect(body).toContain('<!-- loom:start v1 harness=claude-code -->');
  });

  it('does not write a block when target is omitted', async () => {
    const text = await harnessInit(ctx, { name: 'claude-code' });
    expect(text).not.toContain('Managed block:');
  });

  it('works with an unknown harness name (defaults to mcp__loom__ prefix)', async () => {
    const target = join(dir, 'AGENTS.md');
    const text = await harnessInit(ctx, { name: 'my-custom-harness', target });
    expect(text).toContain('Managed block:');
    const body = await readFile(target, 'utf-8');
    expect(body).toContain('<!-- loom:start v1 harness=my-custom-harness -->');
    expect(body).toContain('mcp__loom__identity');
  });
});

describe('harnessDescribe (MCP, peer-scoped)', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-harness-describe-mcp-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('writes a manifest keyed to the connected peer (normalized)', async () => {
    const text = await harnessDescribe(ctx, { content: '## Surface\nCodex.\n' }, 'Codex CLI');
    expect(text).toMatch(/codex-cli/);
    expect(text).toMatch(/created/);
    const body = await readFile(resolve(ctx, 'harnesses', 'codex-cli.md'), 'utf-8');
    expect(body).toContain('harness: codex-cli');
    expect(body).toContain('## Surface');
  });

  it('resolves the peer to an existing harness via answersTo (cannot fork a duplicate)', async () => {
    await mkdir(resolve(ctx, 'harnesses'), { recursive: true });
    await writeFile(
      resolve(ctx, 'harnesses', 'claude-desktop.md'),
      '---\nharness: claude-desktop\nanswersTo: claude-ai\n---\n\noriginal\n',
    );
    const text = await harnessDescribe(ctx, { content: 'updated body' }, 'claude-ai (via mcp-remote 0.1.37)');
    expect(text).toMatch(/claude-desktop/);
    // It wrote claude-desktop.md, NOT a new claude-ai.md.
    const body = await readFile(resolve(ctx, 'harnesses', 'claude-desktop.md'), 'utf-8');
    expect(body).toContain('updated body');
    const aliasMissing = await readFile(resolve(ctx, 'harnesses', 'claude-ai.md'), 'utf-8').catch(() => null);
    expect(aliasMissing).toBeNull();
  });

  it('refuses when there is no connected peer', async () => {
    const text = await harnessDescribe(ctx, { content: 'body' }, undefined);
    expect(text).toMatch(/Error/);
    expect(text).toMatch(/clientInfo|connected peer/);
  });
});
