import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

describe('loom update', () => {
  let tempDir: string;
  let ref: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-update-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
    const res = await remember(tempDir, { category: 'reference', title: 't', content: 'old' });
    ref = res.ref;
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('updates body via stdin', async () => {
    const { stdout, code } = await runCliCaptured(
      ['update', ref, '--context-dir', tempDir],
      { stdin: 'new body' },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/updated/i);
  });

  it('emits UpdateResult on --json', async () => {
    const { stdout, code } = await runCliCaptured(
      ['update', ref, '--context-dir', tempDir, '--json'],
      { stdin: 'new body' },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.updated).toBe(true);
    expect(parsed.ref).toBe(ref);
  });

  it('returns exit 3 when ref not found', async () => {
    const { code } = await runCliCaptured(
      ['update', 'nope/missing.md', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(3);
  });

  it('returns exit 2 when no ref given', async () => {
    const { code } = await runCliCaptured(
      ['update', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(2);
  });

  it('updates via --category + --title identifier', async () => {
    const { stdout, code } = await runCliCaptured(
      ['update', '--category', 'reference', '--title', 't', '--context-dir', tempDir, '--json'],
      { stdin: 'new body' },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.updated).toBe(true);
  });
});
