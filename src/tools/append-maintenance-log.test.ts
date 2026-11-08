import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendMaintenanceLog,
  formatEntry,
  FILE_HEADER,
  type MaintenanceLogEntry,
} from './append-maintenance-log.js';

const TS = new Date('2026-05-30T12:00:00Z');

const TIER2: MaintenanceLogEntry = {
  type: 'tier-2',
  timestamp: TS,
  tier2: {
    memoriesAudited: 47,
    staleCount: 3,
    duplicateCount: 2,
    expiredCount: 0,
    mergeCount: 1,
    contradictions: 0,
    pruned: 1,
    notes: 'Near-duplicates in "reference" category flagged for review.',
  },
};

const TIER3: MaintenanceLogEntry = {
  type: 'tier-3',
  timestamp: new Date('2026-06-30T12:00:00Z'),
  tier3: {
    preferencesUpdated: ['communication-style', 'scope-and-access'],
    selfModelUpdated: ['strengths'],
    identityChanged: false,
    projectBriefsAccessed: 8,
    projectBriefsStale: 1,
    harnessManifests: '4/4 present and current',
  },
};

describe('formatEntry', () => {
  it('formats a Tier 2 entry with a dated header and operation counts', () => {
    const out = formatEntry(TIER2);
    expect(out).toContain('## [2026-05-30] Weekly Consolidation (Tier 2)');
    expect(out).toContain('- **Memories audited:** 47 (3 stale, 2 duplicates, 0 expired)');
    expect(out).toContain('  - Merges: 1');
    expect(out).toContain('  - Contradictions: 0');
    expect(out).toContain('  - Pruned: 1');
    expect(out).toContain('- **Notes:** Near-duplicates');
    expect(out).toContain('- **Run:** Art-Consolidate autopilot'); // default runName
  });

  it('formats a Tier 3 entry with manifest + project-brief sections', () => {
    const out = formatEntry(TIER3);
    expect(out).toContain('## [2026-06-30] Monthly Identity Review (Tier 3)');
    expect(out).toContain('  - preferences.md: 2 section(s) updated (communication-style, scope-and-access)');
    expect(out).toContain('  - self-model.md: 1 section(s) updated (strengths)');
    expect(out).toContain('  - IDENTITY.md: No changes');
    expect(out).toContain('- **Project briefs:** 8 accessed, 1 stale');
    expect(out).toContain('- **Harness manifests:** 4/4 present and current');
    expect(out).toContain('- **Run:** Art-Identity-Review routine'); // default runName
  });

  it('renders "No changes" when a Tier 3 manifest list is empty/omitted', () => {
    const out = formatEntry({
      type: 'tier-3',
      timestamp: TS,
      tier3: { identityChanged: true, projectBriefsAccessed: 0, projectBriefsStale: 0 },
    });
    expect(out).toContain('  - preferences.md: No changes');
    expect(out).toContain('  - self-model.md: No changes');
    expect(out).toContain('  - IDENTITY.md: Changes made');
  });

  it('omits the Notes line when no notes are provided', () => {
    const out = formatEntry({ ...TIER2, tier2: { ...TIER2.tier2!, notes: undefined } });
    expect(out).not.toContain('**Notes:**');
  });

  it('honours an explicit runName override', () => {
    const out = formatEntry({ ...TIER2, tier2: { ...TIER2.tier2!, runName: 'manual run' } });
    expect(out).toContain('- **Run:** manual run');
  });

  it('uses a UTC ISO date (YYYY-MM-DD) for the header', () => {
    const out = formatEntry({ ...TIER2, timestamp: new Date('2026-01-02T23:30:00Z') });
    expect(out).toContain('## [2026-01-02]');
  });
});

describe('appendMaintenanceLog', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-maint-log-test-'));
    logPath = join(dir, 'docs', 'memory-maintenance-log.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the file (and parent dirs) with a header on first write', async () => {
    const res = await appendMaintenanceLog(TIER2, logPath);
    expect(res).toEqual({ success: true, filePath: logPath, timestamp: '2026-05-30' });

    const content = await readFile(logPath, 'utf-8');
    expect(content.startsWith('# Memory Maintenance Log')).toBe(true);
    expect(content).toContain('## [2026-05-30] Weekly Consolidation (Tier 2)');
  });

  it('appends later entries below earlier ones, preserving prior content', async () => {
    await appendMaintenanceLog(TIER2, logPath);
    await appendMaintenanceLog(TIER3, logPath);

    const content = await readFile(logPath, 'utf-8');
    const t2 = content.indexOf('Weekly Consolidation (Tier 2)');
    const t3 = content.indexOf('Monthly Identity Review (Tier 3)');
    expect(t2).toBeGreaterThan(-1);
    expect(t3).toBeGreaterThan(t2); // chronological order preserved
  });

  it('separates each entry with exactly one --- break (no doubled rules after the header)', async () => {
    await appendMaintenanceLog(TIER2, logPath);
    await appendMaintenanceLog(TIER3, logPath);

    const content = await readFile(logPath, 'utf-8');
    // One break before each of the two entries.
    const breaks = content.match(/^---$/gm) ?? [];
    expect(breaks).toHaveLength(2);
    expect(content).not.toContain('---\n\n---'); // no empty section from a doubled rule
  });

  it('writes the header only once across multiple appends', async () => {
    await appendMaintenanceLog(TIER2, logPath);
    await appendMaintenanceLog(TIER3, logPath);

    const content = await readFile(logPath, 'utf-8');
    const headers = content.match(/^# Memory Maintenance Log$/gm) ?? [];
    expect(headers).toHaveLength(1);
  });

  it('exposes the header constant used on first write', async () => {
    await appendMaintenanceLog(TIER2, logPath);
    const content = await readFile(logPath, 'utf-8');
    expect(content.startsWith(FILE_HEADER.replace(/\s*$/, ''))).toBe(true);
  });
});
