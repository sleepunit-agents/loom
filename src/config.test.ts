import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveIdentityName } from './config.js';

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

  it('explicit metadata wins over the directory name and global identity', () => {
    process.env.LOOM_IDENTITY = 'service';
    expect(resolveIdentityName(join(dir, 'relocated'), { agent: 'mark' })).toBe('mark');
    expect(resolveIdentityName(join(dir, 'art'), null)).toBe('art');
    expect(resolveIdentityName(join(dir, 'art'), {})).toBe('art');
    expect(process.env.LOOM_IDENTITY).toBe('service');
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
