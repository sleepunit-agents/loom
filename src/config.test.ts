import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveContextDir, resolveDefaultContextPath, assertContextBootable, resolveIdentityName } from './config.js';
import {
  CURRENT_STACK_VERSION,
  STACK_VERSION_FILE,
  readStackVersion,
  ensureStackVersion,
  assertStackVersionCompatible,
} from './config.js';
import { symlinkSync } from 'node:fs';

describe('resolveContextDir', () => {
  const originalEnv = process.env.LOOM_CONTEXT_DIR;
  const originalArgv = [...process.argv];

  afterEach(() => {
    // Restore originals
    if (originalEnv === undefined) {
      delete process.env.LOOM_CONTEXT_DIR;
    } else {
      process.env.LOOM_CONTEXT_DIR = originalEnv;
    }
    process.argv = [...originalArgv];
  });

  it('returns the LOOM_CONTEXT_DIR env var when set', () => {
    process.env.LOOM_CONTEXT_DIR = '/tmp/test-context';
    // Clear CLI arg so it doesn't interfere
    process.argv = ['node', 'index.js'];

    expect(resolveContextDir()).toBe(resolve('/tmp/test-context'));
  });

  it('resolves a relative LOOM_CONTEXT_DIR to an absolute path', () => {
    process.env.LOOM_CONTEXT_DIR = './relative/path';
    process.argv = ['node', 'index.js'];

    const result = resolveContextDir();
    expect(result).toBe(resolve('./relative/path'));
    expect(result).toMatch(/^\//); // absolute
  });

  it('returns --context-dir CLI argument when env var is not set', () => {
    delete process.env.LOOM_CONTEXT_DIR;
    process.argv = ['node', 'index.js', '--context-dir', '/opt/loom-data'];

    expect(resolveContextDir()).toBe(resolve('/opt/loom-data'));
  });

  it('prefers env var over CLI argument', () => {
    process.env.LOOM_CONTEXT_DIR = '/from-env';
    process.argv = ['node', 'index.js', '--context-dir', '/from-cli'];

    expect(resolveContextDir()).toBe(resolve('/from-env'));
  });

  it('ignores --context-dir when it has no following value', () => {
    delete process.env.LOOM_CONTEXT_DIR;
    process.argv = ['node', 'index.js', '--context-dir'];

    // Should fall through to default
    expect(resolveContextDir()).toBe(
      resolve(homedir(), '.config', 'loom', 'default'),
    );
  });

  it('returns default ~/.config/loom/default when nothing is set', () => {
    delete process.env.LOOM_CONTEXT_DIR;
    process.argv = ['node', 'index.js'];

    expect(resolveContextDir()).toBe(
      resolve(homedir(), '.config', 'loom', 'default'),
    );
  });
});

describe('resolveIdentityName', () => {
  const originalEnv = process.env.LOOM_IDENTITY;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-identity-'));
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LOOM_IDENTITY;
    } else {
      process.env.LOOM_IDENTITY = originalEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('LOOM_IDENTITY overrides everything else', () => {
    process.env.LOOM_IDENTITY = 'mark';
    expect(resolveIdentityName(join(dir, 'art'))).toBe('mark');
  });

  it('derives the identity from the context dir basename', () => {
    delete process.env.LOOM_IDENTITY;
    const artDir = join(dir, 'art');
    mkdirSync(artDir, { recursive: true });
    expect(resolveIdentityName(artDir)).toBe('art');
  });

  it('resolves a symlinked context dir to the real identity, not the alias', () => {
    delete process.env.LOOM_IDENTITY;
    const realDir = join(dir, 'art');
    mkdirSync(realDir, { recursive: true });
    const aliasPath = join(dir, 'default');
    symlinkSync(realDir, aliasPath);

    expect(resolveIdentityName(aliasPath)).toBe('art');
  });

  it('falls back to basename when the dir does not exist (no realpath to resolve)', () => {
    delete process.env.LOOM_IDENTITY;
    expect(resolveIdentityName(join(dir, 'ghost'))).toBe('ghost');
  });
});

describe('stack version', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-stack-version-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes CURRENT_STACK_VERSION = 2', () => {
    expect(CURRENT_STACK_VERSION).toBe(2);
  });

  it('exposes STACK_VERSION_FILE = "LOOM_STACK_VERSION"', () => {
    expect(STACK_VERSION_FILE).toBe('LOOM_STACK_VERSION');
  });

  it('readStackVersion returns null when the file is missing', () => {
    expect(readStackVersion(dir)).toBeNull();
  });

  it('readStackVersion parses a numeric version', () => {
    writeFileSync(join(dir, 'LOOM_STACK_VERSION'), '1\n');
    expect(readStackVersion(dir)).toBe(1);
  });

  it('readStackVersion returns NaN for unparseable content', () => {
    writeFileSync(join(dir, 'LOOM_STACK_VERSION'), 'banana');
    expect(Number.isNaN(readStackVersion(dir))).toBe(true);
  });

  it('ensureStackVersion writes CURRENT_STACK_VERSION when the file is missing', () => {
    ensureStackVersion(dir);
    expect(existsSync(join(dir, 'LOOM_STACK_VERSION'))).toBe(true);
    expect(readFileSync(join(dir, 'LOOM_STACK_VERSION'), 'utf-8')).toBe(`${CURRENT_STACK_VERSION}\n`);
  });

  it('ensureStackVersion leaves an existing file untouched', () => {
    writeFileSync(join(dir, 'LOOM_STACK_VERSION'), '1\n');
    ensureStackVersion(dir);
    expect(readFileSync(join(dir, 'LOOM_STACK_VERSION'), 'utf-8')).toBe('1\n');
  });
});

