import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom update-identity', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-upd-ident-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
    await writeFile(join(tempDir, 'preferences.md'),
      '## Working Style\n\nOld text.\n\n## Tools\n\nOld tools.\n');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('lists sections when only file is given', async () => {
    const { stdout, code } = await runCliCaptured(
      ['update-identity', 'preferences', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/Working Style/);
    expect(stdout).toMatch(/Tools/);
  });

  it('replaces section body with stdin content', async () => {
    const { code } = await runCliCaptured(
      ['update-identity', 'preferences', 'Working Style', '--context-dir', tempDir],
      { stdin: 'New working style text.' },
    );
    expect(code).toBe(0);
    const updated = await readFile(join(tempDir, 'preferences.md'), 'utf-8');
    expect(updated).toMatch(/New working style text/);
    expect(updated).not.toMatch(/Old text/);
  });

  it('appends a new section with --append', async () => {
    const { code } = await runCliCaptured(
      ['update-identity', 'preferences', 'Brand New', '--append', '--context-dir', tempDir],
      { stdin: 'Fresh content.' },
    );
    expect(code).toBe(0);
    const updated = await readFile(join(tempDir, 'preferences.md'), 'utf-8');
    expect(updated).toMatch(/## Brand New/);
    expect(updated).toMatch(/Fresh content/);
  });

  it('refuses IDENTITY.md as a file argument', async () => {
    const { stderr, code } = await runCliCaptured(
      ['update-identity', 'IDENTITY', 'Any', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/preferences|self-model|Unknown/i);
  });

  it('missing file arg → exit 2', async () => {
    const { code } = await runCliCaptured(
      ['update-identity', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(2);
  });
});
