import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom harness init', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-harness-cli-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('writes harnesses/<name>.md with the template body', async () => {
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', 'claude-code', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/claude-code.*created/);
    const body = await readFile(resolve(ctx, 'harnesses', 'claude-code.md'), 'utf-8');
    expect(body).toContain('harness: claude-code');
  });

  it('infers name from --client when no positional is given', async () => {
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', '--client', 'codex', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/codex.*created/);
    await readFile(resolve(ctx, 'harnesses', 'codex.md'), 'utf-8');
  });

  it('infers name from $LOOM_CLIENT when neither positional nor --client', async () => {
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', '--context-dir', ctx],
      { env: { LOOM_CLIENT: 'gemini-cli' } },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/gemini-cli.*created/);
  });

  it('exits 2 when no name can be resolved', async () => {
    const { code, stderr } = await runCliCaptured(
      ['harness', 'init', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/name|--client|LOOM_CLIENT/);
  });

  it('skips-exists on re-run without --force', async () => {
    await runCliCaptured(['harness', 'init', 'codex', '--context-dir', ctx]);
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', 'codex', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/codex.*skipped-exists/);
  });

  it('--force overwrites', async () => {
    await mkdir(resolve(ctx, 'harnesses'), { recursive: true });
    const path = resolve(ctx, 'harnesses', 'codex.md');
    await writeFile(path, '# custom\n', 'utf-8');
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', 'codex', '--force', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/codex.*overwritten/);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('harness: codex');
  });

  it('--json emits an InitResult', async () => {
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', 'codex', '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      name: 'codex',
      action: 'created',
      path: expect.any(String),
    });
  });

  it('exits 2 for a name with path separators', async () => {
    const { code, stderr } = await runCliCaptured(
      ['harness', 'init', 'foo/bar', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/name/);
  });
});
