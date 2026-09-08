/**
 * SQLite knowledge backend — isolated from the memory wing.
 *
 * This backend opens a separate knowledge.db file, never loads sqlite-vec,
 * and never touches memories.db. It follows the frozen v1 schema (§B) from
 * the hardened design: pages + citations tables, PRAGMA user_version = 1,
 * WAL mode, close-in-finally pattern.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { retryWrite } from './retry.js';
import type {
  KnowledgeBackend,
  KnowledgePageInput,
  KnowledgeCitationInput,
  KnowledgePage,
  KnowledgeCitation,
  KnowledgePageWithCitations,
  KnowledgeQueryInput,
  KnowledgeWriteResult,
  KnowledgeArchiveInput,
  KnowledgeArchiveResult,
  KnowledgeRestoreInput,
  KnowledgeRestoreResult,
  KnowledgeSupersededInput,
  KnowledgeSupersededResult,
  KnowledgeMoveInput,
  KnowledgeMoveResult,
  KnowledgeMovedPageRecord,
  KnowledgeMergeInput,
  KnowledgeMergeResult,
  KnowledgePurgeInput,
  KnowledgePurgeResult,
  KnowledgeVerifyInput,
  KnowledgeVerifyResult,
  KnowledgeRevision,
  KnowledgeRevisionMeta,
  KnowledgeRevisionRestoreInput,
  KnowledgeRevisionRestoreResult,
} from './types.js';

/** Hard size caps — enforced at write boundary (design §A3). */
const MAX_PAGE_BODY_LENGTH = 64 * 1024; // 64 KB
const MAX_CITATION_EXCERPT_LENGTH = 4096; // 4 KB

/** Body snapshots retained per page; oldest pruned beyond this. */
const MAX_REVISIONS_PER_PAGE = 10;

export interface SqliteKnowledgeConfig {
  /** Absolute path to the knowledge SQLite database file */
  dbPath: string;
}

export class SqliteKnowledgeBackend implements KnowledgeBackend {
  private db: Database | null = null;

  constructor(private readonly config: SqliteKnowledgeConfig) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    // Open in constructor for schema init; caller closes after use.
    this.db = new BetterSqlite3(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    // Single-writer (c-loom-strictness §single-writer): fail fast on a second
    // concurrent writer (SQLITE_BUSY) instead of blocking for the 5s default —
    // see sqlite-vec.ts for the rationale. The knowledge wing shares the policy.
    this.db.pragma('busy_timeout = 0');
    this.db.pragma('user_version = 1');
    this.initSchema();
  }

  // ── KnowledgeBackend interface ──

