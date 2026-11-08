import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSimilar, formatSimilarResults } from './find-similar.js';
import { remember } from './remember.js';

describe('findSimilar tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-find-similar-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns prose with relevance scores when matches exist', async () => {
    const anchor = await remember(tmpDir, {
      category: 'project',
      title: 'Loom rescue',
      content: 'loom migration plan',
    });
    await remember(tmpDir, {
      category: 'project',
      title: 'Loom adapter',
      content: 'loom integration work',
    });

    const out = await findSimilar(tmpDir, { ref: anchor.ref, limit: 3 });
    expect(out).toContain('Found');
    expect(out).toContain('Loom adapter');
    expect(out).toContain('relevance:');
    expect(out).not.toContain('Loom rescue'); // self excluded
  });

  it('renders an empty-state message when nothing matches', () => {
    const out = formatSimilarResults({ text: 'nothing matches this' }, []);
    expect(out).toMatch(/no similar memories/i);
  });
});
