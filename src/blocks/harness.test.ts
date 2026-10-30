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

describe('patchHarness', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-harness-patch-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  async function seed(body: string, extraFrontmatter = ''): Promise<string> {
    const path = resolve(ctx, 'harnesses', 'claude-code.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `---\nharness: claude-code\nversion: 0.3\n${extraFrontmatter}updated: 2026-01-01T00:00:00.000Z\n---\n\n${body}\n`,
      'utf-8',
    );
    return path;
  }

  it('replaces a unique match and preserves the rest of the body byte-for-byte', async () => {
    const path = await seed('## Hooks\n- hook-a\n- hook-b\n\n## Gotchas\n- gotcha-1\n');
    const result = await harness.patchHarness(ctx, 'claude-code', '- hook-b', '- hook-b\n- hook-c');
    expect(result.action).toBe('patched');
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('- hook-a\n- hook-b\n- hook-c\n\n## Gotchas\n- gotcha-1');
  });

  it('preserves frontmatter fields other than version/updated (e.g. answersTo)', async () => {
    const path = await seed('body text', 'answersTo: claude-ai\n');
    await harness.patchHarness(ctx, 'claude-code', 'body text', 'patched text');
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('answersTo: claude-ai');
    expect(raw).toContain('patched text');
  });

  it('bumps the updated timestamp', async () => {
    const path = await seed('body text');
    await harness.patchHarness(ctx, 'claude-code', 'body text', 'new text');
    const raw = await readFile(path, 'utf-8');
    expect(raw).not.toContain('2026-01-01T00:00:00.000Z');
  });

  it('keeps the existing version when no override is given', async () => {
    const path = await seed('body text');
    await harness.patchHarness(ctx, 'claude-code', 'body text', 'new text');
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('version: 0.3');
  });

  it('rejects when find does not match', async () => {
    await seed('## Hooks\n- hook-a\n');
    await expect(harness.patchHarness(ctx, 'claude-code', '- hook-zzz', '- hook-zzz\n- hook-b'))
      .rejects.toThrow(/not found/);
  });

  it('rejects when find matches more than once, leaving the file untouched', async () => {
    const path = await seed('- dup\n- other\n- dup\n');
    await expect(harness.patchHarness(ctx, 'claude-code', '- dup', '- dup\n- extra'))
      .rejects.toThrow(/matches 2 times/);
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('- dup\n- other\n- dup');
    expect(raw).not.toContain('extra');
  });

  it('rejects when no manifest exists yet', async () => {
    await expect(harness.patchHarness(ctx, 'claude-code', 'x', 'y')).rejects.toThrow(/no existing manifest/);
  });

  it('treats replace as a literal string, not a regex replacement pattern', async () => {
    const path = await seed('body text');
    // A naive String.replace(find, replace) call would reinterpret "$&" in
    // the replacement as a regex backreference ("$&" = the matched text).
    await harness.patchHarness(ctx, 'claude-code', 'body text', 'literal $& dollar');
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('literal $& dollar');
  });

  it('is unaffected by a manifest body far larger than the identity() truncation point', async () => {
    const filler = '## Padding\n' + 'x '.repeat(40_000) + '\n\n';
    await seed(`${filler}## Hooks\n- hook-a\n\n## Gotchas\n- done\n`);
    const result = await harness.patchHarness(ctx, 'claude-code', '- hook-a', '- hook-a\n- hook-added');
    expect(result.beforeLength).toBeGreaterThan(61_317); // past the t-1674 cutoff
    const path = resolve(ctx, 'harnesses', 'claude-code.md');
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('- hook-a\n- hook-added');
    expect(raw).toContain('## Gotchas\n- done'); // content after the edit point survived intact
  });
});