  writePage(input: KnowledgePageInput): Promise<KnowledgeWriteResult> {
    try {
      enforcePageBodyCap(input.body);

      const db = this.ensureOpen();
      const timestamp = new Date().toISOString();

      // Title and domain follow the write — the page is addressed by slug,
      // so a differing title/domain on upsert is an intentional revision.
      const title: string = input.title;
      const sourcing: string = input.sourcing ?? 'sourced';

      // Set inside the transaction, read after it commits. Every one of these
      // is derived from the existing-page read, so all of them are re-derived
      // on a SQLITE_BUSY retry rather than carried over from the losing attempt.
      let uuid = '';
      let appliedMode: 'create' | 'replace' | 'append' = 'create';
      let pageId = 0;

      // Validate all citations before opening the transaction.
      if (input.citations && input.citations.length > 0) {
        for (const cit of input.citations) {
          enforceExcerptCap(cit.excerpt);
        }
      }

      let citationsAdded = 0;
      let citationsDeduped = 0;

      // Pre-prepare citation statements — compiled once, safe to reuse on retry.
      // Exact-duplicate guard: re-sending a page's citations on upsert must not
      // multiply them. A citation is a duplicate when claim, kind, locator, and
      // excerpt all match an existing row on the same page.
      const dupCheck = db.prepare(
        `SELECT 1 FROM citations
         WHERE page_id = ? AND claim = ? AND source_kind = ?
           AND COALESCE(source_locator, '') = COALESCE(?, '')
           AND excerpt = ?`,
      );
      const insertCit = db.prepare(
        `INSERT INTO citations (page_id, claim, source_kind, source_locator, excerpt, retrieved_at, created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      // ── Single transaction: read + snapshot + page write + citations ─────────
      // All sub-operations must commit atomically — a crash between any two
      // leaves a partial state: a page with no citations, or a snapshot with no
      // corresponding page update. Every other mutating method uses db.transaction;
      // writePage — the hottest path — now does too (t-329).
      //
      // The existing-page read is INSIDE the span, and the span is IMMEDIATE:
      // writePage is state-dependent (mode, body, uuid, and the snapshot's
      // pre-image all follow from what it read), so an atomic write over a read
      // taken outside the lock protects nothing. A second process committing in
      // that window used to be silently overwritten — an append dropped the
      // contribution it never saw, and a replace snapshotted a body that was no
      // longer the one it displaced, losing it with no revision to recover from.
      // BEGIN IMMEDIATE takes the write lock before the read, so the read/write
      // sequence is serialized: the loser is told SQLITE_BUSY and retries the
      // whole thing — re-reading — instead of writing over what it missed.
      // (Mark, 2026-09-06, reviewing #92.)
      //
      // Counter variables (citationsAdded, citationsDeduped) are reset at the top
      // of the callback so a SQLITE_BUSY retry never double-counts.
      const tx = db.transaction(() => {
        citationsAdded = 0;
        citationsDeduped = 0;

        const existing = db.prepare(
          'SELECT id, uuid, title, body FROM pages WHERE slug = ?',
        ).get(input.slug) as { id: number; uuid: string; title: string; body: string } | undefined;

        uuid = existing?.uuid ?? randomUUID();
        pageId = existing?.id ?? 0;
        appliedMode = existing ? (input.bodyMode ?? 'replace') : 'create';
        const newBody: string = (existing && appliedMode === 'append')
          ? `${existing.body}\n\n${input.body}`
          : input.body;
        if (existing) enforcePageBodyCap(newBody);

        if (existing) {
          // Replace-writes destroy the stored body — snapshot it first so the
          // page is recoverable (the 2026-06-01 verify run stomped 13 bodies
          // with no recovery path other than transcript archaeology).
          if (appliedMode === 'replace' && newBody !== existing.body) {
            this.snapshotRevision(db, pageId, input.slug, existing.body, 'write-replace', timestamp);
          }

          // verified_at is a verification stamp, not a write stamp: an update
          // only moves it when the writer explicitly claims verification.
          // (Creation still stamps write time — the page was just synthesized
          // against its sources.)
          // created_by / version are preserved across upserts when omitted.
          db.prepare(
            `UPDATE pages SET title = ?, domain = ?, body = ?, sourcing = ?, verified_at = COALESCE(?, verified_at), freshness_anchor = COALESCE(?, freshness_anchor), created_by = COALESCE(?, created_by), version = COALESCE(?, version), updated = ? WHERE id = ?`,
          ).run(title, input.domain, newBody, sourcing, input.verified_at ?? null, input.freshness_anchor ?? null, input.created_by ?? null, input.version ?? null, timestamp, pageId);
        } else {
          const result = db.prepare(
            `INSERT INTO pages (uuid, slug, title, domain, body, sourcing, provenance, verified_at, freshness_anchor, created_by, version, created, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            uuid,
            input.slug,
            title,
            input.domain,
            newBody,
            sourcing,
            input.provenance ?? null,
            input.verified_at ?? timestamp,
            input.freshness_anchor ?? null,
            input.created_by ?? null,
            input.version ?? null,
            timestamp,
            timestamp,
          );
          pageId = Number(result.lastInsertRowid);
        }

        if (input.citations && input.citations.length > 0) {
          for (const cit of input.citations!) {
            const dup = dupCheck.get(
              pageId,
              cit.claim,
              cit.source_kind,
              cit.source_locator ?? null,
              cit.excerpt,
            );
            if (dup) {
              citationsDeduped++;
              continue;
            }
            insertCit.run(
              pageId,
              cit.claim,
              cit.source_kind,
              cit.source_locator ?? null,
              cit.excerpt,
              timestamp,
              timestamp,
            );
            citationsAdded++;
          }
        }
      });
      retryWrite(() => tx.immediate());

