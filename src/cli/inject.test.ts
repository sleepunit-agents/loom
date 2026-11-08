import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom inject (flag-driven)', () => {
  let ctx: string;
  let home: string;

  beforeEach(async () => {
    ctx = await mkdtemp(join(tmpdir(), 'loom-inject-ctx-'));
    home = await mkdtemp(join(tmpdir(), 'loom-inject-home-'));
  });
  afterEach(async () => {
    await rm(ctx, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('prints usage with --help and exits 0', async () => {
    const { stdout, stderr, code } = await runCliCaptured(['inject', '--help']);
    expect(code).toBe(0);
    expect(stdout + stderr).toMatch(/loom inject/);
  });

  it('writes a single harness with --harness and --to', async () => {
    const target = join(home, 'CLAUDE.md');
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/created/);
    const written = await readFile(target, 'utf-8');
    expect(written).toContain('<!-- loom:start v1 harness=claude-code -->');
    expect(written).toContain('<!-- loom:end -->');
    expect(written).toContain('mcp__loom__identity');
    expect(written).toContain(`Context dir: ${ctx}`);
  });

  it('writes the subset requested by --harness <a,b>', async () => {
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code,gemini-cli', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/claude-code/);
    expect(stdout).toMatch(/gemini-cli/);
    expect(stdout).not.toMatch(/codex/);
    const claudeText = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeText).toContain('harness=claude-code');
    const geminiText = await readFile(join(home, '.gemini', 'GEMINI.md'), 'utf-8');
    expect(geminiText).toContain('harness=gemini-cli');
  });

  it('--all writes all three defaults', async () => {
    const { code } = await runCliCaptured(
      ['inject', '--all', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect((await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf-8'))).toContain('harness=claude-code');
    expect((await readFile(join(home, '.codex', 'AGENTS.md'), 'utf-8'))).toContain('harness=codex');
    expect((await readFile(join(home, '.gemini', 'GEMINI.md'), 'utf-8'))).toContain('harness=gemini-cli');
  });

  it('--dry-run writes nothing and prints a diff', async () => {
    const target = join(home, 'CLAUDE.md');
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--dry-run', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/^--- /m);
    expect(stdout).toMatch(/^\+\+\+ /m);
    await expect(readFile(target, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('--json emits a WriteResult[] to stdout', async () => {
    const target = join(home, 'CLAUDE.md');
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      harness: 'claude-code',
      action: 'created',
      path: target,
    });
    expect(typeof parsed[0].bytesWritten).toBe('number');
  });

  it('--dry-run + --json emits predicted action with diff field', async () => {
    const target = join(home, 'CLAUDE.md');
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--dry-run', '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed[0]).toMatchObject({ harness: 'claude-code', action: 'created', path: target });
    expect(typeof parsed[0].diff).toBe('string');
    expect(parsed[0].diff).toMatch(/---/);
    await expect(readFile(target, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('idempotent: second --all run reports no-change everywhere', async () => {
    await runCliCaptured(['inject', '--all', '--context-dir', ctx], { env: { HOME: home } });
    const { stdout, code } = await runCliCaptured(
      ['inject', '--all', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect((stdout.match(/no change/g) ?? []).length).toBe(3);
  });

  it('exits 2 on unknown --harness', async () => {
    const { code, stderr } = await runCliCaptured(
      ['inject', '--harness', 'nope', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown harness/i);
  });

  it('exits 2 when --harness and --all both set', async () => {
    const { code, stderr } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--all', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/mutually exclusive/i);
  });

  it('exits 2 when --to is set with more than one harness', async () => {
    const { code, stderr } = await runCliCaptured(
      ['inject', '--all', '--to', '/tmp/x.md', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--to.*single/i);
  });

  it('exits 2 on non-TTY stdin with no flags', async () => {
    const { code, stderr } = await runCliCaptured(
      ['inject', '--context-dir', ctx],
      { stdin: '' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--harness or --all required/);
  });

  it('exits 1 when a target file has malformed markers', async () => {
    const target = join(home, 'CLAUDE.md');
    await writeFile(target, '<!-- loom:start v1 -->\n(no end)\n', 'utf-8');
    const { code, stderr } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--context-dir', ctx],
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/malformed loom markers/);
  });

  it('exits 1 when stack is ahead of this build', async () => {
    const { CURRENT_STACK_VERSION, STACK_VERSION_FILE } = await import('../config.js');
    await writeFile(join(ctx, STACK_VERSION_FILE), `${CURRENT_STACK_VERSION + 1}\n`);
    const target = join(home, 'CLAUDE.md');
    const { code, stderr } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--context-dir', ctx],
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/Upgrade loom/);
  });

  it('--dry-run diff on an existing-with-block target shows only the changed region', async () => {
    const target = join(home, 'CLAUDE.md');
    // Seed with the claude-code block rendered against a DIFFERENT context dir
    const { HARNESSES } = await import('../injection/harnesses.js');
    const { renderBlock } = await import('../injection/render.js');
    const stale = renderBlock(HARNESSES['claude-code'], '/old/ctx/path');
    await writeFile(target, `# Header\n\n${stale}\n# Footer\n`, 'utf-8');

    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--dry-run', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toContain('-Context dir: /old/ctx/path');
    expect(stdout).toContain(`+Context dir: ${ctx}`);
    expect(stdout).not.toMatch(/^-# Header$/m);
    expect(stdout).not.toMatch(/^\+# Header$/m);
  });

  it('--dry-run normalizes CRLF input so the diff does not treat every line as changed', async () => {
    const target = join(home, 'CLAUDE.md');
    const { HARNESSES } = await import('../injection/harnesses.js');
    const { renderBlock } = await import('../injection/render.js');
    const stale = renderBlock(HARNESSES['claude-code'], '/old/ctx').replace(/\n/g, '\r\n');
    await writeFile(target, `# Header\r\n\r\n${stale}\r\n# Footer\r\n`, 'utf-8');

    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--dry-run', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    // Header/footer must appear as unchanged context, not as -+ pairs
    expect(stdout).not.toMatch(/^-# Header$/m);
    expect(stdout).not.toMatch(/^\+# Header$/m);
  });

  it('wizard confirms default selection on TTY and writes files', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('./tui/multi-select.js', async () => {
      const actual = await vi.importActual<typeof import('./tui/multi-select.js')>('./tui/multi-select.js');
      return {
        ...actual,
        multiSelect: async () => new Set(['claude-code', 'codex', 'gemini-cli']),
      };
    });
    vi.doMock('node:readline/promises', () => ({
      createInterface: () => ({
        question: async (_: string) => '',
        close: () => {},
      }),
    }));
    const { runCliCaptured: run } = await import('./test-helpers.js');
    const { code } = await run(
      ['inject', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    vi.resetModules();
    vi.doUnmock('./tui/multi-select.js');
    vi.doUnmock('node:readline/promises');
    expect(code).toBe(0);
    await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf-8');
    await readFile(join(home, '.codex', 'AGENTS.md'), 'utf-8');
    await readFile(join(home, '.gemini', 'GEMINI.md'), 'utf-8');
  });

  it('wizard cancel (null from multiSelect) exits 130 with no writes', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('./tui/multi-select.js', async () => {
      const actual = await vi.importActual<typeof import('./tui/multi-select.js')>('./tui/multi-select.js');
      return { ...actual, multiSelect: async () => null };
    });
    const { runCliCaptured: run } = await import('./test-helpers.js');
    const { code } = await run(
      ['inject', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    vi.resetModules();
    vi.doUnmock('./tui/multi-select.js');
    expect(code).toBe(130);
    await expect(readFile(join(home, '.claude', 'CLAUDE.md'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
