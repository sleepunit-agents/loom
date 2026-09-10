import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadIdentity } from './identity.js';
import { FAILURE_THRESHOLD } from '../backends/recorder-health.js';

describe('loadIdentity', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-identity-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns graceful placeholder when IDENTITY.md is missing (non-default path)', async () => {
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Identity');
    expect(result).toContain('No IDENTITY.md found');
  });

  it('loads IDENTITY.md when present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'I am Art.');
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Identity');
    expect(result).toContain('I am Art.');
    expect(result).not.toContain('No IDENTITY.md found');
  });

  it('loads preferences.md when present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await writeFile(join(tempDir, 'preferences.md'), 'Prefers dark mode');
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Preferences');
    expect(result).toContain('Prefers dark mode');
  });

  it('omits preferences section when file is missing', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Preferences');
  });

  it('loads self-model.md when present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await writeFile(join(tempDir, 'self-model.md'), 'Good at TypeScript');
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Self-Model');
    expect(result).toContain('Good at TypeScript');
  });

  it('omits self-model section when file is missing', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Self-Model');
  });

  it('loads project-specific briefing when project is specified', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await mkdir(join(tempDir, 'projects'), { recursive: true });
    await writeFile(join(tempDir, 'projects', 'vigil.md'), 'Vigil is a daemon');
    const result = await loadIdentity(tempDir, 'vigil');
    expect(result).toContain('# Project: vigil');
    expect(result).toContain('Vigil is a daemon');
  });

  it('omits project section when project file is missing', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir, 'nonexistent');
    expect(result).not.toContain('# Project:');
  });

  it('omits project section when no project is specified', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Project:');
  });

  it('loads memory index when present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await mkdir(join(tempDir, 'memories'), { recursive: true });
    await writeFile(join(tempDir, 'memories', 'INDEX.md'), '# Memory Index\n\n- entry one');
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Memories');
    expect(result).toContain('entry one');
  });

  it('joins sections with --- separator', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await writeFile(join(tempDir, 'preferences.md'), 'Prefs');
    const result = await loadIdentity(tempDir);
    expect(result).toContain('---');
  });

  it('works with a completely empty context directory (non-default path)', async () => {
    const result = await loadIdentity(tempDir);
    // Non-default path → graceful placeholder, not an error
    expect(result).toContain('# Identity');
    expect(result).toBeTruthy();
  });

  it('throws when contextDir equals the default path and IDENTITY.md is missing', async () => {
    // tempDir has no IDENTITY.md; pass tempDir as the default path override
    await expect(
      loadIdentity(tempDir, undefined, undefined, undefined, undefined, tempDir),
    ).rejects.toThrow(/no loom context configured/);
  });

  it('does not throw when contextDir equals the default path but IDENTITY.md exists', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Art\n');
    const result = await loadIdentity(tempDir, undefined, undefined, undefined, undefined, tempDir);
    expect(result).toContain('# Art');
  });

  it('appends client adapter for gemini-cli', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir, undefined, 'gemini-cli');
    expect(result).toContain('Gemini');
    expect(result).toContain('mcp__loom__');
  });

  it('appends client adapter for claude-code', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir, undefined, 'claude-code');
    expect(result).toContain('Claude Code');
    expect(result).toContain('mcp__loom__');
  });

  it('omits runtime section when no client is specified', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('## Runtime:');
  });

  it('silently ignores unknown client names', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir, undefined, 'unknown-runtime');
    expect(result).toContain('# Identity');
    expect(result).not.toContain('## Runtime:');
  });
});

describe('loadIdentity — model manifest', () => {
  let tempDir: string;
  const originalModelEnv = process.env.LOOM_MODEL;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-model-wake-'));
    delete process.env.LOOM_MODEL;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (originalModelEnv === undefined) {
      delete process.env.LOOM_MODEL;
    } else {
      process.env.LOOM_MODEL = originalModelEnv;
    }
  });

  it('omits the "# Model:" section when neither env nor param is set', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Model:');
  });

  it('emits a nudge when LOOM_MODEL is set but no manifest exists', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    process.env.LOOM_MODEL = 'claude-opus';
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Model: claude-opus (manifest missing)');
    expect(result).toContain('model: claude-opus');
    expect(result).toContain('## Capability notes');
  });

  it('emits manifest body when the file is present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await mkdir(join(tempDir, 'models'), { recursive: true });
    await writeFile(
      join(tempDir, 'models', 'claude-opus.md'),
      '---\nmodel: claude-opus\n---\n\n## Capability notes\nStrong tool use.\n',
    );
    process.env.LOOM_MODEL = 'claude-opus';
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Model: claude-opus');
    expect(result).not.toContain('manifest missing');
    expect(result).toContain('Strong tool use');
  });

  it('accepts a model param that overrides LOOM_MODEL', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    process.env.LOOM_MODEL = 'claude-opus';
    const result = await loadIdentity(tempDir, undefined, undefined, 'claude-haiku');
    expect(result).toContain('# Model: claude-haiku (manifest missing)');
    expect(result).not.toContain('# Model: claude-opus');
  });
});

