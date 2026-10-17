import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MIGRATIONS, runMigrations, pendingMigrations } from './migrations.js';
import { computeUniqKey } from './dedup.js';
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

  it('creates the memory_deletions journal table on an old-schema DB (t-436)', () => {
    const db = openOldSchemaDb(join(tmpDir, 'deletions.db'));

    const results = runMigrations(db, { strict: true });
    const applied = results.filter((r) => r.status === 'applied').map((r) => r.id);
    expect(applied).toContain('add_memory_deletions');

    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_deletions'")
      .get() as { name: string } | undefined;
    expect(tbl?.name).toBe('memory_deletions');

    const cols = (db.pragma('table_info(memory_deletions)') as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'ref', 'category', 'title', 'project', 'content', 'created', 'deleted_at', 'op',
      ]),
    );

    // Standalone table — no FK to memories, unlike memory_revisions (that
    // ON DELETE CASCADE is exactly the bug t-436 fixes).
    const fks = db.pragma('foreign_key_list(memory_deletions)') as unknown[];
    expect(fks).toHaveLength(0);

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
      'add_confidence', 'add_evidence_count', 'add_observed_at',
      'add_memory_deletions',
      'add_scope',
      'add_times_seen', 'add_uniq', 'rekey_uniq_unicode', 'uniq_active_unique', 'rekey_uniq_exact',
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

