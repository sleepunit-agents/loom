import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDossier } from './dossier.js';

describe('loadDossier', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-dossier-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('always includes the preamble with push-back mandate', async () => {
    const result = await loadDossier(tempDir);
    expect(result).toContain('Worker Dossier');
    expect(result).toContain('not Art');
    expect(result).toContain('Push-back mandate');
  });

  it('does NOT include IDENTITY.md content', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'TOP SECRET CREED');
    const result = await loadDossier(tempDir);
    expect(result).not.toContain('TOP SECRET CREED');
  });

  it('includes preferences.md under Art\'s Standards header', async () => {
    await writeFile(join(tempDir, 'preferences.md'), 'Art prefers directness.');
    const result = await loadDossier(tempDir);
    expect(result).toContain("Art's Standards");
    expect(result).toContain('Art prefers directness.');
  });

  it('omits standards section when preferences.md is missing', async () => {
    const result = await loadDossier(tempDir);
    expect(result).not.toContain("Art's Standards");
  });

  it('includes self-model.md under Art\'s Capabilities header', async () => {
    await writeFile(join(tempDir, 'self-model.md'), 'Strong at TypeScript.');
    const result = await loadDossier(tempDir);
    expect(result).toContain("Art's Capabilities");
    expect(result).toContain('Strong at TypeScript.');
  });

  it('omits capabilities section when self-model.md is missing', async () => {
    const result = await loadDossier(tempDir);
    expect(result).not.toContain("Art's Capabilities");
  });

  it('loads project-specific context when project is specified', async () => {
    await mkdir(join(tempDir, 'projects'), { recursive: true });
    await writeFile(join(tempDir, 'projects', 'loom.md'), 'loom is the identity layer.');
    const result = await loadDossier(tempDir, 'loom');
    expect(result).toContain('# Project: loom');
    expect(result).toContain('loom is the identity layer.');
  });

  it('omits project section when project file is missing', async () => {
    const result = await loadDossier(tempDir, 'nonexistent');
    expect(result).not.toContain('# Project:');
  });

  it('omits project section when no project is specified', async () => {
    const result = await loadDossier(tempDir);
    expect(result).not.toContain('# Project:');
  });

  it('joins sections with --- separator', async () => {
    await writeFile(join(tempDir, 'preferences.md'), 'Prefs');
    const result = await loadDossier(tempDir);
    expect(result).toContain('---');
  });

  it('appends client adapter for claude-code', async () => {
    const result = await loadDossier(tempDir, undefined, 'claude-code');
    expect(result).toContain('mcp__loom__');
  });

  it('appends client adapter for gemini-cli', async () => {
    const result = await loadDossier(tempDir, undefined, 'gemini-cli');
    expect(result).toContain('`mcp_loom_identity`');
  });

  it('silently ignores unknown client names', async () => {
    const result = await loadDossier(tempDir, undefined, 'unknown-runtime');
    expect(result).toContain('Worker Dossier');
    // No crash, no phantom runtime section
    expect(result).not.toContain('# Harness: unknown-runtime');
  });

  it('includes harness manifest when present', async () => {
    await mkdir(join(tempDir, 'harnesses'), { recursive: true });
    await writeFile(
      join(tempDir, 'harnesses', 'claude-code.md'),
      '---\nharness: claude-code\n---\n\n## Tool prefixes\nmcp__loom__*\n',
    );
    const result = await loadDossier(tempDir, undefined, 'claude-code');
    expect(result).toContain('# Harness: claude-code');
    expect(result).toContain('mcp__loom__*');
  });

  it('omits harness section when no client is specified', async () => {
    const result = await loadDossier(tempDir);
    expect(result).not.toContain('# Harness:');
  });

  it('includes model manifest when present', async () => {
    await mkdir(join(tempDir, 'models'), { recursive: true });
    await writeFile(
      join(tempDir, 'models', 'claude-opus.md'),
      '---\nmodel: claude-opus\n---\n\n## Capability notes\nStrong tool use.\n',
    );
    const result = await loadDossier(tempDir, undefined, undefined, 'claude-opus');
    expect(result).toContain('# Model: claude-opus');
    expect(result).toContain('Strong tool use.');
  });

  it('omits model section when no model is specified', async () => {
    const result = await loadDossier(tempDir);
    expect(result).not.toContain('# Model:');
  });

  it('works with a completely empty context directory', async () => {
    const result = await loadDossier(tempDir);
    expect(result).toContain('Worker Dossier');
    expect(result).toContain('Push-back mandate');
    expect(result).toBeTruthy();
  });
});

describe('loadDossier — path-segment validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-dossier-pathsafety-'));
    // A file OUTSIDE the intended subdirectories that traversal would reach
    await writeFile(join(tempDir, 'secret.md'), 'TOP-SECRET-CONTENT');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects a role with path traversal and does not read the target', async () => {
    const result = await loadDossier(tempDir, undefined, undefined, undefined, '../secret');
    expect(result).toContain('Invalid role');
    expect(result).not.toContain('TOP-SECRET-CONTENT');
  });

  it('rejects a project with path traversal and does not read the target', async () => {
    const result = await loadDossier(tempDir, '../secret');
    expect(result).toContain('Invalid project');
    expect(result).not.toContain('TOP-SECRET-CONTENT');
  });

  it('rejects a client with path traversal', async () => {
    const result = await loadDossier(tempDir, undefined, '../../etc/passwd');
    expect(result).toContain('Invalid client');
  });

  it('rejects a model with path traversal and does not read the target', async () => {
    const result = await loadDossier(tempDir, undefined, undefined, '../secret');
    expect(result).toContain('Invalid model');
    expect(result).not.toContain('TOP-SECRET-CONTENT');
  });

  it('still loads a legitimate role brief', async () => {
    await mkdir(join(tempDir, 'roles'), { recursive: true });
    await writeFile(join(tempDir, 'roles', 'code.md'), 'Code worker brief');
    const result = await loadDossier(tempDir, undefined, undefined, undefined, 'code');
    expect(result).toContain('# Your Role: code');
    expect(result).toContain('Code worker brief');
  });
});
