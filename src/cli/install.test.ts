import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './install.js';
import type { IOStreams } from './io.js';

function mkIo(env: Record<string, string>, overrides: Partial<IOStreams> = {}): {
  io: IOStreams;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: IOStreams = {
    stdin: process.stdin,
    stdinIsTTY: false,
    stdout: (s) => { out.push(s); },
    stderr: (s) => { err.push(s); },
    env,
    ...overrides,
  };
  return { io, out, err };
}

describe('loom install', () => {
  let work: string;
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'loom-install-cli-')); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  it('--harness claude-code --to <path> writes and reports', async () => {
    const dest = join(work, 'loom-setup.md');
    const { io, out } = mkIo({});
    const code = await run(['--harness', 'claude-code', '--to', dest], io);
    expect(code).toBe(0);
    await expect(stat(dest)).resolves.toBeTruthy();
    expect(out.join('')).toMatch(/Claude Code/);
    expect(out.join('')).toMatch(/\/loom-setup/);
  });

  it('--json emits structured result and suppresses prose', async () => {
    const dest = join(work, 'loom-setup.md');
    const { io, out } = mkIo({});
    const code = await run(
      ['--harness', 'codex', '--to', dest, '--json'],
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.target).toBe('codex');
    expect(parsed.path).toBe(dest);
    expect(parsed.action).toBe('created');
    expect(out.join('')).not.toMatch(/restart/i);
  });

  it('--dry-run does not write', async () => {
    const dest = join(work, 'loom-setup.md');
    const { io } = mkIo({});
    const code = await run(
      ['--harness', 'claude-code', '--to', dest, '--dry-run', '--json'],
      io,
    );
    expect(code).toBe(0);
    await expect(stat(dest)).rejects.toThrow();
  });

  it('other target writes to ./loom-setup-skill.md in cwd when no --to', async () => {
    const dest = join(work, 'loom-setup-skill.md');
    const prevCwd = process.cwd();
    process.chdir(work);
    try {
      const { io, out } = mkIo({});
      const code = await run(['--harness', 'other', '--json'], io);
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join(''));
      expect(parsed.target).toBe('other');
      expect(parsed.path).toBe(dest);
      const body = await readFile(dest, 'utf-8');
      expect(body).toMatch(/name:\s*loom-setup/);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('errors on non-TTY with no --harness', async () => {
    const { io, err } = mkIo({});
    const code = await run([], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/--harness|TTY/i);
  });

  it('errors on unknown harness', async () => {
    const { io, err } = mkIo({});
    const code = await run(['--harness', 'bogus'], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/bogus/);
  });

  it('--to without --harness on non-TTY still errors', async () => {
    const { io, err } = mkIo({});
    const code = await run(['--to', '/tmp/x.md'], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/--harness|TTY/i);
  });
});