describe('assertStackVersionCompatible', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'loom-stack-gate-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('stamps current version when missing', async () => {
    assertStackVersionCompatible(tempDir);
    const { readFile } = await import('node:fs/promises');
    const stamp = await readFile(join(tempDir, STACK_VERSION_FILE), 'utf-8');
    expect(stamp.trim()).toBe(String(CURRENT_STACK_VERSION));
  });

  it('accepts a stamp equal to CURRENT_STACK_VERSION', async () => {
    await writeFile(join(tempDir, STACK_VERSION_FILE), `${CURRENT_STACK_VERSION}\n`);
    expect(() => assertStackVersionCompatible(tempDir)).not.toThrow();
  });

  it('refuses a stamp ahead of CURRENT_STACK_VERSION', async () => {
    await writeFile(join(tempDir, STACK_VERSION_FILE), `${CURRENT_STACK_VERSION + 1}\n`);
    expect(() => assertStackVersionCompatible(tempDir)).toThrow(/Upgrade loom/);
  });
});

describe('resolveDefaultContextPath', () => {
  it('returns ~/.config/loom/default when no home is provided', () => {
    const result = resolveDefaultContextPath();
    expect(result).toBe(resolve(homedir(), '.config', 'loom', 'default'));
  });

  it('uses the provided home directory', () => {
    const result = resolveDefaultContextPath('/custom/home');
    expect(result).toBe(resolve('/custom/home', '.config', 'loom', 'default'));
  });

  it('resolves to an absolute path', () => {
    const result = resolveDefaultContextPath('/tmp/test-home');
    expect(result).toMatch(/^\//);
    expect(result).toMatch(/default$/);
  });
});

describe('assertContextBootable', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-bootable-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('does not throw when contextDir is not the default path', () => {
    // Non-default path — no enforcement regardless of IDENTITY.md presence
    expect(() => assertContextBootable('/tmp/some-random-dir', '/tmp/some-other-default')).not.toThrow();
  });

  it('throws when contextDir equals the default path and IDENTITY.md is missing', () => {
    // tempDir IS the "default" — no IDENTITY.md inside it
    expect(() => assertContextBootable(tempDir, tempDir)).toThrow(/no loom context configured/);
  });

  it('throws with the correct message content', () => {
    expect(() => assertContextBootable(tempDir, tempDir)).toThrow(
      /refusing to serve a blank identity/,
    );
  });

  it('does not throw when contextDir equals the default path and IDENTITY.md exists', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Art\n');
    expect(() => assertContextBootable(tempDir, tempDir)).not.toThrow();
  });

  it('throws when the default path does not exist at all', () => {
    const missingPath = join(tempDir, 'nonexistent-subdir');
    // Pass missingPath as both contextDir and defaultPath
    expect(() => assertContextBootable(missingPath, missingPath)).toThrow(/no loom context configured/);
  });
});