describe('loadIdentity — harness manifest', () => {
  let tempDir: string;
  let savedLoomClient: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-harness-wake-'));
    savedLoomClient = process.env.LOOM_CLIENT;
    delete process.env.LOOM_CLIENT;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (savedLoomClient !== undefined) {
      process.env.LOOM_CLIENT = savedLoomClient;
    } else {
      delete process.env.LOOM_CLIENT;
    }
  });

  it('omits the "# Harness:" section when no client is specified', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Harness:');
  });

  it('emits a self-describe onboarding block when client is set but no manifest exists', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir, undefined, 'mystery-runtime');
    expect(result).toContain('# Harness: mystery-runtime (unknown)');
    expect(result).toContain('harness_describe');
    expect(result).toContain('Describe yourself');
    // The bare "(manifest missing)" placeholder is gone.
    expect(result).not.toContain('manifest missing');
  });

  it('emits the harness manifest body when present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await mkdir(join(tempDir, 'harnesses'), { recursive: true });
    await writeFile(
      join(tempDir, 'harnesses', 'claude-code.md'),
      '---\nharness: claude-code\nversion: 0.4\n---\n\n## Tool prefixes\nmcp__loom__*\n',
    );
    const result = await loadIdentity(tempDir, undefined, 'claude-code');
    expect(result).toContain('# Harness: claude-code');
    expect(result).not.toContain('manifest missing');
    expect(result).toContain('mcp__loom__*');
  });
});


describe('loadIdentity — path-segment validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-identity-pathsafety-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    // A file OUTSIDE the intended subdirectories that traversal would reach
    await writeFile(join(tempDir, 'secret.md'), 'TOP-SECRET-CONTENT');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects a role with path traversal and does not read the target', async () => {
    const result = await loadIdentity(tempDir, undefined, undefined, undefined, '../secret');
    expect(result).toContain('Invalid role');
    expect(result).not.toContain('TOP-SECRET-CONTENT');
  });

  it('rejects a project with path traversal and does not read the target', async () => {
    const result = await loadIdentity(tempDir, '../secret');
    expect(result).toContain('Invalid project');
    expect(result).not.toContain('TOP-SECRET-CONTENT');
  });

  it('rejects a client with path traversal and does not read the target', async () => {
    const result = await loadIdentity(tempDir, undefined, '../../etc/passwd');
    expect(result).toContain('Invalid client');
    expect(result).not.toContain('# Harness:');
  });

  it('rejects a model with path traversal and does not read the target', async () => {
    const result = await loadIdentity(tempDir, undefined, undefined, '../secret');
    expect(result).toContain('Invalid model');
    expect(result).not.toContain('TOP-SECRET-CONTENT');
  });

  it('rejects backslash separators too', async () => {
    const result = await loadIdentity(tempDir, '..\\secret');
    expect(result).toContain('Invalid project');
  });

  it('still loads a legitimate role addendum', async () => {
    await mkdir(join(tempDir, 'roles'), { recursive: true });
    await writeFile(join(tempDir, 'roles', 'wonder.md'), 'Wonder playbook');
    const result = await loadIdentity(tempDir, undefined, undefined, undefined, 'wonder');
    expect(result).toContain('# Mode: wonder');
    expect(result).toContain('Wonder playbook');
  });

  it('still loads a legitimate project brief', async () => {
    await mkdir(join(tempDir, 'projects'), { recursive: true });
    await writeFile(join(tempDir, 'projects', 'loom.md'), 'Loom project brief');
    const result = await loadIdentity(tempDir, 'loom');
    expect(result).toContain('# Project: loom');
    expect(result).toContain('Loom project brief');
  });
});

describe('loadIdentity — recorder health warning (t-562)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-recorder-health-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), 'I am Art.');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('omits the warning block when no health ledger exists', async () => {
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('Recorder Health Warning');
  });

  it('omits the warning block when failures are below the threshold', async () => {
    const health = {
      consecutiveFailures: FAILURE_THRESHOLD - 1,
      failingSince: '2026-09-10T01:00:00.000Z',
      lastError: 'SQLITE_BUSY',
      lastSuccess: null,
    };
    await writeFile(
      join(tempDir, 'recorder-health.json'),
      JSON.stringify(health),
      'utf-8',
    );
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('Recorder Health Warning');
  });

  it('appends the warning block when failures reach the threshold', async () => {
    const health = {
      consecutiveFailures: FAILURE_THRESHOLD,
      failingSince: '2026-09-10T01:00:00.000Z',
      lastError: 'SQLITE_BUSY: database is locked',
      lastSuccess: '2026-09-09T23:00:00.000Z',
    };
    await writeFile(
      join(tempDir, 'recorder-health.json'),
      JSON.stringify(health),
      'utf-8',
    );
    const result = await loadIdentity(tempDir);
    expect(result).toContain('⚠️ Recorder Health Warning');
    expect(result).toContain(`${FAILURE_THRESHOLD} consecutive`);
    expect(result).toContain('2026-09-10T01:00:00.000Z');
    expect(result).toContain('SQLITE_BUSY');
  });

  it('warning is appended after the identity block (placed last in output)', async () => {
    const health = {
      consecutiveFailures: FAILURE_THRESHOLD,
      failingSince: '2026-09-10T01:00:00.000Z',
      lastError: 'disk full',
      lastSuccess: null,
    };
    await writeFile(
      join(tempDir, 'recorder-health.json'),
      JSON.stringify(health),
      'utf-8',
    );
    const result = await loadIdentity(tempDir);
    const identityPos = result.indexOf('I am Art.');
    const warningPos = result.indexOf('Recorder Health Warning');
    expect(identityPos).toBeGreaterThanOrEqual(0);
    expect(warningPos).toBeGreaterThan(identityPos);
  });

  it('still loads identity when health ledger contains malformed JSON', async () => {
    await writeFile(join(tempDir, 'recorder-health.json'), '{not valid json', 'utf-8');
    const result = await loadIdentity(tempDir);
    // Malformed ledger → treated as healthy → no warning
    expect(result).toContain('I am Art.');
    expect(result).not.toContain('Recorder Health Warning');
  });
});
