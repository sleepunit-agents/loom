/** The knowledge store's file (`commons/knowledge.db`): its tables, its version, and the one check and
 * upgrade every start runs on it. Pages are written by the door's page actions
 * (pieces/mind/actions.ts) through knowledge-writes.ts, knowledge-revisions.ts and
 * knowledge-verification.ts, and read by pieces/mind/knowledge-query.ts. */
import type { Database } from 'better-sqlite3';
import { deriveSlaClass } from './knowledge-verification.js';

/** The knowledge store's version, kept in the file header (PRAGMA user_version). */
const KNOWLEDGE_VERSION = 1;
/** Before anything is written: an empty file or a knowledge store this program knows, and nothing else.
 * The upgrade creates and alters tables and backfills rows on whatever it is given, so a store a newer
 * program has changed, or some other SQLite file, has to be turned away here. */
function recogniseKnowledgeStore(db: Database): void {
  const at = db.pragma('user_version', { simple: true }) as number;
  if (at > KNOWLEDGE_VERSION) throw new Error(`This knowledge store is from a newer program (version ${at}; this program knows ${KNOWLEDGE_VERSION})`);
  const has = (table?: string) => db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table'${table ? ' AND name = ?' : ''}`).get(...(table ? [table] : [])) !== undefined;
  if (has() && !has('pages')) throw new Error('This file is not a knowledge store');
}

/** Creates a new store's tables and adds what an older store lacks. Each change is found pending from the
 * table's columns, so the caller runs this in one transaction: a change that stopped between adding a
 * column and filling it would never be finished. */
