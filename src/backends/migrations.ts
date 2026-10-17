/**
 * Schema migration registry for memories.db.
 *
 * Each Migration is idempotent: the `pending` predicate checks current DB
 * state before `run` is called, so migrations are safe to re-run on every
 * backend connect.
 *
 * Add new migrations at the bottom of MIGRATIONS — never reorder or remove
 * existing entries (future migrations may depend on prior state).
 */
import type { Database } from 'better-sqlite3';
import { rebuildUniqKeys } from './dedup.js';

export interface Migration {
  readonly id: string;
  readonly description: string;
  pending(db: Database): boolean;
  run(db: Database): void;
}

export interface MigrationResult {
  id: string;
  description: string;
  status: 'applied' | 'skipped' | 'failed';
  error?: string;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const info = db.pragma(`table_info(${table})`) as { name: string }[];
  return info.some((c) => c.name === column);
}

function hasIndex(db: Database, table: string, name: string): boolean {
  const info = db.pragma(`index_list(${table})`) as { name: string }[];
  return info.some((i) => i.name === name);
}

function hasTable(db: Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 'add_archived',
    description: 'Add archived column for soft-delete/archive tier (SLE-90)',
    pending: (db) => !hasColumn(db, 'memories', 'archived'),
    run: (db) => {
      db.prepare('ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0').run();
    },
  },
  {
    id: 'add_archive_note',
    description: 'Add archive_note column for tombstone data (SLE-90)',
    pending: (db) => !hasColumn(db, 'memories', 'archive_note'),
    run: (db) => {
      db.prepare('ALTER TABLE memories ADD COLUMN archive_note TEXT').run();
    },
  },
  {
    id: 'idx_memories_archived',
    description: 'Index memories.archived for query performance',
    pending: (db) => !hasIndex(db, 'memories', 'idx_memories_archived'),
    run: (db) => {
      db.prepare('CREATE INDEX idx_memories_archived ON memories(archived)').run();
    },
  },
  {
    id: 'add_salience',
    description: 'Add salience temperature for the tiered boot digest (it-loom-salience)',
    pending: (db) => !hasColumn(db, 'memories', 'salience'),
    run: (db) => {
      // Fresh column; new writes set 1.0 (hot), the consolidation lane recomputes
      // existing rows from their timestamps. Default 0 = cold until first refresh.
      db.prepare('ALTER TABLE memories ADD COLUMN salience REAL NOT NULL DEFAULT 0').run();
    },
  },
  {
    id: 'add_proposals',
    description:
      'Add proposals staging table for the capture-propose queue — drafts a ' +
      'background lane stages for ratification; NOT authored canon until ratified',
    pending: (db) => !hasTable(db, 'proposals'),
    run: (db) => {
      // The staging area for the capture-propose queue. A proposal is NOT an
      // authored memory: it lives in its own table, invisible to recall / list /
      // salience / find_similar, and only becomes a real memory via an explicit
      // ratify (which routes through remember() so it is validated like any write).
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
    },
  },
  {
    id: 'add_memory_revisions',
    description:
      'Add memory_revisions table — snapshots displaced body on every update(), ' +
      'capped at 10 per memory (parity with knowledge wing page_revisions, t-327)',
    pending: (db) => !hasTable(db, 'memory_revisions'),
    run: (db) => {
      // Body snapshots retained per memory; oldest pruned beyond this cap.
      // op codes: 'update' (displaced by update()) | 'revision-restore' (displaced
      // by a rollback to a prior snapshot).
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
      db.prepare(
        'CREATE INDEX idx_memory_revisions_memory ON memory_revisions(memory_id)',
      ).run();
    },
  },
  {
    id: 'add_sourcing',
    description:
      'Add sourcing column — provenance/trust tier: observed | relayed | inferred | system (t-328)',
    pending: (db) => !hasColumn(db, 'memories', 'sourcing'),
    run: (db) => {
      // NULL on legacy records: "unknown". New writes should supply a value;
      // the lint-on-write validator will warn (not reject) when omitted.
      db.prepare('ALTER TABLE memories ADD COLUMN sourcing TEXT').run();
    },
  },
  {
    id: 'add_provenance',
    description:
      'Add provenance column — free-form origin (surface / person / session) for trust layer (t-328)',
    pending: (db) => !hasColumn(db, 'memories', 'provenance'),
    run: (db) => {
      db.prepare('ALTER TABLE memories ADD COLUMN provenance TEXT').run();
    },
  },
  {
    id: 'add_memory_supersessions',
    description:
      'Add memory_supersessions table — records that new_ref replaced old_ref, ' +
      'so the supersession edge survives archive (parity with knowledge wing, t-327)',
    pending: (db) => !hasTable(db, 'memory_supersessions'),
    run: (db) => {
      // A supersession is an explicit durable link: old_ref was retired because
      // new_ref is the canonical replacement. old_ref is archived by the supersede()
      // call; this table is the record that B replaced A (survives forever, refs
      // are strings so they outlive archive/restore cycles).
      db.prepare(`
        CREATE TABLE memory_supersessions (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          old_ref   TEXT NOT NULL,
          new_ref   TEXT NOT NULL,
          note      TEXT,
          created   TEXT NOT NULL
        )
      `).run();
      db.prepare(
        'CREATE INDEX idx_memory_supersessions_old ON memory_supersessions(old_ref)',
      ).run();
      db.prepare(
        'CREATE INDEX idx_memory_supersessions_new ON memory_supersessions(new_ref)',
      ).run();
    },
  },
  {
    id: 'add_confidence',
    description:
      'Add confidence column — evidence-backed trust score for feedback memories, ' +
      'computed in code (t-338)',
    pending: (db) => !hasColumn(db, 'memories', 'confidence'),
    run: (db) => {
      // NULL = not applicable (non-feedback memories never get a confidence
      // score). remember() seeds it for category='feedback'; update() adjusts
      // it on a confirm/contradict observation.
      db.prepare('ALTER TABLE memories ADD COLUMN confidence REAL').run();
    },
  },
  {
    id: 'add_evidence_count',
    description:
      'Add evidence_count column — number of observations backing a feedback ' +
      'memory\'s confidence (t-338)',
    pending: (db) => !hasColumn(db, 'memories', 'evidence_count'),
    run: (db) => {
      db.prepare('ALTER TABLE memories ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 0').run();
    },
  },
  {
    id: 'add_observed_at',
    description:
      'Add observed_at column — when a feedback memory\'s confidence last took an ' +
      'observation; the decay clock, separate from `updated` (t-338)',
    pending: (db) => !hasColumn(db, 'memories', 'observed_at'),
    run: (db) => {
      // NULL falls back to `created`. Rows that already carry a confidence
      // got it from an observation no later than their last update, so
      // that's the best clock available for them.
      db.prepare('ALTER TABLE memories ADD COLUMN observed_at TEXT').run();
      db.prepare(
        'UPDATE memories SET observed_at = COALESCE(updated, created) WHERE confidence IS NOT NULL',
      ).run();
    },
  },
  {
    id: 'add_times_seen',
    description:
      'Add times_seen counter — bumped when remember() reheats an exact restatement instead of inserting (t-335)',
    pending: (db) => !hasColumn(db, 'memories', 'times_seen'),
    run: (db) => {
      // DEFAULT 1 backfills existing rows too: each was "seen" at least once
      // (the write that created it), even though restatements before t-335
      // weren't counted.
      db.prepare('ALTER TABLE memories ADD COLUMN times_seen INTEGER NOT NULL DEFAULT 1').run();
    },
  },
  {
    id: 'add_uniq',
    description:
      'Add uniq dedup key column + index, backfilled from existing rows, so write-time ' +
      'remember() can reheat an exact restatement instead of inserting a duplicate (t-335)',
    pending: (db) => !hasColumn(db, 'memories', 'uniq'),
    run: (db) => {
      db.prepare('ALTER TABLE memories ADD COLUMN uniq TEXT').run();
      db.prepare('CREATE INDEX idx_memories_uniq ON memories(uniq)').run();

      // Backfill: compute uniq for every existing ACTIVE row so future
      // restatements of pre-t-335 content also reheat. Archived rows stay
      // NULL and, within a pre-existing duplicate cluster, only the oldest
      // active row gets the key — see rebuildUniqKeys().
      rebuildUniqKeys(db);
    },
  },
  {
    id: 'rekey_uniq_unicode',
    description:
      'Recompute every uniq key with the Unicode-preserving normalizer — the first ' +
      'normalizer stripped all non-ASCII text, so distinct non-Latin memories shared ' +
      'one key (PR120 review)',
    // Marker: the index this migration creates. Databases that ran add_uniq
    // under the old normalizer have only idx_memories_uniq.
    // uniq_active_unique (below) re-keys too and replaces this index.
    pending: (db) =>
      !hasIndex(db, 'memories', 'idx_memories_uniq_v2') &&
      !hasIndex(db, 'memories', 'idx_memories_uniq_active') &&
      !hasIndex(db, 'memories', 'idx_memories_uniq_exact'),
    run: (db) => {
      rebuildUniqKeys(db);
      db.prepare('CREATE INDEX IF NOT EXISTS idx_memories_uniq_v2 ON memories(uniq)').run();
      db.prepare('DROP INDEX IF EXISTS idx_memories_uniq').run();
    },
  },
  {
    id: 'uniq_active_unique',
    description:
      'Make uniq UNIQUE among active rows (partial index), so two concurrent ' +
      'remember() calls of the same content cannot both insert (PR120 review)',
    // rekey_uniq_exact (below) replaces this index with idx_memories_uniq_exact.
    pending: (db) =>
      !hasIndex(db, 'memories', 'idx_memories_uniq_active') &&
      !hasIndex(db, 'memories', 'idx_memories_uniq_exact'),
    run: (db) => {
      db.transaction(() => {
        // Re-key first: any active duplicates written before this index
        // existed (the race it closes, or stale keys from before update()
        // refreshed them) would otherwise make CREATE UNIQUE INDEX fail.
        rebuildUniqKeys(db);
        db.prepare(
          'CREATE UNIQUE INDEX idx_memories_uniq_active ON memories(uniq) WHERE archived = 0',
        ).run();
        db.prepare('DROP INDEX IF EXISTS idx_memories_uniq_v2').run();
        db.prepare('DROP INDEX IF EXISTS idx_memories_uniq').run();
      }).immediate();
    },
  },
  {
    id: 'rekey_uniq_exact',
    description:
      'Recompute every uniq key with the exact normalizer — the previous one folded ' +
      'case, punctuation and whitespace, and compared project ids loosely, so ' +
      '"Offset -5"/"Offset 5", "1.5"/"15" and projects foo-bar/foobar shared a key ' +
      '(PR120 review, round 2)',
    // Marker: the unique index this migration creates, under a new name so
    // databases keyed by the folding normalizer are detectable.
    pending: (db) => !hasIndex(db, 'memories', 'idx_memories_uniq_exact'),
    run: (db) => {
      db.transaction(() => {
        // Drop the old indexes first so the new unique index is built once,
        // over the final keys only.
        db.prepare('DROP INDEX IF EXISTS idx_memories_uniq_active').run();
        db.prepare('DROP INDEX IF EXISTS idx_memories_uniq_v2').run();
        db.prepare('DROP INDEX IF EXISTS idx_memories_uniq').run();
        rebuildUniqKeys(db);
        db.prepare(
          'CREATE UNIQUE INDEX idx_memories_uniq_exact ON memories(uniq) WHERE archived = 0',
        ).run();
      }).immediate();
    },
  },
];

/**
 * Apply pending migrations to a database.
 *
 * With strict: true (default), throws immediately on the first migration
 * failure — the database is in an unknown state and startup should abort.
 *
 * With strict: false, records the error and continues — useful for the CLI
 * migrate subcommand which wants to report all results before exiting.
 */
export function runMigrations(
  db: Database,
  opts: { strict?: boolean } = {},
): MigrationResult[] {
  const strict = opts.strict ?? true;
  const results: MigrationResult[] = [];

  for (const m of MIGRATIONS) {
    if (!m.pending(db)) {
      results.push({ id: m.id, description: m.description, status: 'skipped' });
      continue;
    }
    try {
      m.run(db);
      results.push({ id: m.id, description: m.description, status: 'applied' });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (strict) {
        throw new Error(`Migration '${m.id}' failed: ${error}`);
      }
      results.push({ id: m.id, description: m.description, status: 'failed', error });
    }
  }

  return results;
}

/** Return migrations that have not yet been applied, without touching the DB. */
export function pendingMigrations(db: Database): readonly Migration[] {
  return MIGRATIONS.filter((m) => m.pending(db));
}
