import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrap } from './bootstrap.js';

describe('bootstrap', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-bootstrap-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const BASE = {
    name: 'Test Agent',
    purpose: 'Run tests reliably',
    voice: 'Direct and concise',
  };

  it('creates IDENTITY.md, preferences.md, and self-model.md', async () => {
    await bootstrap(tempDir, BASE);

    const identity = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');
    const prefs = await readFile(join(tempDir, 'preferences.md'), 'utf-8');
    const selfModel = await readFile(join(tempDir, 'self-model.md'), 'utf-8');

    expect(identity).toContain('# Test Agent');
    expect(identity).toContain('Run tests reliably');
    expect(identity).toContain('Direct and concise');

    expect(prefs).toContain('Test Agent');
    expect(prefs).toContain('No initial preferences set');

    expect(selfModel).toContain('# Self-Model');
    expect(selfModel).toContain('Strengths');
  });

  it('writes the structural scaffold into IDENTITY.md, not just the four answers', async () => {
    await bootstrap(tempDir, BASE);
    const identity = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');

    // The interview answers lead...
    expect(identity.startsWith('# Test Agent')).toBe(true);
    // ...and the scaffold follows. These sections are never asked for.
    expect(identity).toContain('## What you are');
    expect(identity).toContain('## Memory');
    expect(identity).toContain('## Reflection');
    expect(identity).toContain('## Honesty about what you know');
    expect(identity).toContain('## Delegation');
    expect(identity).toContain('the stack');
  });

  it('names the user throughout IDENTITY.md when user is supplied', async () => {
    await bootstrap(tempDir, { ...BASE, user: 'Jonathan' });
    const identity = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');

    expect(identity).toContain('## Working with Jonathan');
    expect(identity).toContain('what Jonathan prefers');
    expect(identity).not.toContain('## Working with the user');
  });

  it('falls back to generic phrasing when no user is supplied', async () => {
    await bootstrap(tempDir, BASE);
    const identity = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');

    expect(identity).toContain('## Working with the user');
    expect(identity).not.toContain('undefined');
  });

  it('seeds preferences.md with the user when supplied', async () => {
    await bootstrap(tempDir, { ...BASE, user: 'Jonathan' });
    const prefs = await readFile(join(tempDir, 'preferences.md'), 'utf-8');

    expect(prefs).toContain('# Test Agent — Preferences');
    expect(prefs).toContain('You work with **Jonathan**');
  });

  it('leaves preferences.md unchanged in shape when no user is supplied', async () => {
    await bootstrap(tempDir, BASE);
    const prefs = await readFile(join(tempDir, 'preferences.md'), 'utf-8');

    expect(prefs).toContain('# Test Agent — Preferences');
    expect(prefs).toContain('No initial preferences set');
    expect(prefs).not.toContain('You work with');
  });

  it('leaves no unfilled placeholder anywhere in the scaffold', async () => {
    await bootstrap(tempDir, { ...BASE, user: 'Jonathan' });
    const identity = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');

    expect(identity).not.toMatch(/<[A-Z_]+>/);
  });

  it('includes seed preferences in preferences.md when provided', async () => {
    await bootstrap(tempDir, { ...BASE, preferences: 'Prefers short answers' });
    const prefs = await readFile(join(tempDir, 'preferences.md'), 'utf-8');
    expect(prefs).toContain('Prefers short answers');
    expect(prefs).not.toContain('No initial preferences set');
  });

  it('returns a success message with file list', async () => {
    const result = await bootstrap(tempDir, BASE);
    expect(result).toContain('Test Agent');
    expect(result).toContain('IDENTITY.md');
    expect(result).toContain('preferences.md');
    expect(result).toContain('self-model.md');
  });

  it('refuses to overwrite existing files without force', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Existing identity');
    const result = await bootstrap(tempDir, BASE);
    expect(result).toContain('already exists');
    expect(result).toContain('IDENTITY.md');
    // Should not have overwritten
    const content = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');
    expect(content).toBe('Existing identity');
  });

  it('overwrites existing files when force is true', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Old identity');
    await bootstrap(tempDir, { ...BASE, force: true });
    const content = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');
    expect(content).toContain('# Test Agent');
    expect(content).not.toContain('Old identity');
  });

  it('includes claude-code setup snippet when requested', async () => {
    const result = await bootstrap(tempDir, { ...BASE, clients: ['claude-code'] });
    expect(result).toContain('Claude Code');
    expect(result).toContain('CLAUDE.md');
    expect(result).toContain('.mcp.json');
  });

  it('includes gemini-cli setup snippet when requested', async () => {
    const result = await bootstrap(tempDir, { ...BASE, clients: ['gemini-cli'] });
    expect(result).toContain('Gemini CLI');
  });

  it('includes setup snippets for multiple clients', async () => {
    const result = await bootstrap(tempDir, { ...BASE, clients: ['claude-code', 'gemini-cli'] });
    expect(result).toContain('Claude Code');
    expect(result).toContain('Gemini');
  });

  it('falls back to a generic snippet for unknown runtimes', async () => {
    const result = await bootstrap(tempDir, { ...BASE, clients: ['custom-runtime'] });
    expect(result).toContain('custom-runtime');
    expect(result).toContain('identity');
  });

  it('hints about available clients when none requested', async () => {
    const result = await bootstrap(tempDir, BASE);
    expect(result).toContain('claude-code');
  });
});

describe('bootstrap — atomic writes and .bak', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-bootstrap-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const BASE = {
    name: 'Test Agent',
    purpose: 'Run tests reliably',
    voice: 'Direct and concise',
  };

  it('creates no .bak files on a first-ever bootstrap', async () => {
    await bootstrap(tempDir, BASE);

    for (const file of ['IDENTITY.md', 'preferences.md', 'self-model.md']) {
      await expect(readFile(join(tempDir, `${file}.bak`), 'utf-8')).rejects.toThrow();
    }
  });

  it('preserves prior identity files as .bak when force-overwriting', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Old creed');
    await writeFile(join(tempDir, 'preferences.md'), 'Old prefs');
    await writeFile(join(tempDir, 'self-model.md'), 'Old self-model');

    await bootstrap(tempDir, { ...BASE, force: true });

    expect(await readFile(join(tempDir, 'IDENTITY.md.bak'), 'utf-8')).toBe('Old creed');
    expect(await readFile(join(tempDir, 'preferences.md.bak'), 'utf-8')).toBe('Old prefs');
    expect(await readFile(join(tempDir, 'self-model.md.bak'), 'utf-8')).toBe('Old self-model');

    // New content actually landed
    expect(await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8')).toContain('# Test Agent');
  });

  it('only backs up files that existed before the force overwrite', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Old creed');

    await bootstrap(tempDir, { ...BASE, force: true });

    expect(await readFile(join(tempDir, 'IDENTITY.md.bak'), 'utf-8')).toBe('Old creed');
    await expect(readFile(join(tempDir, 'preferences.md.bak'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tempDir, 'self-model.md.bak'), 'utf-8')).rejects.toThrow();
  });
});
