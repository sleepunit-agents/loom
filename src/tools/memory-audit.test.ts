import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryAudit, formatAuditReport } from './memory-audit.js';
import { remember } from './remember.js';

describe('memoryAudit tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-audit-tool-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders totals, category breakdown, and duplicate pairs', async () => {
    await remember(tmpDir, {
      category: 'project',
      title: 'A',
      content: 'loom loom loom',
    });
    await remember(tmpDir, {
      category: 'project',
      title: 'B',
      content: 'loom loom loom',
    });

    const out = await memoryAudit(tmpDir, { similarityThreshold: 0.5 });
    expect(out).toContain('# Memory audit');
    expect(out).toContain('Total memories:** 2');
    expect(out).toContain('project: 2');
    expect(out).toMatch(/Near-duplicate pairs:\*\*\s*1/);
  });

  it('formats stale entries with last-touch date', () => {
    const out = formatAuditReport({
      totalMemories: 1,
      byCategory: { project: 1 },
      stale: [
        {
          ref: 'project/old-thing',
          title: 'Old thing',
          category: 'project',
          lastTouch: '2025-01-01T00:00:00.000Z',
        },
      ],
      duplicates: [],
      expired: [],
    });
    expect(out).toContain('project/old-thing');
    expect(out).toContain('Old thing');
    expect(out).toContain('2025-01-01');
  });
});
