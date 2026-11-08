import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { findPiece, listPieces } from './pieces.js';
import { isCliInvocation } from '../index.js';

async function piece(dir: string, name: string, body: string, mode = 0o755) {
  const path = join(dir, `loom-${name}`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, mode);
  return path;
}

describe('loom pieces', () => {
  let a: string;
  let b: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    a = await mkdtemp(join(tmpdir(), 'loom-pieces-a-'));
    b = await mkdtemp(join(tmpdir(), 'loom-pieces-b-'));
    env = { PATH: [a, b, '/usr/bin', '/bin'].join(delimiter) };
  });
  afterEach(async () => {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  });

  it('runs loom-<name> with the args after the name, and passes its exit code back', async () => {
    await piece(a, 'tasks', 'echo "tasks got: $*"; echo oops >&2; exit 7');
    const r = await runCliCaptured(['tasks', 'list', '--status', 'open'], { env });
    expect(r.stdout).toBe('tasks got: list --status open\n');
    expect(r.stderr).toBe('oops\n');
    expect(r.code).toBe(7);
  });

  it('pipes stdin through (a secret value comes from stdin, never argv)', async () => {
    await piece(a, 'secrets', 'read v; echo "len=${#v}"');
    const r = await runCliCaptured(['secrets', 'add', 'google-pass'], { env, stdin: 'hunter22\n' });
    expect(r.stdout).toBe('len=8\n');
    expect(r.code).toBe(0);
  });

  it('passes loom\'s env through unchanged', async () => {
    await piece(a, 'envcheck', 'echo "$LOOM_URL"');
    const r = await runCliCaptured(['envcheck'], { env: { ...env, LOOM_URL: 'http://h:8787/mcp' } });
    expect(r.stdout).toBe('http://h:8787/mcp\n');
  });

  it('first on PATH wins', async () => {
    await piece(a, 'tasks', 'echo from-a');
    await piece(b, 'tasks', 'echo from-b');
    expect((await runCliCaptured(['tasks'], { env })).stdout).toBe('from-a\n');
    expect(listPieces(env)).toEqual([{ name: 'tasks', path: join(a, 'loom-tasks') }]);
  });

  it('core commands can never be shadowed by a piece', async () => {
    await piece(a, 'recall', 'echo hijacked');
    expect(findPiece('recall', env)).toBeUndefined();
    const r = await runCliCaptured(['recall', '--help'], { env });
    expect(r.stdout).not.toContain('hijacked');
    expect(r.stdout).toMatch(/Usage: loom recall/);
    expect(listPieces(env)).toEqual([]);
  });

  it('a name that isn\'t a piece name never touches PATH', async () => {
    await mkdir(join(a, 'sub'));
    await piece(join(a, 'sub'), 'x', 'echo escaped');
    for (const bad of ['../sub/loom-x', 'sub/x', 'X', '-x', '.x', 'a.b']) {
      expect(findPiece(bad, env)).toBeUndefined();
    }
  });

  it('a non-executable or a directory named loom-<name> is not a piece', async () => {
    await piece(a, 'noexec', 'echo hi', 0o644);
    await mkdir(join(a, 'loom-dir'));
    expect(findPiece('noexec', env)).toBeUndefined();
    expect(findPiece('dir', env)).toBeUndefined();
    const r = await runCliCaptured(['noexec'], { env });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no piece installed either/);
  });

  it('refuses loom global flags in front of a piece (they mean nothing to it)', async () => {
    await piece(a, 'tasks', 'echo ran');
    const r = await runCliCaptured(['--json', 'tasks', 'list'], { env });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/don't apply to pieces/);
  });

  it('a piece killed by a signal exits 128+n', async () => {
    await piece(a, 'dies', 'kill -TERM $$');
    expect((await runCliCaptured(['dies'], { env })).code).toBe(128 + 15);
  });

  it('`loom pieces` lists them, human and --json', async () => {
    await piece(a, 'tasks', 'true');
    await piece(b, 'secrets', 'true');
    const human = await runCliCaptured(['pieces'], { env });
    expect(human.stdout).toBe(`secrets\t${join(b, 'loom-secrets')}\ntasks\t${join(a, 'loom-tasks')}\n`);
    const json = await runCliCaptured(['pieces', '--json'], { env });
    expect(JSON.parse(json.stdout).map((p: { name: string }) => p.name)).toEqual(['secrets', 'tasks']);
    const none = await runCliCaptured(['pieces'], { env: { PATH: '/nonexistent' } });
    expect(none.stdout).toMatch(/no pieces installed/);
  });
});

describe('isCliInvocation routes installed pieces to the CLI', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-pieces-route-'));
    savedPath = process.env.PATH;
    process.env.PATH = [dir, savedPath].join(delimiter);
  });
  afterEach(async () => {
    process.env.PATH = savedPath;
    await rm(dir, { recursive: true, force: true });
  });

  it('an installed piece is a CLI call; an unknown token still goes to the stdio server', async () => {
    await piece(dir, 'tasks', 'true');
    expect(isCliInvocation(['node', 'loom', 'tasks', 'list'])).toBe(true);
    expect(isCliInvocation(['node', 'loom', 'nothing-installed-here'])).toBe(false);
    expect(isCliInvocation(['node', 'loom'])).toBe(false);
  });
});
