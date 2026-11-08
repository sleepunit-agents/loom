import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as model from './model.js';

describe('blocks/model', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-model-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('read', () => {
    it('returns null when models/ directory does not exist', async () => {
      expect(await model.read(dir, 'claude-opus')).toBeNull();
    });

    it('returns null when the specific manifest is missing', async () => {
      await mkdir(join(dir, 'models'), { recursive: true });
      expect(await model.read(dir, 'claude-opus')).toBeNull();
    });

    it('rejects keys with path traversal', async () => {
      await writeFile(join(dir, 'secret.md'), 'TOP-SECRET');
      await expect(model.read(dir, '../secret')).rejects.toThrow(/model name/);
      await expect(model.read(dir, '..\\secret')).rejects.toThrow(/model name/);
      await expect(model.read(dir, '..')).rejects.toThrow(/model name/);
      await expect(model.read(dir, '')).rejects.toThrow(/model name/);
    });

    it('returns null when the manifest file is empty', async () => {
      await mkdir(join(dir, 'models'), { recursive: true });
      await writeFile(join(dir, 'models', 'claude-opus.md'), '');
      expect(await model.read(dir, 'claude-opus')).toBeNull();
    });

    it('returns a Block with parsed frontmatter and trimmed body', async () => {
      await mkdir(join(dir, 'models'), { recursive: true });
      await writeFile(
        join(dir, 'models', 'claude-opus.md'),
        '---\nmodel: claude-opus\nfamily: claude\n---\n\n## Capability notes\nStrong tool use.\n',
      );
      const block = await model.read(dir, 'claude-opus');
      expect(block?.key).toBe('claude-opus');
      expect(block?.frontmatter).toEqual({ model: 'claude-opus', family: 'claude' });
      expect(block?.body).toContain('## Capability notes');
    });
  });

  describe('list', () => {
    it('returns [] when models/ is missing', async () => {
      expect(await model.list(dir)).toEqual([]);
    });

    it('returns sorted keys for present manifests', async () => {
      await mkdir(join(dir, 'models'), { recursive: true });
      await writeFile(join(dir, 'models', 'gemma4.md'), '# gemma4');
      await writeFile(join(dir, 'models', 'claude-opus.md'), '# opus');
      expect(await model.list(dir)).toEqual(['claude-opus', 'gemma4']);
    });
  });

  describe('template', () => {
    it('returns a template containing the supplied key', () => {
      const tpl = model.template('claude-opus');
      expect(tpl).toContain('model: claude-opus');
      expect(tpl).toContain('## Capability notes');
      expect(tpl).toContain('## Workarounds');
      expect(tpl).toContain('## When to use');
      expect(tpl).toContain('## When not to use');
    });
  });
});
