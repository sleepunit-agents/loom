import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MIGRATIONS, runMigrations, pendingMigrations } from './migrations.js';
import { SqliteVecBackend } from './sqlite-vec.js';
import type { EmbeddingProvider } from './types.js';

/** Stub embedder — no ONNX, just deterministic 4-dim vectors. */
function makeEmbedder(): EmbeddingProvider {
  return {
    dimensions: 4,
    embed: async () => [0.5, 0.5, 0.5, 0.5],
    embedBatch: async (ts) => ts.map(() => [0.5, 0.5, 0.5, 0.5]),
  };
}

/** Open a raw BetterSqlite3 DB with the pre-SLE-90 schema (no archive cols). */
function openOldSchemaDb(path: string): ReturnType<typeof BetterSqlite3> {
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.prepare(`
    CREATE TABLE memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid          TEXT NOT NULL UNIQUE,
      ref           TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      category      TEXT NOT NULL,
      project       TEXT,
      content       TEXT NOT NULL,
      metadata      TEXT NOT NULL DEFAULT '{}',
      created       TEXT NOT NULL,
      updated       TEXT,
      last_accessed TEXT,
      ttl           TEXT,
      expires_at    TEXT
    )
  `).run();
  db.prepare(`CREATE VIRTUAL TABLE vec_memories USING vec0(
    embedding float[4] distance_metric=cosine
  )`).run();
  return db;
}

describe('MIGRATIONS registry', () => {
  it('contains at least the three SLE-90 entries', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toContain('add_archived');
    expect(ids).toContain('add_archive_note');
    expect(ids).toContain('idx_memories_archived');
  });
});

describe('runMigrations', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'loom-mig-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('applies all three SLE-90 migrations on an old-schema DB', () => {
    const db = openOldSchemaDb(join(tmpDir, 'old.db'));

    const results = runMigrations(db, { strict: true });
    db.close();

    const applied = results.filter((r) => r.status === 'applied').map((r) => r.id);
    expect(applied).toContain('add_archived');
    expect(applied).toContain('add_archive_note');
    expect(applied).toContain('idx_memories_archived');
  });

  it('creates the proposals table on an old-schema DB', () => {
    const db = openOldSchemaDb(join(tmpDir, 'props.db'));

    const results = runMigrations(db, { strict: true });
    const applied = results.filter((r) => r.status === 'applied').map((r) => r.id);
    expect(applied).toContain('add_proposals');

    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proposals'")
      .get() as { name: string } | undefined;
    expect(tbl?.name).toBe('proposals');

    const cols = (db.pragma('table_info(proposals)') as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'uuid', 'category', 'title', 'content', 'project', 'ttl', 'metadata', 'source', 'created', 'status',
      ]),
    );
    db.close();
  });

  it('skips already-applied migrations (idempotent)', () => {
    const db = openOldSchemaDb(join(tmpDir, 'idm.db'));
    runMigrations(db, { strict: true });

    // Run again — all should be skipped
    const second = runMigrations(db, { strict: true });
    db.close();

    expect(second.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('strict mode throws on a migration error', () => {
    const db = openOldSchemaDb(join(tmpDir, 'err.db'));
    // Corrupt the memories table name so the ALTER will target a nonexistent table
    // Simpler: manually apply one migration to make it look applied but then
    // break a migration by tampering with the DB structure — instead, test by
    // constructing a scenario where the pending check lies.
    // Easiest: override a migration at runtime by directly calling run() on a bad stmt.
    // Test strict mode by passing a fake DB that throws on ALTER.
    db.close();

    // Use a DB where the column doesn't exist but ALTER fails (e.g., table dropped)
    const db2 = new BetterSqlite3(join(tmpDir, 'err2.db'));
    db2.pragma('journal_mode = WAL');
    // Don't create the memories table — runMigrations pending() returns false (no
    // table_info rows means no column found) but run() will fail on ALTER.
    // However: pending() with no table → PRAGMA table_info returns [] → pending = true
    // BUT the ALTER TABLE will fail because the table doesn't exist.
    expect(() => runMigrations(db2, { strict: true })).toThrow(/Migration.*failed/);
    db2.close();
  });

  it('non-strict mode records failure without throwing', () => {
    const db = new BetterSqlite3(join(tmpDir, 'soft.db'));
    db.pragma('journal_mode = WAL');
    // No memories table — pending() returns true, run() fails, strict: false records it
    const results = runMigrations(db, { strict: false });
    db.close();

    expect(results.some((r) => r.status === 'failed')).toBe(true);
  });
});

describe('pendingMigrations', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'loom-pend-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns every migration on an old-schema DB', () => {
    const db = openOldSchemaDb(join(tmpDir, 'old.db'));
    const pending = pendingMigrations(db);
    db.close();

    expect(pending.map((m) => m.id)).toEqual([
      'add_archived', 'add_archive_note', 'idx_memories_archived', 'add_salience', 'add_proposals',
      'add_memory_revisions', 'add_sourcing', 'add_provenance', 'add_memory_supersessions',
    ]);
  });

  it('returns empty array after migrations have been applied', () => {
    const db = openOldSchemaDb(join(tmpDir, 'done.db'));
    runMigrations(db, { strict: true });
    const pending = pendingMigrations(db);
    db.close();

    expect(pending).toHaveLength(0);
  });
});

describe('SqliteVecBackend auto-migration on connect', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'loom-automic-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('migrates an old-schema DB and allows archive operations', async () => {
    const dbPath = join(tmpDir, 'auto.db');

    // Create a pre-SLE-90 DB with a real memory row
    const raw = openOldSchemaDb(dbPath);
    const ts = new Date().toISOString();
    raw.prepare(
      `INSERT INTO memories (uuid, ref, title, category, content, metadata, created)
       VALUES ('u1', 'project/test-abc', 'Test', 'project', 'loom', '{}', ?)`,
    ).run(ts);
    const rawVec = Buffer.from(new Float32Array([0.5, 0.5, 0.5, 0.5]).buffer);
    raw.prepare('INSERT INTO vec_memories(rowid, embedding) VALUES (1, ?)').run(rawVec);
    raw.close();

    // Now connect via the backend — should auto-migrate without throwing
    const backend = new SqliteVecBackend({ dbPath }, makeEmbedder());

    // Verify the columns now exist and archive works
    const archiveResult = await backend.archive({ ref: 'project/test-abc', note: 'migrated' });
    expect(archiveResult.archived).toEqual(['project/test-abc']);

    // Verify archived memory is excluded from recall
    const hits = await backend.recall({ query: 'loom' });
    expect(hits.map((h) => h.path)).not.toContain('project/test-abc');

    backend.close();
  });
});
