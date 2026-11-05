import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { memoryAudit, formatAuditReport } from './memory-audit.js';
import { remember } from './remember.js';
import { closeAllBackends } from '../backends/index.js';

/** Every file in dir with a hash of its bytes: "nothing created or changed" is this, unchanged. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  }
  return out;
}

describe('memoryAudit tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-audit-tool-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders totals, category breakdown, and duplicate pairs', async () => {
    await remember(tmpDir, {
      category: 'project',
      title: 'A',
      content: 'loom loom loom',
    });
    await remember(tmpDir, {
      category: 'project',
      title: 'B',
      content: 'loom loom loom',
    });

    const out = await memoryAudit(tmpDir, { similarityThreshold: 0.5 });
    expect(out).toContain('# Memory audit');
    expect(out).toContain('Total memories:** 2');
    expect(out).toContain('project: 2');
    expect(out).toMatch(/Near-duplicate pairs:\*\*\s*1/);
  });

  it('formats stale entries with last-touch date', () => {
    const out = formatAuditReport({
      totalMemories: 1,
      byCategory: { project: 1 },
      stale: [
        {
          ref: 'project/old-thing',
          title: 'Old thing',
          category: 'project',
          lastTouch: '2025-01-01T00:00:00.000Z',
        },
      ],
      duplicates: [],
      expired: [],
    });
    expect(out).toContain('project/old-thing');
    expect(out).toContain('Old thing');
    expect(out).toContain('2025-01-01');
  });

  // t-1773: memory_audit carries readOnlyHint, so it must not create or change a store.
  describe('is read-only', () => {
    afterEach(() => closeAllBackends());

    it('on a missing store: errors naming the path and creates nothing', async () => {
      const ctx = join(tmpDir, 'no-such-agent');
      await expect(memoryAudit(ctx)).rejects.toThrow(/no memory store at .*no-such-agent/);
      expect(existsSync(ctx)).toBe(false);
    });

    it('on an existing dir with no db: errors and creates no db', async () => {
      await expect(memoryAudit(tmpDir)).rejects.toThrow(/no memory store at/);
      expect(readdirSync(tmpDir)).toEqual([]);
    });

    it('on an un-migrated db: errors and leaves the file byte-for-byte unchanged', async () => {
      // A store from before any migration: the base tables initSchema made, nothing else.
      const db = new BetterSqlite3(join(tmpDir, 'memories.db'));
      sqliteVec.load(db);
      db.exec('CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[384] distance_metric=cosine)');
      db.exec(`CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
        ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL, category TEXT NOT NULL,
        project TEXT, content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
        created TEXT NOT NULL, updated TEXT, last_accessed TEXT, ttl TEXT,
        expires_at TEXT, archived INTEGER NOT NULL DEFAULT 0, archive_note TEXT)`);
      db.close();
      const before = snapshot(tmpDir);

      await expect(memoryAudit(tmpDir)).rejects.toThrow(/older schema|not migrated|migrate/i);
      expect(snapshot(tmpDir)).toEqual(before);
    });

    it('on a file that is not a store: errors and leaves it unchanged', async () => {
      writeFileSync(join(tmpDir, 'memories.db'), '');
      const before = snapshot(tmpDir);
      await expect(memoryAudit(tmpDir)).rejects.toThrow();
      expect(snapshot(tmpDir)).toEqual(before);
    });

    it('on a current, closed store: reports and leaves the db unchanged', async () => {
      await remember(tmpDir, { category: 'project', title: 'A', content: 'loom loom loom' });
      closeAllBackends();
      const before = snapshot(tmpDir);
      expect(Object.keys(before)).toEqual(['memories.db']);

      const out = await memoryAudit(tmpDir);
      expect(out).toContain('Total memories:** 1');
      const after = snapshot(tmpDir);
      // The store itself, byte for byte.
      expect(after['memories.db']).toBe(before['memories.db']);
      // A reader of a WAL-mode db takes SQLite's shared-memory lock, which leaves
      // an EMPTY -wal and a -shm beside it (any loom process does the same). That
      // is locking, not data: the -wal holds no frames. Nothing else appears.
      const EMPTY = createHash('sha256').update('').digest('hex');
      expect(Object.keys(after).filter((n) => !n.endsWith('-shm') && !n.endsWith('-wal')))
        .toEqual(['memories.db']);
      if (after['memories.db-wal']) expect(after['memories.db-wal']).toBe(EMPTY);
    });

    it('next to a live writer: reports without disturbing it', async () => {
      await remember(tmpDir, { category: 'project', title: 'A', content: 'loom loom loom' });
      const out = await memoryAudit(tmpDir);
      expect(out).toContain('Total memories:** 1');
      // The cached write handle still works after the read-only one closed.
      await remember(tmpDir, { category: 'project', title: 'B', content: 'something else' });
      expect(await memoryAudit(tmpDir)).toContain('Total memories:** 2');
    });
  });
});