describe('add_times_seen / add_uniq migrations (t-335)', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'loom-mig-t335-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('backfills times_seen = 1 for pre-existing rows', () => {
    const db = openOldSchemaDb(join(tmpDir, 'ts.db'));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (uuid, ref, title, category, content, metadata, created)
       VALUES ('u1', 'project/a-1', 'A', 'project', 'body', '{}', ?)`,
    ).run(now);

    runMigrations(db, { strict: true });

    const row = db.prepare("SELECT times_seen FROM memories WHERE ref = 'project/a-1'")
      .get() as { times_seen: number };
    expect(row.times_seen).toBe(1);
    db.close();
  });

  it('backfills uniq for every existing row from its current content', () => {
    const db = openOldSchemaDb(join(tmpDir, 'uq.db'));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (uuid, ref, title, category, content, metadata, created)
       VALUES ('u1', 'project/a-1', 'A title', 'project', 'A body', '{}', ?)`,
    ).run(now);

    runMigrations(db, { strict: true });

    const row = db.prepare("SELECT uniq FROM memories WHERE ref = 'project/a-1'")
      .get() as { uniq: string | null };
    expect(row.uniq).not.toBeNull();
    expect(row.uniq).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it('on a pre-existing duplicate cluster, only the first (lowest id) row gets a uniq value', () => {
    const db = openOldSchemaDb(join(tmpDir, 'cluster.db'));
    const now = new Date().toISOString();
    for (const [uuid, ref] of [['u1', 'project/a-1'], ['u2', 'project/a-2'], ['u3', 'project/a-3']]) {
      db.prepare(
        `INSERT INTO memories (uuid, ref, title, category, content, metadata, created)
         VALUES (?, ?, 'Same title', 'project', 'Same body', '{}', ?)`,
      ).run(uuid, ref, now);
    }

    runMigrations(db, { strict: true });

    const rows = db.prepare('SELECT ref, uniq FROM memories ORDER BY id ASC').all() as
      { ref: string; uniq: string | null }[];
    expect(rows[0].uniq).not.toBeNull();
    expect(rows[1].uniq).toBeNull();
    expect(rows[2].uniq).toBeNull();
    db.close();
  });

  it('backfill skips archived rows entirely, so an active row never loses the uniq key to one', () => {
    // Build a DB already at the schema add_uniq expects (every column it
    // reads/writes present, uniq still NULL everywhere) with an ARCHIVED row
    // inserted before its active duplicate — if the backfill didn't filter
    // on archived, the archived row (lower id) would claim the shared uniq
    // key first and leave the active row NULL.
    const db = openOldSchemaDb(join(tmpDir, 'archived-first.db'));
    db.prepare('ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0').run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (uuid, ref, title, category, content, metadata, created, archived)
       VALUES ('u1', 'project/archived-first', 'Same title', 'project', 'Same body', '{}', ?, 1)`,
    ).run(now);
    db.prepare(
      `INSERT INTO memories (uuid, ref, title, category, content, metadata, created, archived)
       VALUES ('u2', 'project/active-second', 'Same title', 'project', 'Same body', '{}', ?, 0)`,
    ).run(now);

    const addUniq = MIGRATIONS.find((m) => m.id === 'add_uniq')!;
    addUniq.run(db);

    const rows = db.prepare('SELECT ref, archived, uniq FROM memories ORDER BY id ASC').all() as
      { ref: string; archived: number; uniq: string | null }[];
    expect(rows[0].archived).toBe(1);
    expect(rows[0].uniq).toBeNull();
    expect(rows[1].archived).toBe(0);
    expect(rows[1].uniq).not.toBeNull();
    db.close();
  });

  it('after all migrations, uniq is covered by one UNIQUE partial index (idx_memories_uniq_exact)', () => {
    const db = openOldSchemaDb(join(tmpDir, 'idx.db'));
    runMigrations(db, { strict: true });
    const idx = db.pragma('index_list(memories)') as { name: string; unique: number; partial: number }[];
    const active = idx.find((i) => i.name === 'idx_memories_uniq_exact');
    expect(active).toMatchObject({ unique: 1, partial: 1 });
    expect(idx.map((i) => i.name)).not.toContain('idx_memories_uniq_active');
    expect(idx.map((i) => i.name)).not.toContain('idx_memories_uniq');
    expect(idx.map((i) => i.name)).not.toContain('idx_memories_uniq_v2');
    db.close();
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

describe('rekey_uniq_unicode migration (PR120 review)', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'loom-mig-rekey-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('recomputes keys stored by the old ASCII-only normalization', () => {
    // A DB that already ran add_uniq under the old normalizer: both CJK rows
    // normalized to the same empty basis, so the first holds that legacy
    // key and the second was left NULL as a "duplicate".
    const db = openOldSchemaDb(join(tmpDir, 'legacy.db'));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (uuid, ref, title, category, content, metadata, created)
       VALUES ('u1', 'project/jp', '日本', 'project', '東京', '{}', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO memories (uuid, ref, title, category, content, metadata, created)
       VALUES ('u2', 'project/cn', '中国', 'project', '北京', '{}', ?)`,
    ).run(now);
    for (const m of MIGRATIONS) {
      if (m.id === 'rekey_uniq_unicode') break;
      if (m.pending(db)) m.run(db);
    }
    db.prepare("UPDATE memories SET uniq = 'legacy-ascii-key' WHERE ref = 'project/jp'").run();
    db.prepare("UPDATE memories SET uniq = NULL WHERE ref = 'project/cn'").run();

    expect(pendingMigrations(db).map((m) => m.id)).toContain('rekey_uniq_unicode');
    runMigrations(db, { strict: true });

    const rows = db.prepare('SELECT ref, uniq FROM memories ORDER BY id').all() as
      { ref: string; uniq: string | null }[];
    expect(rows[0].uniq).toBe(computeUniqKey({ category: 'project', title: '日本', content: '東京' }));
    expect(rows[1].uniq).toBe(computeUniqKey({ category: 'project', title: '中国', content: '北京' }));
    expect(pendingMigrations(db)).toHaveLength(0);
    db.close();
  });
});