function createAndUpgrade(db: Database): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS pages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid          TEXT NOT NULL UNIQUE,
      slug          TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      domain        TEXT NOT NULL,
      body          TEXT NOT NULL,
      sourcing      TEXT NOT NULL DEFAULT 'sourced',
      provenance    TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      created       TEXT NOT NULL,
      updated       TEXT,
      last_accessed TEXT,
      hit_count     INTEGER NOT NULL DEFAULT 0,
      verified_at   TEXT,
      freshness_anchor TEXT,
      sla_class     TEXT NOT NULL DEFAULT 'default'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain)`,
    `CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status)`,
    `CREATE TABLE IF NOT EXISTS citations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      claim          TEXT NOT NULL,
      source_kind    TEXT NOT NULL,
      source_locator TEXT,
      excerpt        TEXT NOT NULL,
      retrieved_at   TEXT NOT NULL,
      created        TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_citations_page ON citations(page_id)`,
    `CREATE TABLE IF NOT EXISTS supersessions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      old_slug  TEXT NOT NULL,
      new_slug  TEXT NOT NULL,
      note      TEXT,
      created   TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_supersessions_old ON supersessions(old_slug)`,
    `CREATE INDEX IF NOT EXISTS idx_supersessions_new ON supersessions(new_slug)`,
    `CREATE TABLE IF NOT EXISTS page_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, actor TEXT NOT NULL, words TEXT NOT NULL,
      evidence TEXT NOT NULL, created TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_page_annotations_page ON page_annotations(page_id,id)`,
    // Same-page replacements retain their rationale after ordinary revision bodies age out.
    `CREATE TABLE IF NOT EXISTS page_supersessions (
      revision INTEGER PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL,
      created TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_page_supersessions_page ON page_supersessions(page_id,revision)`,
    `CREATE TABLE IF NOT EXISTS page_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      slug        TEXT NOT NULL,
      body        TEXT NOT NULL,
      op          TEXT NOT NULL,
      replaced_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id)`,
    // Actor attribution (t-675): who verified a page, when, and what they
    // found. Additive to pages.verified_at (which stays the fast single-
    // column freshness stamp everything else queries/sorts on) — this
    // table is the attributed audit trail underneath it.
    `CREATE TABLE IF NOT EXISTS verifications (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id          INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      verifier         TEXT,
      verified_at      TEXT NOT NULL,
      outcome          TEXT NOT NULL DEFAULT 'confirmed',
      citation_checked INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_verifications_page ON verifications(page_id)`,
    // Per-identity read attribution (t-677) — additive to pages.hit_count/
    // last_accessed, never a replacement. Deliberate named-tool reads update both counts; live queries leave them alone.
    `CREATE TABLE IF NOT EXISTS knowledge_access (
      page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      identity      TEXT NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT,
      PRIMARY KEY (page_id, identity)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_access_page ON knowledge_access(page_id)`,
  ];
  for (const sql of statements) {
    db.prepare(sql).run();
  }
  // Idempotent migrations for existing DBs (ALTER ADD COLUMN has no IF NOT EXISTS).
  const pageCols = (db.prepare('PRAGMA table_info(pages)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!pageCols.includes('verified_at')) {
    db.prepare('ALTER TABLE pages ADD COLUMN verified_at TEXT').run();
  }
  if (!pageCols.includes('freshness_anchor')) {
    db.prepare('ALTER TABLE pages ADD COLUMN freshness_anchor TEXT').run();
  }
  if (!pageCols.includes('tombstone_note')) {
    db.prepare('ALTER TABLE pages ADD COLUMN tombstone_note TEXT').run();
  }
  // ours/ class metadata (t-81, 2026-08-31).
  if (!pageCols.includes('created_by')) {
    db.prepare('ALTER TABLE pages ADD COLUMN created_by TEXT').run();
  }
  if (!pageCols.includes('version')) {
    db.prepare('ALTER TABLE pages ADD COLUMN version TEXT').run();
  }
  // sla_class: machine-readable freshness SLA class (t-434, 2026-09-25).
  // DEFAULT 'default' covers all rows created before this migration.
  // Backfill then upgrades rows whose anchor or domain implies a non-default class.
  if (!pageCols.includes('sla_class')) {
    db.prepare("ALTER TABLE pages ADD COLUMN sla_class TEXT NOT NULL DEFAULT 'default'").run();
    // Backfill: re-derive for every existing row.
    const rows = db.prepare(
      "SELECT id, freshness_anchor, domain FROM pages",
    ).all() as Array<{ id: number; freshness_anchor: string | null; domain: string }>;
    const update = db.prepare("UPDATE pages SET sla_class = ? WHERE id = ?");
    const backfill = db.transaction(() => {
      for (const row of rows) {
        const klass = deriveSlaClass(row.freshness_anchor, row.domain);
        if (klass !== 'default') {
          update.run(klass, row.id);
        }
      }
    });
    backfill();
  }
  // Actor attribution (t-675): identity that wrote v1 of the page. Set
  // only at creation (insertKnowledgePage) — never backfilled, since there is no
  // way to recover who actually wrote pre-existing rows.
  if (!pageCols.includes('author')) {
    db.prepare('ALTER TABLE pages ADD COLUMN author TEXT').run();
  }
  const revisionCols = (db.prepare('PRAGMA table_info(page_revisions)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!revisionCols.includes('actor')) {
    db.prepare('ALTER TABLE page_revisions ADD COLUMN actor TEXT').run();
  }
}

/**
 * Brings a knowledge store to this program's version, or refuses it: every program that opens the
 * file for writing calls this first, at each start (`prepareSharedMemorySources`). A file a newer
 * program has changed, or one that is not a knowledge store, throws and is left as it is. An up to
 * date file is not written to: the transaction takes the write lock only at its first real change.
 */
export function upgradeKnowledgeStore(db: Database): void {
  recogniseKnowledgeStore(db);
  db.pragma('journal_mode = WAL');
  db.transaction(() => createAndUpgrade(db))();
  if (db.pragma('user_version', { simple: true }) !== KNOWLEDGE_VERSION) db.pragma(`user_version = ${KNOWLEDGE_VERSION}`);
}
