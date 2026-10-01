import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryMerge } from './memory-merge.js';
import { memoryAudit } from './memory-audit.js';
import { remember } from './remember.js';
import { createBackend } from '../backends/index.js';

describe('memoryMerge tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-merge-tool-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('consolidates an audit duplicate-finding into one surviving row', async () => {
    const a = await remember(tmpDir, {
      category: 'project',
      title: 'Audit target A',
      content: 'loom loom loom',
    });
    const b = await remember(tmpDir, {
      category: 'project',
      title: 'Audit target B',
      content: 'loom loom loom',
    });

    // Find the duplicate pair the way a tending pass would.
    const report = await createBackend(tmpDir).audit({ similarityThreshold: 0.5 });
    expect(report.duplicates.length).toBeGreaterThanOrEqual(1);
    const pair = report.duplicates[0];
    expect([pair.a.ref, pair.b.ref].sort()).toEqual([a.ref, b.ref].sort());

    const out = await memoryMerge(tmpDir, {
      source_refs: [pair.b.ref],
      target_ref: pair.a.ref,
      note: 'tending consolidation',
    });

    expect(out).toContain(`Merged 1 memory(ies) into \`${pair.a.ref}\``);
    expect(out).toContain(pair.b.ref);

    const backend = createBackend(tmpDir);
    try {
      const reportAfter = await backend.audit({ similarityThreshold: 0.5 });
      expect(reportAfter.duplicates).toHaveLength(0);
      expect(reportAfter.totalMemories).toBe(1);
    } finally {
      backend.close();
    }
  }, 20_000);

  it('returns an Error string for an empty source_refs list', async () => {
    const out = await memoryMerge(tmpDir, { source_refs: [], target_ref: 'project/whatever' });
    expect(out).toMatch(/^Error: source_refs must not be empty\.$/);
  });

  it('returns an Error string when the target does not exist', async () => {
    const { ref } = await remember(tmpDir, { category: 'project', title: 'Only one', content: 'x' });
    const out = await memoryMerge(tmpDir, {
      source_refs: [ref],
      target_ref: 'project/does-not-exist-00000000',
    });
    expect(out).toMatch(/^Error: .*target_ref not found/);
  }, 20_000);
});