describe('uniq_active_unique migration (PR120 review)', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'loom-mig-uq-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('applies over active rows that already share a key (written by the old race) and keeps the oldest as holder', () => {
    const db = openOldSchemaDb(join(tmpDir, 'raced.db'));
    for (const m of MIGRATIONS) {
      if (m.id === 'uniq_active_unique') break;
      if (m.pending(db)) m.run(db);
    }
    const now = new Date().toISOString();
    const key = computeUniqKey({ category: 'project', title: 'Status', content: 'alpha' });
    for (const [uuid, ref] of [['u1', 'project/s-1'], ['u2', 'project/s-2']]) {
      db.prepare(
        `INSERT INTO memories (uuid, ref, title, category, content, metadata, created, uniq)
         VALUES (?, ?, 'Status', 'project', 'alpha', '{}', ?, ?)`,
      ).run(uuid, ref, now, key);
    }

    const results = runMigrations(db, { strict: true });
    expect(results.find((r) => r.id === 'uniq_active_unique')?.status).toBe('applied');

    const rows = db.prepare('SELECT ref, uniq FROM memories ORDER BY id').all() as
      { ref: string; uniq: string | null }[];
    expect(rows).toEqual([{ ref: 'project/s-1', uniq: key }, { ref: 'project/s-2', uniq: null }]);
    expect(pendingMigrations(db)).toHaveLength(0);
    db.close();
  });
});

describe('rekey_uniq_exact migration (PR120 review, round 2)', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'loom-mig-exact-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  /** A DB that ran every migration up to and including uniq_active_unique. */
  function atUniqActiveUnique(path: string): BetterSqlite3.Database {
    const db = openOldSchemaDb(path);
    for (const m of MIGRATIONS) {
      if (m.id === 'rekey_uniq_exact') break;
      if (m.pending(db)) m.run(db);
    }
    return db;
  }

  function insert(db: BetterSqlite3.Database, ref: string, project: string | null, content: string, uniq: string | null) {
    db.prepare(
      `INSERT INTO memories (uuid, ref, title, category, project, content, metadata, created, uniq)
       VALUES (?, ?, 'T', 'project', ?, ?, '{}', ?, ?)`,
    ).run(ref, ref, project, content, new Date().toISOString(), uniq);
  }

  it('gives rows the punctuation-folding key had merged their own keys back', () => {
    const db = atUniqActiveUnique(join(tmpDir, 'folded.db'));
    // Under the folding normalizer "Offset -5"/"Offset 5" and the
    // foo-bar/foobar projects shared a key: the first row held it, the
    // second stayed NULL.
    insert(db, 'project/o1', null, 'Offset -5', 'folded-offset');
    insert(db, 'project/o2', null, 'Offset 5', null);
    insert(db, 'project/p1', 'foo-bar', 'same', 'folded-project');
    insert(db, 'project/p2', 'foobar', 'same', null);

    expect(pendingMigrations(db).map((m) => m.id)).toEqual(['rekey_uniq_exact']);
    runMigrations(db, { strict: true });

    const rows = db.prepare('SELECT ref, uniq FROM memories ORDER BY id').all() as
      { ref: string; uniq: string | null }[];
    expect(rows).toEqual([
      { ref: 'project/o1', uniq: computeUniqKey({ category: 'project', title: 'T', content: 'Offset -5' }) },
      { ref: 'project/o2', uniq: computeUniqKey({ category: 'project', title: 'T', content: 'Offset 5' }) },
      { ref: 'project/p1', uniq: computeUniqKey({ category: 'project', project: 'foo-bar', title: 'T', content: 'same' }) },
      { ref: 'project/p2', uniq: computeUniqKey({ category: 'project', project: 'foobar', title: 'T', content: 'same' }) },
    ]);
    expect(pendingMigrations(db)).toHaveLength(0);
    db.close();
  });

  it('does not trip the unique index when a row\'s new key is a later row\'s old key', () => {
    const db = atUniqActiveUnique(join(tmpDir, 'swap.db'));
    const keyA = computeUniqKey({ category: 'project', title: 'T', content: 'a' });
    const keyB = computeUniqKey({ category: 'project', title: 'T', content: 'b' });
    // Stale keys, swapped: rekeying row a (lower id) first writes keyA while
    // row b still holds it.
    insert(db, 'project/a', null, 'a', keyB);
    insert(db, 'project/b', null, 'b', keyA);

    runMigrations(db, { strict: true });

    const rows = db.prepare('SELECT ref, uniq FROM memories ORDER BY id').all() as
      { ref: string; uniq: string | null }[];
    expect(rows).toEqual([{ ref: 'project/a', uniq: keyA }, { ref: 'project/b', uniq: keyB }]);
    db.close();
  });
});
