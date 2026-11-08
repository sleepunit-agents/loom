import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

describe('loom recall', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-recall-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
    await remember(tempDir, {
      category: 'reference',
      title: 'blue widget',
      content: 'Specs for the blue widget prototype',
    });
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('prints matches in human format when found', async () => {
    const { stdout, code } = await runCliCaptured(
      ['recall', 'blue widget', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/blue widget/);
  });

  it('emits MemoryMatch[] when --json is set', async () => {
    const { stdout, code } = await runCliCaptured(
      ['recall', 'blue widget', '--context-dir', tempDir, '--json'],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('title', 'blue widget');
  });

  it('returns exit 2 when query is missing', async () => {
    const { stderr, code } = await runCliCaptured(
      ['recall', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/query/i);
  });

  it('respects --category filter', async () => {
    const { stdout } = await runCliCaptured(
      ['recall', 'blue widget', '--context-dir', tempDir, '--category', 'reference', '--json'],
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.every((m: { category: string }) => m.category === 'reference')).toBe(true);
  });

  it.each(['abc', '-0.1', '1.5'])('exits 2 when --diversity is %s', async (bad) => {
    const { stderr, code } = await runCliCaptured(
      ['recall', 'q', '--context-dir', tempDir, `--diversity=${bad}`],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/between 0 and 1/);
  });

  it('accepts --diversity 0 and 1', async () => {
    for (const d of ['0', '1']) {
      const { stdout, code } = await runCliCaptured(
        ['recall', 'blue widget', '--context-dir', tempDir, '--diversity', d, '--json'],
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout)[0]).toHaveProperty('title', 'blue widget');
    }
  });

  it('appends an observation to telemetry/recall.jsonl', async () => {
    const { readFileSync } = await import('node:fs');
    await runCliCaptured(['recall', 'blue widget', '--context-dir', tempDir]);
    const lines = readFileSync(join(tempDir, 'telemetry', 'recall.jsonl'), 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last).toMatchObject({ tool: 'recall', query: 'blue widget', hit: true, returned: 1 });
  });

  it.each(['abc', '0', '-1'])('exits 2 when --limit is %s', async (bad) => {
    const { stderr, code } = await runCliCaptured(
      ['recall', 'q', '--context-dir', tempDir, `--limit=${bad}`],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/positive integer/);
  });
});
