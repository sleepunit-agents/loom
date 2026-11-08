import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as harness from './harness.js';
import { initHarness } from './harness.js';

describe('blocks/harness', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-harness-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('read', () => {
    it('returns null when harnesses/ directory does not exist', async () => {
      expect(await harness.read(dir, 'claude-code')).toBeNull();
    });

    it('returns null when the specific manifest is missing', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      expect(await harness.read(dir, 'claude-code')).toBeNull();
    });

    it('rejects keys with path traversal', async () => {
      await writeFile(join(dir, 'secret.md'), 'TOP-SECRET');
      await expect(harness.read(dir, '../secret')).rejects.toThrow(/harness name/);
      await expect(harness.read(dir, '..\\secret')).rejects.toThrow(/harness name/);
      await expect(harness.read(dir, '..')).rejects.toThrow(/harness name/);
      await expect(harness.read(dir, '')).rejects.toThrow(/harness name/);
    });

    it('returns null when the manifest file is empty', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      await writeFile(join(dir, 'harnesses', 'claude-code.md'), '');
      expect(await harness.read(dir, 'claude-code')).toBeNull();
    });

    it('returns a Block with parsed frontmatter and trimmed body', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      await writeFile(
        join(dir, 'harnesses', 'claude-code.md'),
        '---\nharness: claude-code\nversion: 0.4\n---\n\n## Tool prefixes\nmcp__loom__*\n',
      );
      const block = await harness.read(dir, 'claude-code');
      expect(block).not.toBeNull();
      expect(block?.key).toBe('claude-code');
      expect(block?.frontmatter).toEqual({ harness: 'claude-code', version: '0.4' });
      expect(block?.body).toContain('## Tool prefixes');
      expect(block?.path).toBe(join(dir, 'harnesses', 'claude-code.md'));
    });

    it('returns a Block with empty frontmatter when file has none', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      await writeFile(join(dir, 'harnesses', 'claude-code.md'), '## Tool prefixes\nmcp__loom__*\n');
      const block = await harness.read(dir, 'claude-code');
      expect(block?.frontmatter).toEqual({});
      expect(block?.body).toContain('## Tool prefixes');
    });
  });

  describe('list', () => {
    it('returns [] when harnesses/ is missing', async () => {
      expect(await harness.list(dir)).toEqual([]);
    });

    it('returns sorted keys for present manifests', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      await writeFile(join(dir, 'harnesses', 'gemini-cli.md'), '# gemini-cli');
      await writeFile(join(dir, 'harnesses', 'claude-code.md'), '# claude-code');
      await writeFile(join(dir, 'harnesses', 'not-a-manifest.txt'), 'skip me');
      expect(await harness.list(dir)).toEqual(['claude-code', 'gemini-cli']);
    });
  });

  describe('template', () => {
    it('returns a template string containing the supplied key in the frontmatter', () => {
      const tpl = harness.template('claude-code');
      expect(tpl).toContain('harness: claude-code');
      expect(tpl).toContain('## Tool prefixes');
      expect(tpl).toContain('## Delegation primitive');
      expect(tpl).toContain('## Cron / scheduling');
      expect(tpl).toContain('## Session search');
      expect(tpl).toContain('## Gotchas');
    });
  });
});

describe('initHarness', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-harness-init-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('creates harnesses/<name>.md from the template on a fresh stack', async () => {
    const result = await initHarness(ctx, 'claude-code');
    expect(result.action).toBe('created');
    expect(result.name).toBe('claude-code');
    expect(result.path).toBe(resolve(ctx, 'harnesses', 'claude-code.md'));
    const body = await readFile(result.path, 'utf-8');
    expect(body).toContain('harness: claude-code');
    expect(body).toContain('Tool prefixes');
  });

  it('creates the harnesses directory if missing', async () => {
    await initHarness(ctx, 'codex');
    const entries = await readdir(resolve(ctx, 'harnesses'));
    expect(entries).toContain('codex.md');
  });

  it('reports skipped-exists for an already-initialized harness', async () => {
    await initHarness(ctx, 'codex');
    const result = await initHarness(ctx, 'codex');
    expect(result.action).toBe('skipped-exists');
  });

  it('overwrites when opts.overwrite is true', async () => {
    const path = resolve(ctx, 'harnesses', 'codex.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '# customized manifest body', 'utf-8');
    const result = await initHarness(ctx, 'codex', { overwrite: true });
    expect(result.action).toBe('overwritten');
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('harness: codex');
  });

  it('rejects names containing path separators', async () => {
    await expect(initHarness(ctx, 'foo/bar')).rejects.toThrow(/name/);
  });

  it('rejects an empty name', async () => {
    await expect(initHarness(ctx, '')).rejects.toThrow(/name/);
  });
});