      return Promise.resolve({
        uuid,
        slug: input.slug,
        title,
        citationsAdded,
        citationsDeduped,
        created: appliedMode === 'create',
        bodyMode: appliedMode,
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  getPage(slug: string, opts?: { stampAccess?: boolean }): Promise<KnowledgePageWithCitations | null> {
    try {
      const db = this.ensureOpen();

      const page = db.prepare(
        'SELECT * FROM pages WHERE slug = ?',
      ).get(slug) as KnowledgePage | undefined;

      if (!page) return Promise.resolve(null);

      if (opts?.stampAccess) {
        const now = new Date().toISOString();
        retryWrite(() =>
          db.prepare(
            'UPDATE pages SET last_accessed = ?, hit_count = hit_count + 1 WHERE id = ?',
          ).run(now, page.id),
        );
        page.last_accessed = now;
        page.hit_count += 1;
      }

      const citations = db.prepare(
        'SELECT * FROM citations WHERE page_id = ? ORDER BY id',
      ).all(page.id) as KnowledgeCitation[];

      return Promise.resolve({ ...page, citations });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  listPages(input?: KnowledgeQueryInput): Promise<KnowledgePageWithCitations[]> {
    try {
      const db = this.ensureOpen();
      const limit = input?.limit ?? 50;

      const clauses: string[] = [];
      const params: unknown[] = [];

      if (input?.excludeStatus) {
        clauses.push('status != ?');
        params.push(input.excludeStatus);
      }

      if (input?.domain) {
        // Prefix filter INCLUDING the exact domain itself — 'music/gear'
        // must match pages in 'music/gear' as well as 'music/gear/elektron'.
        clauses.push('(domain = ? OR domain LIKE ?)');
        params.push(input.domain, `${input.domain}/%`);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM pages ${where} ORDER BY updated DESC, created DESC LIMIT ?`,
      ).all(...params) as KnowledgePage[];

      return Promise.resolve(rows.map((page) => ({
        ...page,
        citations: this.fetchCitationsForPage(db, page.id),
      })));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  queryPages(input: KnowledgeQueryInput): Promise<KnowledgePageWithCitations[]> {
    try {
      const db = this.ensureOpen();
      const limit = input.limit ?? 10;

      const clauses: string[] = [];
      const params: unknown[] = [];

      if (input.query) {
        // Split into tokens on whitespace. Never filter by token length —
        // single-letter tokens like 'I' and roman numerals like 'II' are
        // semantically meaningful (e.g. "Digitakt I" vs "Digitakt II") and
        // must never be stopworded or dropped.
        const tokens = input.query.trim().split(/\s+/).filter((t) => t.length > 0);
        for (const token of tokens) {
          const likePattern = `%${token}%`;
          clauses.push('(title LIKE ? OR body LIKE ? OR domain LIKE ?)');
          params.push(likePattern, likePattern, likePattern);
        }
      }

      if (input.domain) {
        // Prefix filter INCLUDING the exact domain itself — 'music/gear'
        // must match pages in 'music/gear' as well as 'music/gear/elektron'.
        clauses.push('(domain = ? OR domain LIKE ?)');
        params.push(input.domain, `${input.domain}/%`);
      }

      if (input.excludeStatus) {
        clauses.push('status != ?');
        params.push(input.excludeStatus);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(limit);

      // Stale-first ordering for the verification engine: never-verified
      // pages first (NULL sorts lowest in SQLite ASC), then oldest-verified.
      const orderBy = input.sortByVerified
        ? 'ORDER BY verified_at ASC NULLS FIRST, updated ASC'
        : 'ORDER BY hit_count DESC, updated DESC, created DESC';

      const rows = db.prepare(
        `SELECT * FROM pages ${where} ${orderBy} LIMIT ?`,
      ).all(...params) as KnowledgePage[];

      // Stamp last_accessed + increment hit_count in a single transaction for all hits.
      // This is the usage signal the Phase-4 expansion engine depends on.
      // Callers doing index-style browsing pass stampAccess: false — a page
      // appearing in a listing is not a read.
      if (rows.length > 0 && input.stampAccess !== false) {
        const now = new Date().toISOString();
        const stamp = db.prepare(
          'UPDATE pages SET last_accessed = ?, hit_count = hit_count + 1 WHERE id = ?',
        );
        const tx = db.transaction((ids: number[]) => {
          for (const id of ids) stamp.run(now, id);
        });
        retryWrite(() => tx(rows.map((r) => r.id)));
      }

      return Promise.resolve(rows.map((page) => ({
        ...page,
        citations: this.fetchCitationsForPage(db, page.id),
      })));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  archivePage(input: KnowledgeArchiveInput): Promise<KnowledgeArchiveResult> {
    try {
      const db = this.ensureOpen();
      const timestamp = new Date().toISOString();

      const page = db.prepare(
        "SELECT id, status FROM pages WHERE slug = ?",
      ).get(input.slug) as { id: number; status: string } | undefined;

      if (!page || page.status === 'archived') {
        return Promise.resolve({ slug: input.slug, archived: false });
      }

      retryWrite(() =>
        db.prepare(
          "UPDATE pages SET status = 'archived', tombstone_note = ?, updated = ? WHERE slug = ?",
        ).run(input.note ?? null, timestamp, input.slug),
      );

      return Promise.resolve({ slug: input.slug, archived: true });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  restorePage(input: KnowledgeRestoreInput): Promise<KnowledgeRestoreResult> {
    try {
      const db = this.ensureOpen();
      const timestamp = new Date().toISOString();

      const page = db.prepare(
        "SELECT id, status FROM pages WHERE slug = ?",
      ).get(input.slug) as { id: number; status: string } | undefined;

      if (!page || page.status !== 'archived') {
        return Promise.resolve({ slug: input.slug, restored: false });
      }

      retryWrite(() =>
        db.prepare(
          "UPDATE pages SET status = 'active', tombstone_note = NULL, updated = ? WHERE slug = ?",
        ).run(timestamp, input.slug),
      );

      return Promise.resolve({ slug: input.slug, restored: true });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  supersedePage(input: KnowledgeSupersededInput): Promise<KnowledgeSupersededResult> {
    try {
      const db = this.ensureOpen();

      const oldPage = db.prepare(
        "SELECT id, status FROM pages WHERE slug = ?",
      ).get(input.old_slug) as { id: number; status: string } | undefined;

      if (!oldPage) {
        return Promise.reject(new Error(`supersedePage: old page not found: ${input.old_slug}`));
      }

      const newPage = db.prepare(
        "SELECT id FROM pages WHERE slug = ?",
      ).get(input.new_slug) as { id: number } | undefined;

      if (!newPage) {
        return Promise.reject(new Error(`supersedePage: new (canonical) page not found: ${input.new_slug}`));
      }

      if (oldPage.status === 'archived') {
        return Promise.resolve({ old_slug: input.old_slug, new_slug: input.new_slug, archived: false });
      }

      const timestamp = new Date().toISOString();
      const tombstoneNote = input.note
        ? `Superseded by ${input.new_slug}. ${input.note}`
        : `Superseded by ${input.new_slug}.`;

      const tx = db.transaction(() => {
        // Archive the old page with a tombstone.
        db.prepare(
          "UPDATE pages SET status = 'archived', tombstone_note = ?, updated = ? WHERE slug = ?",
        ).run(tombstoneNote, timestamp, input.old_slug);

        // Record the supersession.
        db.prepare(
          "INSERT INTO supersessions (old_slug, new_slug, note, created) VALUES (?, ?, ?, ?)",
        ).run(input.old_slug, input.new_slug, input.note ?? null, timestamp);
      });
      retryWrite(() => tx.immediate());

      return Promise.resolve({
        old_slug: input.old_slug,
        new_slug: input.new_slug,
        archived: oldPage.status !== 'archived',
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  movePage(input: KnowledgeMoveInput): Promise<KnowledgeMoveResult> {
    try {
      const db = this.ensureOpen();
      const timestamp = new Date().toISOString();

      // ── Batch by domain prefix substitution ──────────────────────────────────
      if (input.from_domain_prefix !== undefined) {
        if (!input.to_domain_prefix) {
          return Promise.reject(new Error('movePage: to_domain_prefix is required when from_domain_prefix is set'));
        }
        if (input.from_domain_prefix === input.to_domain_prefix) {
          return Promise.reject(new Error('movePage: from_domain_prefix and to_domain_prefix must differ'));
        }

        const affected = db.prepare(
          `SELECT slug, domain FROM pages WHERE domain = ? OR domain LIKE ?`,
        ).all(input.from_domain_prefix, `${input.from_domain_prefix}/%`) as Array<{ slug: string; domain: string }>;

        const pages: KnowledgeMovedPageRecord[] = [];

        const tx = db.transaction(() => {
          for (const p of affected) {
            const newDomain = input.to_domain_prefix! + p.domain.slice(input.from_domain_prefix!.length);
            db.prepare('UPDATE pages SET domain = ?, updated = ? WHERE slug = ?').run(newDomain, timestamp, p.slug);
            pages.push({ slug: p.slug, old_domain: p.domain, new_domain: newDomain });
          }
        });
        retryWrite(() => tx.immediate());

        return Promise.resolve({ moved: pages.length, pages, pointers_written: 0 });
      }

      // ── Batch by explicit slug list (re-domain only) ──────────────────────────
      if (input.slugs && input.slugs.length > 0) {
        if (!input.new_domain) {
          return Promise.reject(new Error('movePage: new_domain is required when slugs list is provided'));
        }

        const pages: KnowledgeMovedPageRecord[] = [];

        const tx = db.transaction(() => {
          for (const slug of input.slugs!) {
            const page = db.prepare(
              'SELECT domain FROM pages WHERE slug = ?',
            ).get(slug) as { domain: string } | undefined;

            if (!page) {
              throw new Error(`movePage: page not found: ${slug}`);
            }

            db.prepare('UPDATE pages SET domain = ?, updated = ? WHERE slug = ?').run(
              input.new_domain!, timestamp, slug,
            );
            pages.push({ slug, old_domain: page.domain, new_domain: input.new_domain! });
          }
        });
        retryWrite(() => tx.immediate());

        return Promise.resolve({ moved: pages.length, pages, pointers_written: 0 });
      }

      // ── Single-page mode ──────────────────────────────────────────────────────
      if (!input.slug) {
        return Promise.reject(new Error('movePage: slug is required for single-page mode'));
      }
      if (!input.new_slug && !input.new_domain) {
        return Promise.reject(new Error('movePage: at least one of new_slug or new_domain is required'));
      }
      if (input.new_slug && input.new_slug === input.slug) {
        return Promise.reject(new Error('movePage: new_slug must differ from the current slug'));
      }

      const page = db.prepare(
        'SELECT domain FROM pages WHERE slug = ?',
      ).get(input.slug) as { domain: string } | undefined;

      if (!page) {
        return Promise.reject(new Error(`movePage: page not found: ${input.slug}`));
      }

      // Slug-collision check — must happen before the transaction.
      if (input.new_slug) {
        const collision = db.prepare(
          'SELECT id FROM pages WHERE slug = ?',
        ).get(input.new_slug) as { id: number } | undefined;

        if (collision) {
          return Promise.reject(new Error(
            `movePage: slug '${input.new_slug}' already exists — use knowledge_merge instead of knowledge_move to consolidate pages.`,
          ));
        }
      }

      const oldSlug = input.slug;
      const oldDomain = page.domain;
      const leavePointer = input.leave_pointer !== false; // default true
      let pointersWritten = 0;

      const tx = db.transaction(() => {
        if (input.new_slug) {
          db.prepare('UPDATE pages SET slug = ?, updated = ? WHERE slug = ?').run(
            input.new_slug, timestamp, oldSlug,
          );
          if (leavePointer) {
            db.prepare(
              'INSERT INTO supersessions (old_slug, new_slug, note, created) VALUES (?, ?, ?, ?)',
            ).run(oldSlug, input.new_slug, 'slug rename via knowledge_move', timestamp);
            pointersWritten = 1;
          }
        }
        if (input.new_domain) {
          // Address the row by its current slug after the possible rename.
          const currentSlug = input.new_slug ?? oldSlug;
          db.prepare('UPDATE pages SET domain = ?, updated = ? WHERE slug = ?').run(
            input.new_domain, timestamp, currentSlug,
          );
        }
      });
      retryWrite(() => tx.immediate());

      return Promise.resolve({
        moved: 1,
        pages: [{
          slug: input.new_slug ?? oldSlug,
          old_slug: input.new_slug ? oldSlug : undefined,
          old_domain: oldDomain,
          new_domain: input.new_domain ?? oldDomain,
        }],
        pointers_written: pointersWritten,
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  mergePages(input: KnowledgeMergeInput): Promise<KnowledgeMergeResult> {
    try {
      const db = this.ensureOpen();

      if (!input.source_slugs || input.source_slugs.length === 0) {
        return Promise.reject(new Error('mergePages: source_slugs must not be empty'));
      }

      type PageRow = { id: number; body: string; verified_at: string | null; freshness_anchor: string | null };
      type SourceRow = PageRow & { slug: string };

      const targetRow = db.prepare(
        'SELECT id, body, verified_at, freshness_anchor FROM pages WHERE slug = ?',
      ).get(input.target_slug) as PageRow | undefined;

      if (!targetRow) {
        return Promise.reject(new Error(`mergePages: target page not found: ${input.target_slug}`));
      }

      const sourceRows: SourceRow[] = [];
      for (const slug of input.source_slugs) {
        if (slug === input.target_slug) {
          return Promise.reject(new Error(
            `mergePages: source_slug '${slug}' is the same as target_slug — cannot merge a page into itself`,
          ));
        }
        const row = db.prepare(
          'SELECT id, slug, body, verified_at, freshness_anchor FROM pages WHERE slug = ?',
        ).get(slug) as SourceRow | undefined;
        if (!row) {
          return Promise.reject(new Error(`mergePages: source page not found: ${slug}`));
        }
        sourceRows.push(row);
      }

      const timestamp = new Date().toISOString();

      // MAX(verified_at) across all pages; null when all are unverified.
      const allVerifiedAts = [targetRow.verified_at, ...sourceRows.map((r) => r.verified_at)]
        .filter((v): v is string => v != null);
      const maxVerifiedAt: string | null = allVerifiedAts.length > 0
        ? allVerifiedAts.reduce((max, v) => (v > max ? v : max))
        : null;

      // freshness_anchor: keep target's; fall back to first non-null source's.
      let freshnessAnchor = targetRow.freshness_anchor;
      if (!freshnessAnchor) {
        for (const row of sourceRows) {
          if (row.freshness_anchor) {
            freshnessAnchor = row.freshness_anchor;
            break;
          }
        }
      }

      // Capture loser bodies before the transaction (returned in result).
      const losers = sourceRows.map((r) => ({ slug: r.slug, body: r.body }));

      let citationsMoved = 0;
      let citationsDeduped = 0;

      const tx = db.transaction(() => {
        for (const source of sourceRows) {
          // Count total source citations before dedup. (Within the transaction,
          // reads are consistent with the write lock we hold.)
          const before = (db.prepare(
            'SELECT COUNT(*) as count FROM citations WHERE page_id = ?',
          ).get(source.id) as { count: number }).count;

          // Delete source citations that are identical to existing target citations.
          db.prepare(`
            DELETE FROM citations
            WHERE page_id = ?
              AND EXISTS (
                SELECT 1 FROM citations c2
                WHERE c2.page_id = ?
                  AND c2.claim = citations.claim
                  AND c2.source_kind = citations.source_kind
                  AND COALESCE(c2.source_locator, '') = COALESCE(citations.source_locator, '')
                  AND c2.excerpt = citations.excerpt
              )
          `).run(source.id, targetRow.id);

          const after = (db.prepare(
            'SELECT COUNT(*) as count FROM citations WHERE page_id = ?',
          ).get(source.id) as { count: number }).count;

          citationsDeduped += before - after;

          // Re-parent remaining source citations to target.
          db.prepare('UPDATE citations SET page_id = ? WHERE page_id = ?').run(targetRow.id, source.id);
          citationsMoved += after;
        }

        // Update target: verified_at, freshness_anchor, updated.
        db.prepare(
          'UPDATE pages SET verified_at = ?, freshness_anchor = ?, updated = ? WHERE id = ?',
        ).run(maxVerifiedAt, freshnessAnchor ?? null, timestamp, targetRow.id);

        // Optionally append loser bodies to target body.
        if (input.append_loser_bodies) {
          let appendedBody = targetRow.body;
          for (const loser of losers) {
            appendedBody += `\n\n--- merged from ${loser.slug} ---\n\n${loser.body}`;
          }
          enforcePageBodyCap(appendedBody);
          db.prepare('UPDATE pages SET body = ? WHERE id = ?').run(appendedBody, targetRow.id);
        }

        // Archive each source and record the supersession.
        for (const source of sourceRows) {
          const tombstoneNote = input.note
            ? `Merged into ${input.target_slug}. ${input.note}`
            : `Merged into ${input.target_slug}.`;

          db.prepare(
            "UPDATE pages SET status = 'archived', tombstone_note = ?, updated = ? WHERE id = ?",
          ).run(tombstoneNote, timestamp, source.id);

          db.prepare(
            'INSERT INTO supersessions (old_slug, new_slug, note, created) VALUES (?, ?, ?, ?)',
          ).run(source.slug, input.target_slug, input.note ?? null, timestamp);
        }

        // hard_delete_losers: archive first (supersession pointer written above), then DELETE.
        // Citations cascade via FK ON DELETE CASCADE; supersession rows survive (plain TEXT refs, no FK).
        if (input.hard_delete_losers) {
          for (const source of sourceRows) {
            db.prepare('DELETE FROM pages WHERE id = ?').run(source.id);
          }
        }
      });
      retryWrite(() => tx.immediate());

      return Promise.resolve({
        target_slug: input.target_slug,
        sources_merged: sourceRows.length,
        citations_moved: citationsMoved,
        citations_deduped: citationsDeduped,
        verified_at: maxVerifiedAt,
        losers,
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  purgePages(input: KnowledgePurgeInput): Promise<KnowledgePurgeResult> {
    try {
      const db = this.ensureOpen();

      if (!input.slugs || input.slugs.length === 0) {
        return Promise.reject(new Error('purgePages: slugs must not be empty'));
      }

      if (input.confirm !== true) {
        return Promise.reject(new Error('purgePages: confirm must be explicitly true'));
      }

      // Validate all slugs before touching the database.
      type PageRow = { id: number; status: string };
      const rows: Array<{ id: number; slug: string }> = [];
      for (const slug of input.slugs) {
        const page = db.prepare(
          'SELECT id, status FROM pages WHERE slug = ?',
        ).get(slug) as PageRow | undefined;

        if (!page) {
          return Promise.reject(new Error(`purgePages: page not found: ${slug}`));
        }
        if (page.status !== 'archived') {
          return Promise.reject(new Error(
            `purgePages: page '${slug}' is not archived — archive it first before purging`,
          ));
        }
        rows.push({ id: page.id, slug });
      }

      // All checks passed — delete in a single transaction.
      // Citations cascade via FK ON DELETE CASCADE.
      // Supersession rows survive (plain TEXT refs, no FK).
      const tx = db.transaction(() => {
        for (const row of rows) {
          db.prepare('DELETE FROM pages WHERE id = ?').run(row.id);
        }
      });
      retryWrite(() => tx.immediate());

      return Promise.resolve({ purged: input.slugs.length, slugs: input.slugs });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  verifyPages(input: KnowledgeVerifyInput): Promise<KnowledgeVerifyResult> {
    try {
      const db = this.ensureOpen();
      const timestamp = new Date().toISOString();
      const verifiedAt = input.verified_at ?? timestamp;

      const single = input.slug !== undefined;
      const batch = input.slugs !== undefined;
      if (single === batch) {
        return Promise.reject(new Error(
          'verifyPages: provide exactly one of slug (single) or slugs (batch)',
        ));
      }
      if (batch && (input.note !== undefined || input.freshness_anchor !== undefined)) {
        return Promise.reject(new Error(
          'verifyPages: note and freshness_anchor are single-page options — not allowed in batch mode',
        ));
      }

      const slugs = single ? [input.slug!] : input.slugs!;
      if (slugs.length === 0) {
        return Promise.reject(new Error('verifyPages: slugs must not be empty'));
      }

      // Validate every slug before stamping anything — no partial batches.
      type PageRow = { id: number; status: string; body: string };
      const rows: Array<{ id: number; slug: string; body: string }> = [];
      for (const slug of slugs) {
        const page = db.prepare(
          'SELECT id, status, body FROM pages WHERE slug = ?',
        ).get(slug) as PageRow | undefined;

        if (!page) {
          return Promise.reject(new Error(`verifyPages: page not found: ${slug}`));
        }
        if (page.status === 'archived') {
          return Promise.reject(new Error(
            `verifyPages: page '${slug}' is archived — restore it before verifying`,
          ));
        }
        rows.push({ id: page.id, slug, body: page.body });
      }

      let noted = false;
      const tx = db.transaction(() => {
        for (const row of rows) {
          db.prepare(
            'UPDATE pages SET verified_at = ?, freshness_anchor = COALESCE(?, freshness_anchor) WHERE id = ?',
          ).run(verifiedAt, input.freshness_anchor ?? null, row.id);

          if (input.note) {
            const dateLabel = verifiedAt.slice(0, 10);
            const newBody = `${row.body}\n\n## Verification — ${dateLabel}\n\n${input.note}`;
            enforcePageBodyCap(newBody);
            // A note changes the body, so it bumps `updated` — a pure stamp
            // deliberately does not (updated means "content changed").
            db.prepare(
              'UPDATE pages SET body = ?, updated = ? WHERE id = ?',
            ).run(newBody, timestamp, row.id);
            noted = true;
          }
        }
      });
      retryWrite(() => tx.immediate());

      return Promise.resolve({
        verified: rows.length,
        slugs: rows.map((r) => r.slug),
        verified_at: verifiedAt,
        noted,
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  listRevisions(slug: string): Promise<KnowledgeRevisionMeta[]> {
    try {
      const db = this.ensureOpen();

      const page = db.prepare('SELECT id FROM pages WHERE slug = ?').get(slug) as
        | { id: number }
        | undefined;
      if (!page) {
        return Promise.reject(new Error(`listRevisions: page not found: ${slug}`));
      }

      const rows = db.prepare(
        `SELECT id, page_id, slug, op, replaced_at, LENGTH(body) AS body_length
         FROM page_revisions WHERE page_id = ? ORDER BY id DESC`,
      ).all(page.id) as KnowledgeRevisionMeta[];

      return Promise.resolve(rows);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  getRevision(revisionId: number): Promise<KnowledgeRevision | null> {
    try {
      const db = this.ensureOpen();
      const row = db.prepare(
        'SELECT id, page_id, slug, op, replaced_at, body FROM page_revisions WHERE id = ?',
      ).get(revisionId) as KnowledgeRevision | undefined;
      return Promise.resolve(row ?? null);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  restoreRevision(input: KnowledgeRevisionRestoreInput): Promise<KnowledgeRevisionRestoreResult> {
    try {
      const db = this.ensureOpen();
      const timestamp = new Date().toISOString();

      const page = db.prepare(
        'SELECT id, body FROM pages WHERE slug = ?',
      ).get(input.slug) as { id: number; body: string } | undefined;
      if (!page) {
        return Promise.reject(new Error(`restoreRevision: page not found: ${input.slug}`));
      }

      const revision = db.prepare(
        'SELECT id, page_id, body FROM page_revisions WHERE id = ?',
      ).get(input.revision_id) as { id: number; page_id: number; body: string } | undefined;
      if (!revision) {
        return Promise.reject(new Error(`restoreRevision: revision not found: ${input.revision_id}`));
      }
      if (revision.page_id !== page.id) {
        return Promise.reject(new Error(
          `restoreRevision: revision ${input.revision_id} belongs to a different page than '${input.slug}'`,
        ));
      }

      let snapshotId = 0;
      const tx = db.transaction(() => {
        // The body being displaced is itself preserved — a restore must
        // never be the second irreversible overwrite in the story.
        snapshotId = this.snapshotRevision(db, page.id, input.slug, page.body, 'history-restore', timestamp);
        db.prepare('UPDATE pages SET body = ?, updated = ? WHERE id = ?').run(
          revision.body, timestamp, page.id,
        );
      });
      retryWrite(() => tx.immediate());

      return Promise.resolve({
        slug: input.slug,
        revision_id: input.revision_id,
        restored: true,
        snapshot_id: snapshotId,
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Insert a body snapshot and prune beyond the per-page cap. Always called
   * inside a transaction owned by the caller (writePage or restoreRevision).
   * The inner retryWrite calls run bare statements — safe inside an outer
   * transaction; the outer transaction is the atomicity boundary.
   */
  private snapshotRevision(
    db: Database,
    pageId: number,
    slug: string,
    body: string,
    op: string,
    timestamp: string,
  ): number {
    const result = retryWrite(() =>
      db.prepare(
        'INSERT INTO page_revisions (page_id, slug, body, op, replaced_at) VALUES (?, ?, ?, ?, ?)',
      ).run(pageId, slug, body, op, timestamp),
    );
    retryWrite(() =>
      db.prepare(
        `DELETE FROM page_revisions WHERE page_id = ? AND id NOT IN (
           SELECT id FROM page_revisions WHERE page_id = ? ORDER BY id DESC LIMIT ?
         )`,
      ).run(pageId, pageId, MAX_REVISIONS_PER_PAGE),
    );
    return Number(result.lastInsertRowid);
  }

  addCitations(slug: string, citations: KnowledgeCitationInput[]): Promise<number> {
    try {
      const db = this.ensureOpen();

      const page = db.prepare(
        'SELECT id FROM pages WHERE slug = ?',
      ).get(slug) as { id: number } | undefined;

      if (!page) {
        throw new Error(`addCitations: page not found: ${slug}`);
      }

      const timestamp = new Date().toISOString();
      let added = 0;

      const insert = db.prepare(
        `INSERT INTO citations (page_id, claim, source_kind, source_locator, excerpt, retrieved_at, created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      const tx = db.transaction(() => {
        for (const cit of citations) {
          enforceExcerptCap(cit.excerpt);
          insert.run(
            page.id,
            cit.claim,
            cit.source_kind,
            cit.source_locator ?? null,
            cit.excerpt,
            timestamp,
            timestamp,
          );
          added++;
        }
      });
      retryWrite(() => tx.immediate());

      return Promise.resolve(added);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ── Internals ──

  private ensureOpen(): Database {
    if (!this.db) {
      throw new Error('KnowledgeBackend is already closed');
    }
    return this.db;
  }

  private fetchCitationsForPage(db: Database, pageId: number): KnowledgeCitation[] {
    return db.prepare(
      'SELECT * FROM citations WHERE page_id = ? ORDER BY id',
    ).all(pageId) as KnowledgeCitation[];
  }

  private initSchema(): void {
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
        freshness_anchor TEXT
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
      `CREATE TABLE IF NOT EXISTS page_revisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        slug        TEXT NOT NULL,
        body        TEXT NOT NULL,
        op          TEXT NOT NULL,
        replaced_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id)`,
    ];
    for (const sql of statements) {
      this.db!.prepare(sql).run();
    }
    // Idempotent migrations for existing DBs (ALTER ADD COLUMN has no IF NOT EXISTS).
    const pageCols = (this.db!.prepare('PRAGMA table_info(pages)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!pageCols.includes('verified_at')) {
      this.db!.prepare('ALTER TABLE pages ADD COLUMN verified_at TEXT').run();
    }
    if (!pageCols.includes('freshness_anchor')) {
      this.db!.prepare('ALTER TABLE pages ADD COLUMN freshness_anchor TEXT').run();
    }
    if (!pageCols.includes('tombstone_note')) {
      this.db!.prepare('ALTER TABLE pages ADD COLUMN tombstone_note TEXT').run();
    }
    // ours/ class metadata (t-81, 2026-08-31).
    if (!pageCols.includes('created_by')) {
      this.db!.prepare('ALTER TABLE pages ADD COLUMN created_by TEXT').run();
    }
    if (!pageCols.includes('version')) {
      this.db!.prepare('ALTER TABLE pages ADD COLUMN version TEXT').run();
    }
  }
}

// ── Helpers ──

function enforcePageBodyCap(body: string): void {
  if (body.length > MAX_PAGE_BODY_LENGTH) {
    throw new Error(
      `Page body exceeds hard cap of ${MAX_PAGE_BODY_LENGTH} characters ` +
      `(got ${body.length}). The knowledge backend enforces a size limit to bound memory and disk usage.`,
    );
  }
}

function enforceExcerptCap(excerpt: string): void {
  if (excerpt.length > MAX_CITATION_EXCERPT_LENGTH) {
    throw new Error(
      `Citation excerpt exceeds hard cap of ${MAX_CITATION_EXCERPT_LENGTH} characters ` +
      `(got ${excerpt.length}).`,
    );
  }
}
