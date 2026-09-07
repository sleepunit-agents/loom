import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runCliCaptured } from './test-helpers.js';

/** Create a pre-SLE-90 memories.db in dir (no archived / archive_note cols). */
function buildOldDb(dir: string): string {
  const dbPath = join(dir, 'memories.db');
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.prepare(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL UNIQUE,
      ref TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      project TEXT,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created TEXT NOT NULL,
      updated TEXT,
      last_accessed TEXT,
      ttl TEXT,
      expires_at TEXT
    )
  `).run();
  db.prepare(`
    CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[4] distance_metric=cosine)
  `).run();
  db.close();
  return dbPath;
}

/** Create a fully-migrated (current-schema) memories.db. */
function buildCurrentDb(dir: string): string {
  const dbPath = join(dir, 'memories.db');
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.prepare(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL UNIQUE,
      ref TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      project TEXT,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created TEXT NOT NULL,
      updated TEXT,
      last_accessed TEXT,
      ttl TEXT,
      expires_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      archive_note TEXT,
      salience REAL NOT NULL DEFAULT 0,
      sourcing TEXT,
      provenance TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX idx_memories_archived ON memories(archived)`).run();
  db.prepare(`
    CREATE TABLE proposals (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid      TEXT NOT NULL UNIQUE,
      category  TEXT,
      title     TEXT,
      content   TEXT,
      project   TEXT,
      ttl       TEXT,
      metadata  TEXT DEFAULT '{}',
      source    TEXT,
      created   TEXT,
      status    TEXT NOT NULL DEFAULT 'pending'
    )
  `).run();
  db.prepare(`
    CREATE TABLE memory_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      ref         TEXT NOT NULL,
      content     TEXT NOT NULL,
      op          TEXT NOT NULL,
      replaced_at TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX idx_memory_revisions_memory ON memory_revisions(memory_id)`).run();
  db.prepare(`
    CREATE TABLE memory_supersessions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      old_ref   TEXT NOT NULL,
      new_ref   TEXT NOT NULL,
      note      TEXT,
      created   TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX idx_memory_supersessions_old ON memory_supersessions(old_ref)`).run();
  db.prepare(`CREATE INDEX idx_memory_supersessions_new ON memory_supersessions(new_ref)`).run();
  db.prepare(`
    CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[4] distance_metric=cosine)
  `).run();
  db.close();
  return dbPath;
}

describe('loom migrate', () => {
  let work: string;

  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'loom-migrate-cli-')); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  it('shows help and exits 0', async () => {
    const { stdout, code } = await runCliCaptured(['migrate', '--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/loom migrate/);
    expect(stdout).toMatch(/--dry-run/);
  });

  it('exits 0 with a message when no memories.db exists', async () => {
    const { stdout, code } = await runCliCaptured(['migrate'], { contextDir: work });
    expect(code).toBe(0);
    expect(stdout).toMatch(/No memories\.db found/);
  });

  it('reports no_db status in JSON when no memories.db exists', async () => {
    const { stdout, code } = await runCliCaptured(['migrate', '--json'], { contextDir: work });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('no_db');
    expect(parsed.migrations).toEqual([]);
  });

  it('applies pending migrations on an old-schema DB', async () => {
    buildOldDb(work);
    const { stdout, code } = await runCliCaptured(['migrate'], { contextDir: work });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Applied.*migration/i);
    expect(stdout).toMatch(/add_archived/);
  });

  it('reports already up to date on a current-schema DB', async () => {
    buildCurrentDb(work);
    const { stdout, code } = await runCliCaptured(['migrate'], { contextDir: work });
    expect(code).toBe(0);
    expect(stdout).toMatch(/up to date/i);
  });

  it('--dry-run reports pending without applying them', async () => {
    buildOldDb(work);
    const { stdout, code } = await runCliCaptured(['migrate', '--dry-run'], { contextDir: work });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Pending migrations/);
    expect(stdout).toMatch(/add_archived/);

    // Verify columns were NOT added (dry run should be read-only)
    const db = new BetterSqlite3(join(work, 'memories.db'));
    const cols = db.pragma('table_info(memories)') as { name: string }[];
    db.close();
    expect(cols.find((c) => c.name === 'archived')).toBeUndefined();
  });

  it('--dry-run JSON shows pending array on old-schema DB', async () => {
    buildOldDb(work);
    const { stdout, code } = await runCliCaptured(['migrate', '--dry-run', '--json'], { contextDir: work });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('dry_run');
    expect(Array.isArray(parsed.pending)).toBe(true);
    expect(parsed.pending.length).toBeGreaterThan(0);
    expect(parsed.pending[0]).toHaveProperty('id');
    expect(parsed.pending[0]).toHaveProperty('description');
  });

  it('--dry-run reports empty pending on a current-schema DB', async () => {
    buildCurrentDb(work);
    const { stdout, code } = await runCliCaptured(['migrate', '--dry-run'], { contextDir: work });
    expect(code).toBe(0);
    expect(stdout).toMatch(/up to date/i);
  });

  it('JSON output on old-schema DB contains applied migrations', async () => {
    buildOldDb(work);
    const { stdout, code } = await runCliCaptured(['migrate', '--json'], { contextDir: work });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('ok');
    expect(Array.isArray(parsed.migrations)).toBe(true);
    const applied = parsed.migrations.filter((m: { status: string }) => m.status === 'applied');
    expect(applied.length).toBeGreaterThan(0);
  });

  it('is idempotent — second run exits 0 with up-to-date message', async () => {
    buildOldDb(work);
    await runCliCaptured(['migrate'], { contextDir: work });
    const { stdout, code } = await runCliCaptured(['migrate'], { contextDir: work });
    expect(code).toBe(0);
    expect(stdout).toMatch(/up to date/i);
  });

  it('exits 1 and writes to stderr when a migration fails', async () => {
    // Create a DB where the memories table doesn't exist so ALTER TABLE fails
    const dbPath = join(work, 'memories.db');
    const db = new BetterSqlite3(dbPath);
    db.pragma('journal_mode = WAL');
    // No memories table — PRAGMA returns no columns → pending=true, but ALTER fails
    db.close();

    const { stderr, code } = await runCliCaptured(['migrate'], { contextDir: work });
    expect(code).toBe(1);
    expect(stderr).toMatch(/failed/i);
  });
});
