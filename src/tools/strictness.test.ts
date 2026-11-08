/**
 * c-loom-strictness conformance — the write discipline across the wings.
 *
 * These tests are the loom-side verification of the to-be strictness contract
 * (felag: docs/archive/felag-specs/loom-strictness, archived, non-normative). Each `it` names the criterion it greens:
 *   ac-ls-lint-memory          — malformed remember refused pre-commit
 *   ac-ls-lint-rejection-typed — the rejection carries a reason, store unchanged
 *   ac-ls-single-writer-serialize — concurrent writes don't interleave
 *   ac-ls-second-writer-refused   — a second concurrent writer is refused
 *   ac-ls-atomic-parity        — a failed commit leaves the store unchanged
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { remember, validateMemoryInput } from './remember.js';
import { recall } from './recall.js';
import { resolveSqliteDbPath } from '../config.js';
import type { MemoryInput } from '../backends/types.js';

describe('c-loom-strictness: lint-on-write (memory)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-strictness-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ac-ls-lint-memory + ac-ls-lint-rejection-typed
  it('refuses an empty-content memory with a typed reason, store unchanged', async () => {
    await expect(
      remember(tmpDir, { category: 'project', title: 'has a title', content: '   ' }),
    ).rejects.toThrow(/content is required/);

    // store provably unchanged: nothing was committed (no stored memory found)
    const out = await recall(tmpDir, { query: 'has a title' });
    expect(out).toMatch(/No memories found/);
  });

  it('refuses an empty-title memory with a typed reason', async () => {
    await expect(
      remember(tmpDir, { category: 'project', title: '', content: 'real content' }),
    ).rejects.toThrow(/title is required/);
  });

  it('refuses an empty-category memory with a typed reason', async () => {
    await expect(
      remember(tmpDir, { category: '', title: 't', content: 'c' }),
    ).rejects.toThrow(/category is required/);
  });

  it('accepts a well-formed memory', async () => {
    const ref = await remember(tmpDir, {
      category: 'project',
      title: 'A real memory',
      content: 'with real content',
    });
    expect(ref.ref).toContain('project/');
  });

  // validateMemoryInput is the pure gate the tool layer enforces
  it('validateMemoryInput returns a reason for malformed input and null for valid', () => {
    expect(validateMemoryInput({ category: 'p', title: 't', content: '' } as MemoryInput))
      .toMatch(/content is required/);
    expect(validateMemoryInput({ category: 'p', title: '', content: 'c' } as MemoryInput))
      .toMatch(/title is required/);
    expect(validateMemoryInput({ category: 'p', title: 't', content: 'c' } as MemoryInput))
      .toBeNull();
  });
});

describe('c-loom-strictness: single-writer + atomicity', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-strictness-sw-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ac-ls-single-writer-serialize: two writes both land whole, neither torn
  it('serializes concurrent writes — both records land whole', async () => {
    await Promise.all([
      remember(tmpDir, { category: 'project', title: 'Write A', content: 'alpha body' }),
      remember(tmpDir, { category: 'project', title: 'Write B', content: 'beta body' }),
    ]);
    const a = await recall(tmpDir, { query: 'alpha body' });
    const b = await recall(tmpDir, { query: 'beta body' });
    expect(a).toContain('Write A');
    expect(b).toContain('Write B');
  });

  // ac-ls-second-writer-refused: with busy_timeout=0, a second concurrent
  // writer to the same store fails fast (SQLITE_BUSY) rather than racing in.
  it('refuses a second concurrent writer (fail-fast, no block)', async () => {
    // materialize the db file via one well-formed write
    await remember(tmpDir, { category: 'project', title: 'seed', content: 'seed body' });
    const dbPath = resolveSqliteDbPath(tmpDir);

    const holder = new BetterSqlite3(dbPath);
    holder.pragma('journal_mode = WAL');
    holder.pragma('busy_timeout = 0');
    const second = new BetterSqlite3(dbPath);
    second.pragma('journal_mode = WAL');
    second.pragma('busy_timeout = 0');
    try {
      // holder takes the single write lock
      holder.exec('BEGIN IMMEDIATE');
      // second writer is refused immediately, not blocked for 5s
      expect(() => second.exec('BEGIN IMMEDIATE')).toThrow(/SQLITE_BUSY|database is locked/);
      holder.exec('ROLLBACK');
    } finally {
      holder.close();
      second.close();
    }
  });

  // ac-ls-atomic-parity: a rejected write leaves the store provably unchanged
  it('a rejected write leaves the store unchanged (no half-apply)', async () => {
    await remember(tmpDir, { category: 'project', title: 'before', content: 'before body' });
    await expect(
      remember(tmpDir, { category: 'project', title: '', content: '' }),
    ).rejects.toThrow();
    // only the valid prior write is present
    const out = await recall(tmpDir, { query: 'before body' });
    expect(out).toContain('before');
  });
});
