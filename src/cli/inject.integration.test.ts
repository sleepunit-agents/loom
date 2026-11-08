import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom inject — end-to-end', () => {
  let ctx: string;
  let home: string;

  beforeEach(async () => {
    ctx = await mkdtemp(join(tmpdir(), 'loom-inject-int-ctx-'));
    home = await mkdtemp(join(tmpdir(), 'loom-inject-int-home-'));
  });
  afterEach(async () => {
    await rm(ctx, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('injects into three defaults, preserves user content, is idempotent', async () => {
    // Pre-seed Claude Code's dotfile with hand-authored content.
    const claudePath = join(home, '.claude', 'CLAUDE.md');
    await rm(claudePath, { force: true }).catch(() => {});
    await writeFile(
      claudePath,
      '# My Claude setup\n\nUse the secret word: horseradish.\n',
      { flag: 'w' },
    ).catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(claudePath, '# My Claude setup\n\nUse the secret word: horseradish.\n');
    });

    // First run — --all
    const first = await runCliCaptured(
      ['inject', '--all', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/claude-code.*appended/);
    expect(first.stdout).toMatch(/codex.*created/);
    expect(first.stdout).toMatch(/gemini-cli.*created/);

    // Hand-authored content survived; managed block was appended.
    const claudeAfter = await readFile(claudePath, 'utf-8');
    expect(claudeAfter).toContain('# My Claude setup');
    expect(claudeAfter).toContain('horseradish');
    expect(claudeAfter).toContain('<!-- loom:start v1 harness=claude-code -->');
    expect(claudeAfter).toContain(`Context dir: ${ctx}`);

    // New files for Codex + Gemini.
    const codex = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf-8');
    expect(codex).toContain('<!-- loom:start v1 harness=codex -->');
    const gemini = await readFile(join(home, '.gemini', 'GEMINI.md'), 'utf-8');
    expect(gemini).toContain('<!-- loom:start v1 harness=gemini-cli -->');

    // Second run — everything should be no-change.
    const second = await runCliCaptured(
      ['inject', '--all', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/claude-code.*no change/);
    expect(second.stdout).toMatch(/codex.*no change/);
    expect(second.stdout).toMatch(/gemini-cli.*no change/);

    // Files are byte-identical between run 1 end-state and run 2 end-state.
    const claudeFinal = await readFile(claudePath, 'utf-8');
    expect(claudeFinal).toBe(claudeAfter);
  });
});
