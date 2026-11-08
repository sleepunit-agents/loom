import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

describe('loom forget', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-forget-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('forgets by ref', async () => {
    const ref = await remember(tempDir, { category: 'reference', title: 't1', content: 'c' });
    const { stdout, code } = await runCliCaptured(
      ['forget', ref.ref, '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/forgotten/i);
  });

  it('emits ForgetResult on --json', async () => {
    const ref = await remember(tempDir, { category: 'reference', title: 't2', content: 'c' });
    const { stdout, code } = await runCliCaptured(
      ['forget', ref.ref, '--context-dir', tempDir, '--json'],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.deleted).toEqual([ref.ref]);
  });

  it('refuses title-pattern without a scope guard (exit 2)', async () => {
    const { stderr, code } = await runCliCaptured(
      ['forget', '--title-pattern', 'foo*', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/scope|category|project/i);
  });

  it('title-pattern with --category previews without --confirm (exit 2, deletes nothing)', async () => {
    await remember(tempDir, { category: 'reference', title: 'sweepA', content: 'a' });
    await remember(tempDir, { category: 'reference', title: 'sweepB', content: 'b' });
    const { stdout, code } = await runCliCaptured(
      ['forget', '--title-pattern', 'sweep*', '--category', 'reference', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stdout).toMatch(/confirm/i);
    expect(stdout).toMatch(/sweepA/);
  });

  it('title-pattern with --category and --confirm deletes', async () => {
    await remember(tempDir, { category: 'reference', title: 'sweepA', content: 'a' });
    await remember(tempDir, { category: 'reference', title: 'sweepB', content: 'b' });
    const { stdout, code } = await runCliCaptured(
      ['forget', '--title-pattern', 'sweep*', '--category', 'reference', '--confirm', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/2/);
  });

  it('--json scope deletion without --confirm is gated too (no bypass)', async () => {
    await remember(tempDir, { category: 'reference', title: 'sweepA', content: 'a' });
    const { stdout, code } = await runCliCaptured(
      ['forget', '--category', 'reference', '--json', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout);
    expect(parsed.confirmRequired).toBe(true);
    expect(parsed.deleted).toEqual([]);
  });

  it('exits 3 when ref not found', async () => {
    const { code } = await runCliCaptured(
      ['forget', 'nonexistent/nope.md', '--context-dir', tempDir],
    );
    expect(code).toBe(3);
  });
});
