import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathSegmentError, assertSafePathSegment, atomicWriteWithBackup } from './path-safety.js';

describe('pathSegmentError', () => {
  it.each([
    '',
    '.',
    '..',
    '../escape',
    '../../../home/user/secrets',
    'foo/bar',
    'foo\\bar',
    '\\\\server\\share',
    'foo\0bar',
  ])('rejects %j', (value) => {
    const error = pathSegmentError(value, 'role');
    expect(error).toMatch(/Invalid role/);
    expect(error).toMatch(/path separators/);
  });

  it.each([
    'claude-code',
    'gemini-cli',
    'wonder',
    'self-model',
    'claude-opus-4.5',
    '...three-dots-is-a-name',
  ])('accepts %j', (value) => {
    expect(pathSegmentError(value, 'role')).toBeNull();
  });

  it('names the offending param in the error', () => {
    expect(pathSegmentError('../x', 'model')).toContain('Invalid model');
    expect(pathSegmentError('', 'client')).toContain('Invalid client');
  });
});

describe('assertSafePathSegment', () => {
  it('throws for unsafe values', () => {
    expect(() => assertSafePathSegment('../x', 'harness name')).toThrow(/harness name/);
    expect(() => assertSafePathSegment('', 'harness name')).toThrow(/non-empty/);
  });

  it('does not throw for safe values', () => {
    expect(() => assertSafePathSegment('claude-code', 'harness name')).not.toThrow();
  });
});

describe('atomicWriteWithBackup', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-path-safety-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes the file with no .bak when it did not exist', async () => {
    const path = join(tempDir, 'preferences.md');
    await atomicWriteWithBackup(path, 'fresh content\n');
    expect(await readFile(path, 'utf-8')).toBe('fresh content\n');
    await expect(readFile(`${path}.bak`, 'utf-8')).rejects.toThrow();
  });

  it('preserves the prior content as .bak when overwriting', async () => {
    const path = join(tempDir, 'preferences.md');
    await writeFile(path, 'version one\n');
    await atomicWriteWithBackup(path, 'version two\n');
    expect(await readFile(path, 'utf-8')).toBe('version two\n');
    expect(await readFile(`${path}.bak`, 'utf-8')).toBe('version one\n');
  });

  it('keeps a single .bak generation, overwriting the older one', async () => {
    const path = join(tempDir, 'preferences.md');
    await writeFile(path, 'v1\n');
    await atomicWriteWithBackup(path, 'v2\n');
    await atomicWriteWithBackup(path, 'v3\n');
    expect(await readFile(path, 'utf-8')).toBe('v3\n');
    expect(await readFile(`${path}.bak`, 'utf-8')).toBe('v2\n');
  });

  it('leaves no tmp files behind', async () => {
    const path = join(tempDir, 'preferences.md');
    await writeFile(path, 'old\n');
    await atomicWriteWithBackup(path, 'new\n');
    const entries = await readdir(tempDir);
    expect(entries.sort()).toEqual(['preferences.md', 'preferences.md.bak']);
  });
});
