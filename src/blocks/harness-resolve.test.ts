import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePeerToHarness, describeHarness } from './harness.js';

describe('resolvePeerToHarness (data-driven)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-harness-resolve-'));
    await mkdir(join(dir, 'harnesses'), { recursive: true });
    await writeFile(
      join(dir, 'harnesses', 'claude-desktop.md'),
      '---\nharness: claude-desktop\nversion: 0.3\nanswersTo: claude-ai\n---\n\n## Surface\nDesktop.\n',
    );
    await writeFile(
      join(dir, 'harnesses', 'mystery.md'),
      '---\nharness: mystery\n---\n\n## Surface\nUnknown.\n',
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves an answersTo alias (with proxy annotation) to its harness key', async () => {
    expect(await resolvePeerToHarness(dir, 'claude-ai (via mcp-remote 0.1.37)')).toBe('claude-desktop');
  });

  it('resolves a bare peer name to a matching filename', async () => {
    expect(await resolvePeerToHarness(dir, 'mystery')).toBe('mystery');
  });

  it('returns undefined when nothing matches', async () => {
    expect(await resolvePeerToHarness(dir, 'nope')).toBeUndefined();
  });

  it('returns undefined for an empty/absent peer', async () => {
    expect(await resolvePeerToHarness(dir, undefined)).toBeUndefined();
    expect(await resolvePeerToHarness(dir, '')).toBeUndefined();
  });

  it('normalizes spaces/underscores/case when matching a filename', async () => {
    await writeFile(join(dir, 'harnesses', 'gemini-cli.md'), '---\nharness: gemini-cli\n---\n');
    expect(await resolvePeerToHarness(dir, 'Gemini CLI')).toBe('gemini-cli');
    expect(await resolvePeerToHarness(dir, 'gemini_cli')).toBe('gemini-cli');
  });

  it('matches against multi-value comma-split answersTo', async () => {
    await writeFile(
      join(dir, 'harnesses', 'codex.md'),
      '---\nharness: codex\nanswersTo: openai-codex, codex-cli\n---\n',
    );
    expect(await resolvePeerToHarness(dir, 'codex-cli')).toBe('codex');
    expect(await resolvePeerToHarness(dir, 'openai-codex')).toBe('codex');
  });
});

describe('describeHarness', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-harness-describe-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a manifest with stamped frontmatter under harnesses/', async () => {
    const result = await describeHarness(dir, 'codex', '## Tool prefixes\nbare names.\n');
    expect(result.action).toBe('created');
    expect(result.path).toBe(resolve(dir, 'harnesses', 'codex.md'));
    const body = await readFile(result.path, 'utf-8');
    expect(body).toContain('harness: codex');
    expect(body).toContain('version: 0.1');
    expect(body).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
    expect(body).toContain('## Tool prefixes');
  });

  it('honors a provided version', async () => {
    const result = await describeHarness(dir, 'codex', 'body', { version: '2.0' });
    const body = await readFile(result.path, 'utf-8');
    expect(body).toContain('version: 2.0');
  });

  it('overwrites on re-run', async () => {
    await describeHarness(dir, 'codex', 'first body');
    const result = await describeHarness(dir, 'codex', 'second body');
    expect(result.action).toBe('overwritten');
    const body = await readFile(result.path, 'utf-8');
    expect(body).toContain('second body');
    expect(body).not.toContain('first body');
  });

  it('lands strictly under harnesses/ — rejects traversal keys', async () => {
    await expect(describeHarness(dir, '../IDENTITY', 'creed override')).rejects.toThrow(/harness name/);
    await expect(describeHarness(dir, '..', 'x')).rejects.toThrow(/harness name/);
    await expect(describeHarness(dir, '', 'x')).rejects.toThrow(/harness name/);
  });
});
