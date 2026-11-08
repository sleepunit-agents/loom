import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom wake', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-wake-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Test creed');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('prints identity markdown to stdout and exits 0', async () => {
    const { stdout, code } = await runCliCaptured(
      ['wake', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/# Test creed/);
  });

  it('reads LOOM_CONTEXT_DIR from env when flag omitted', async () => {
    const { stdout, code } = await runCliCaptured(
      ['wake'],
      { env: { LOOM_CONTEXT_DIR: tempDir } },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/# Test creed/);
  });

  it('flag wins over env', async () => {
    const other = await mkdtemp(join(tmpdir(), 'loom-cli-wake-other-'));
    await writeFile(join(other, 'IDENTITY.md'), '# Other creed');
    try {
      const { stdout } = await runCliCaptured(
        ['wake', '--context-dir', other],
        { env: { LOOM_CONTEXT_DIR: tempDir } },
      );
      expect(stdout).toMatch(/# Other creed/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('forwards --project to loadIdentity', async () => {
    await mkdir(join(tempDir, 'projects'), { recursive: true });
    await writeFile(join(tempDir, 'projects', 'widget.md'), 'Widget brief');
    const { stdout } = await runCliCaptured(
      ['wake', '--context-dir', tempDir, '--project', 'widget'],
    );
    expect(stdout).toMatch(/Widget brief/);
  });

  it('prints wake usage with --help and exits 0', async () => {
    const { stdout, stderr, code } = await runCliCaptured(['wake', '--help']);
    expect(code).toBe(0);
    expect(stdout + stderr).toMatch(/loom wake/);
  });

  it('exits 2 on unknown flag with usage on stderr', async () => {
    const { code, stderr } = await runCliCaptured(['wake', '--bogus', '--context-dir', tempDir]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/loom wake/);
  });

  it('exits 1 when stack is ahead of this build', async () => {
    const { CURRENT_STACK_VERSION, STACK_VERSION_FILE } = await import('../config.js');
    await writeFile(join(tempDir, STACK_VERSION_FILE), `${CURRENT_STACK_VERSION + 1}\n`);
    const { code, stderr } = await runCliCaptured(['wake', '--context-dir', tempDir]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Upgrade loom/);
  });
});
