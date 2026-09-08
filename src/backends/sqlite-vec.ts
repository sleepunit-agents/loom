/**
 * SQLite + sqlite-vec memory backend.
 *
 * A single file holds all memories plus their embedding vectors.
 * No external service, no daemon. Portable to any machine with Node.
 *
 * Schema:
 *   memories       — regular table, one row per memory (payload, TTL, etc.)
 *   vec_memories   — sqlite-vec virtual table, rowid = memories.id
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type {
  MemoryBackend,
  MemoryInput,
  MemoryRef,
  RecallInput,
  MemoryMatch,
  ForgetInput,
  ForgetResult,
  UpdateInput,
  UpdateResult,
  PruneResult,
  ListInput,
  MemoryEntry,
  EmbeddingProvider,
  FindSimilarInput,
  AuditOptions,
  AuditReport,
  AuditStaleEntry,
  DuplicatePair,
  ArchiveInput,
  ArchiveResult,
  RestoreInput,
  RestoreResult,
  RecallObservation,
  MemoryRevisionMeta,
  MemoryRevision,
  MemoryRevisionRestoreInput,
  MemoryRevisionRestoreResult,
  MemorySupersededInput,
  MemorySupersededResult,
} from './types.js';
import { computeExpiresAt, isExpired } from './ttl.js';
import { mmrSelect, DEFAULT_DIVERSITY } from './mmr.js';
import { globToMatcher } from './glob.js';
import { runMigrations } from './migrations.js';
import { retryWrite } from './retry.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export interface SqliteVecConfig {
  /** Absolute path to the SQLite database file */
  dbPath: string;
  /**
   * Observer for the recall observation log. Called once per recall with
   * the search's telemetry; errors it throws are swallowed — a failed
   * observation never fails a search.
   */
  onRecall?: (obs: RecallObservation) => void;
}

/** Body snapshots retained per memory; oldest pruned beyond this cap (mirrors knowledge wing). */
const MAX_REVISIONS_PER_MEMORY = 10;

interface MemoryRow {
  id: number;
  uuid: string;
  ref: string;
  title: string;
  category: string;
  project: string | null;
  content: string;
  metadata: string;
  created: string;
  updated: string | null;
  last_accessed: string | null;
  ttl: string | null;
  expires_at: string | null;
  archived: number;
  archive_note: string | null;
}

interface VecMatch {
  rowid: number;
  distance: number;
}

export class SqliteVecBackend implements MemoryBackend {
  private readonly db: Database;

  constructor(
    private readonly config: SqliteVecConfig,
    private readonly embedder: EmbeddingProvider,
  ) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new BetterSqlite3(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    // Single-writer (c-loom-strictness §single-writer): WAL admits one writer at
    // a time; busy_timeout = 0 makes a second concurrent writer FAIL FAST with
    // SQLITE_BUSY rather than block for the better-sqlite3 default 5s. loom is
    // synchronous with one connection per call, so this never bites the daemon
    // itself — only a genuine second writer (e.g. a stray second instance) is
    // refused, which is exactly the guarantee. No torn write, no silent race.
    this.db.pragma('busy_timeout = 0');
    sqliteVec.load(this.db);
    this.initSchema();
  }

  // ── MemoryBackend interface ──

  async remember(input: MemoryInput): Promise<MemoryRef> {
    const uuid = randomUUID();
    const timestamp = new Date().toISOString();
    const slug = slugify(input.title);
    const ref = `${input.category}/${slug}-${uuid.slice(0, 8)}`;
    const expiresAt = computeExpiresAt(timestamp, input.ttl);

    const vector = await this.embedder.embed(`${input.title}\n\n${input.content}`);

    const insertMem = this.db.prepare(`
      INSERT INTO memories (
        uuid, ref, title, category, project, content, metadata,
        created, ttl, expires_at, salience
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVec = this.db.prepare(
      'INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)',
    );

    const tx = this.db.transaction(() => {
      const result = insertMem.run(
        uuid,
        ref,
        input.title,
        input.category,
        input.project ?? null,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        input.ttl ?? null,
        expiresAt,
        1.0, // a freshly authored memory is hot; the lane decays it from here
      );
      insertVec.run(BigInt(result.lastInsertRowid), toVecBuffer(vector));
    });
    retryWrite(() => tx());

    return {
      ref,
      category: input.category,
      filename: `${slug}-${uuid.slice(0, 8)}`,
      title: input.title,
    };
  }

  async recall(input: RecallInput): Promise<MemoryMatch[]> {
    const startedAt = performance.now();
    const limit = input.limit ?? 10;
    const diversity = clamp01(input.diversity ?? DEFAULT_DIVERSITY);

    const queryVector = await (this.embedder.embedQuery?.(input.query) ??
      this.embedder.embed(input.query));

    const categoryFilter =
      input.category && input.category !== 'all' ? input.category : null;
    const projectFilter = input.project ?? null;

    // With diversity on, over-fetch a candidate pool so MMR has something to
    // trade off. At diversity 0 this is exactly the pre-MMR search: pool == limit.
    const poolSize = diversity > 0 ? Math.max(limit * 3, 12) : limit;
    const candidates = this.searchVectors(queryVector, poolSize, poolSize * 4, (mem) => {
      if (categoryFilter && mem.category !== categoryFilter) return false;
      if (projectFilter && mem.project !== projectFilter) return false;
      return true;
    });

    // MMR only re-orders/selects among candidates that already passed the
    // filters; with <= limit candidates it returns them in relevance order.
    let hits = candidates;
    let diversityDrops = 0;
    if (diversity > 0 && candidates.length > limit) {
      const vectors = this.loadVectors(candidates.map((c) => c.mem.id));
      const pool = candidates.map((hit) => ({
        hit,
        relevance: 1 - hit.distance,
        vector: vectors.get(hit.mem.id) ?? EMPTY_VECTOR,
      }));
      const picked = mmrSelect(pool, limit, diversity);
      hits = picked.selected.map((c) => c.hit);
      diversityDrops = picked.diversityDrops;
    }

    const results = hits.map((h) => rowToMatch(h.mem, h.distance));
    const hitIds = hits.map((h) => h.mem.id);

    if (hitIds.length > 0) {
      const now = new Date().toISOString();
      const stamp = this.db.prepare(
        'UPDATE memories SET last_accessed = ? WHERE id = ?',
      );
      const tx = this.db.transaction((ids: number[]) => {
        for (const id of ids) stamp.run(now, id);
      });
      retryWrite(() => tx(hitIds));
    }

    this.observeRecall({
      ts: new Date().toISOString(),
      tool: 'recall',
      query: input.query,
      category: categoryFilter ?? undefined,
      project: projectFilter ?? undefined,
      limit,
      diversity,
      candidates: candidates.length,
      returned: results.length,
      topScore: results.length > 0 ? results[0].relevance : null,
      threshold: null,
      diversityDrops,
      latencyMs: Math.round(performance.now() - startedAt),
      hit: results.length > 0,
    });

    return results;
  }

  async forget(input: ForgetInput): Promise<ForgetResult> {
    if (input.ref) {
      const row = this.db
        .prepare('SELECT id, ref FROM memories WHERE ref = ?')
        .get(input.ref) as { id: number; ref: string } | undefined;
      if (!row) return { deleted: [] };
      this.deleteById([row.id]);
      return { deleted: [row.ref] };
    }

    if (input.category && input.title && !input.title_pattern) {
      const rows = this.db
        .prepare(
          'SELECT id, ref FROM memories WHERE category = ? AND title = ?',
        )
        .all(input.category, input.title) as { id: number; ref: string }[];
      if (rows.length === 0) return { deleted: [] };
      this.deleteById(rows.map((r) => r.id));
      return { deleted: rows.map((r) => r.ref) };
    }

    const clauses: string[] = [];
    const params: string[] = [];
    if (input.category) {
      clauses.push('category = ?');
      params.push(input.category);
    }
    if (input.project) {
      clauses.push('project = ?');
      params.push(input.project);
    }
    if (clauses.length === 0) return { deleted: [] };

    const all = this.db
      .prepare(
        `SELECT id, ref, title FROM memories WHERE ${clauses.join(' AND ')}`,
      )
      .all(...params) as { id: number; ref: string; title: string }[];

    let targets = all;
    if (input.title_pattern) {
      const matcher = globToMatcher(input.title_pattern);
      targets = all.filter((r) => matcher(r.title));
    }

    if (targets.length === 0) return { deleted: [] };
    this.deleteById(targets.map((r) => r.id));
    return { deleted: targets.map((r) => r.ref) };
  }

  async update(input: UpdateInput): Promise<UpdateResult> {
    let row: MemoryRow | undefined;
    if (input.ref) {
      row = this.db
        .prepare('SELECT * FROM memories WHERE ref = ?')
        .get(input.ref) as MemoryRow | undefined;
    } else if (input.category && input.title) {
      row = this.db
        .prepare('SELECT * FROM memories WHERE category = ? AND title = ?')
        .get(input.category, input.title) as MemoryRow | undefined;
    } else {
      return { updated: false };
    }

    if (!row) return { updated: false };

    const newContent = input.content ?? row.content;
    const existingMeta = JSON.parse(row.metadata) as Record<string, unknown>;
    const newMeta = input.metadata
      ? { ...existingMeta, ...input.metadata }
      : existingMeta;
    const updatedAt = new Date().toISOString();

    const updateStmt = this.db.prepare(`
      UPDATE memories
      SET content = ?, metadata = ?, updated = ?
      WHERE id = ?
    `);
    const updateVec = this.db.prepare(
      'UPDATE vec_memories SET embedding = ? WHERE rowid = ?',
    );

    const vector = await this.embedder.embed(`${row.title}\n\n${newContent}`);

    // Snapshot the current body before overwriting — same protection the knowledge
    // wing added after the 2026-06-01 verify run stomped 13 pages with no recovery.
    // Only snapshot when content actually changes to avoid noise in the history.
    let snapshotId: number | undefined;
    if (input.content !== undefined && input.content !== row.content) {
      snapshotId = this.snapshotRevision(row.id, row.ref, row.content, 'update', updatedAt);
    }

    const tx = this.db.transaction(() => {
      updateStmt.run(newContent, JSON.stringify(newMeta), updatedAt, row!.id);
      updateVec.run(toVecBuffer(vector), BigInt(row!.id));
    });
    retryWrite(() => tx());

    return { updated: true, ref: row.ref, snapshotId };
  }

  async prune(options?: {
    dryRun?: boolean;
    staleDays?: number;
  }): Promise<PruneResult> {
    const dryRun = options?.dryRun ?? false;
    const staleDays = options?.staleDays ?? 30;
    const now = new Date();
    const staleThreshold = new Date(
      now.getTime() - staleDays * 24 * 60 * 60 * 1000,
    );

    const rows = this.db
      .prepare(
        `SELECT id, ref, ttl, expires_at, last_accessed, updated, created
         FROM memories WHERE archived = 0`,
      )
      .all() as {
      id: number;
      ref: string;
      ttl: string | null;
      expires_at: string | null;
      last_accessed: string | null;
      updated: string | null;
      created: string;
    }[];

    const expired: string[] = [];
    const stale: string[] = [];
    const expiredIds: number[] = [];

    for (const r of rows) {
      if (r.expires_at && isExpired(r.expires_at, now)) {
        expired.push(r.ref);
        expiredIds.push(r.id);
        continue;
      }
      if (r.ttl === 'permanent') continue;
      const lastTouch = r.last_accessed ?? r.updated ?? r.created;
      if (new Date(lastTouch) < staleThreshold) {
        stale.push(r.ref);
      }
    }

    if (!dryRun && expiredIds.length > 0) {
      // Archive instead of hard-delete: content is preserved for recovery,
      // the embedding is dropped (no KNN slots wasted), archived = 1 hides
      // the row from recall/list/audit — matching the contract in t-332.
      const now = new Date().toISOString();
      const tombstone = JSON.stringify({ note: 'TTL elapsed', archived_at: now });
      const archiveStmt = this.db.prepare(
        'UPDATE memories SET archived = 1, archive_note = ?, updated = ? WHERE id = ?',
      );
      const delVec = this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?');
      const tx = this.db.transaction(() => {
        for (const id of expiredIds) {
          archiveStmt.run(tombstone, now, id);
          delVec.run(BigInt(id));
        }
      });
      retryWrite(() => tx());
    }

    return { expired, stale };
  }

  async list(input: ListInput): Promise<MemoryEntry[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.category) {
      clauses.push('category = ?');
      params.push(input.category);
    }
    if (input.project) {
      clauses.push('project = ?');
      params.push(input.project);
    }
    clauses.push('archived = 0');
    const where = `WHERE ${clauses.join(' AND ')}`;
    params.push(input.limit ?? 50);

    const rows = this.db
      .prepare(
        `SELECT ref, title, category, project, created
         FROM memories ${where}
         ORDER BY created DESC LIMIT ?`,
      )
      .all(...params) as {
      ref: string;
      title: string;
      category: string;
      project: string | null;
      created: string;
    }[];

    return rows.map((r) => ({
      ref: r.ref,
      title: r.title,
      category: r.category,
      project: r.project ?? undefined,
      created: r.created,
    }));
  }

  async findSimilar(input: FindSimilarInput): Promise<MemoryMatch[]> {
    if (!input.ref && !input.text) {
      throw new Error('findSimilar requires either ref or text');
    }

    let anchorId: number | null = null;
    let queryVector: number[];

    if (input.ref) {
      const row = this.db
        .prepare('SELECT id FROM memories WHERE ref = ?')
        .get(input.ref) as { id: number } | undefined;
      if (!row) throw new Error(`findSimilar: memory not found: ${input.ref}`);
      anchorId = row.id;
      const vecRow = this.db
        .prepare('SELECT embedding FROM vec_memories WHERE rowid = ?')
        .get(BigInt(row.id)) as { embedding: Buffer } | undefined;
      if (!vecRow) throw new Error(`findSimilar: embedding missing for ${input.ref}`);
      queryVector = Array.from(new Float32Array(
        vecRow.embedding.buffer,
        vecRow.embedding.byteOffset,
        vecRow.embedding.byteLength / 4,
      ));
    } else {
      queryVector = await (this.embedder.embedQuery?.(input.text!) ??
        this.embedder.embed(input.text!));
    }

    const limit = input.limit ?? 10;
    const minRelevance = input.minRelevance ?? 0;
    const categoryFilter = input.category ?? null;
    const projectFilter = input.project ?? null;

    // Over-fetch so filters + self-exclusion don't starve the result set.
    const startK = Math.max((limit + 1) * 4, 16);

    const hits = this.searchVectors(queryVector, limit, startK, (mem, vr) => {
      if (anchorId !== null && vr.rowid === anchorId) return false;
      if (categoryFilter && mem.category !== categoryFilter) return false;
      if (projectFilter && (mem.project ?? null) !== projectFilter) return false;
      if (1 - vr.distance < minRelevance) return false;
      return true;
    });

    return hits.map((h) => rowToMatch(h.mem, h.distance));
  }

  async audit(options?: AuditOptions): Promise<AuditReport> {
    const staleDays = options?.staleDays ?? 30;
    const similarityThreshold = options?.similarityThreshold ?? 0.85;
    const maxDuplicates = options?.maxDuplicates ?? 20;

    const now = new Date();
    const staleThreshold = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);

    const rows = this.db
      .prepare(
        `SELECT id, ref, title, category, project, ttl, expires_at,
                last_accessed, updated, created
         FROM memories WHERE archived = 0`,
      )
      .all() as (Pick<MemoryRow,
        'id' | 'ref' | 'title' | 'category' | 'project' | 'ttl' |
        'expires_at' | 'last_accessed' | 'updated' | 'created'>)[];

    const byCategory: Record<string, number> = {};
    const stale: AuditStaleEntry[] = [];
    const expired: string[] = [];

    for (const r of rows) {
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
      if (r.expires_at && isExpired(r.expires_at, now)) {
        expired.push(r.ref);
        continue;
      }
      if (r.ttl === 'permanent') continue;
      const lastTouch = r.last_accessed ?? r.updated ?? r.created;
      if (new Date(lastTouch) < staleThreshold) {
        stale.push({
          ref: r.ref,
          title: r.title,
          category: r.category,
          project: r.project ?? undefined,
          lastTouch,
        });
      }
    }

    // Duplicate detection: for each memory, MATCH its stored embedding,
    // take the top non-self neighbour, keep pairs above threshold, dedupe.
    const duplicates: DuplicatePair[] = [];
    const seenPair = new Set<string>();
    const pairKey = (a: number, b: number) =>
      a < b ? `${a}:${b}` : `${b}:${a}`;
    const byIdRow = new Map(rows.map((r) => [r.id, r]));

    const vecStmt = this.db.prepare(
      `SELECT rowid, distance FROM vec_memories
       WHERE embedding MATCH ? AND k = 2
       ORDER BY distance`,
    );

    for (const r of rows) {
      if (duplicates.length >= maxDuplicates) break;
      const stored = this.db
        .prepare('SELECT embedding FROM vec_memories WHERE rowid = ?')
        .get(BigInt(r.id)) as { embedding: Buffer } | undefined;
      if (!stored) continue;
      const hits = vecStmt.all(stored.embedding) as VecMatch[];
      for (const h of hits) {
        if (h.rowid === r.id) continue;
        const relevance = 1 - h.distance;
        if (relevance < similarityThreshold) break;
        const key = pairKey(r.id, h.rowid);
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        const other = byIdRow.get(h.rowid);
        if (!other) continue;
        duplicates.push({
          a: { ref: r.ref, title: r.title },
          b: { ref: other.ref, title: other.title },
          relevance,
        });
        if (duplicates.length >= maxDuplicates) break;
      }
    }

    return {
      totalMemories: rows.length,
      byCategory,
      stale,
      duplicates,
      expired,
    };
  }

  async archive(input: ArchiveInput): Promise<ArchiveResult> {
    let rows: { id: number; ref: string }[] = [];

    if (input.ref) {
      const row = this.db
        .prepare('SELECT id, ref FROM memories WHERE ref = ? AND archived = 0')
        .get(input.ref) as { id: number; ref: string } | undefined;
      if (row) rows = [row];
    } else if (input.category && input.title) {
      rows = this.db
        .prepare('SELECT id, ref FROM memories WHERE category = ? AND title = ? AND archived = 0')
        .all(input.category, input.title) as { id: number; ref: string }[];
    } else {
      return { archived: [] };
    }

    if (rows.length === 0) return { archived: [] };

    const now = new Date().toISOString();
    const tombstone = JSON.stringify({ note: input.note ?? null, archived_at: now });
    const stmt = this.db.prepare(
      'UPDATE memories SET archived = 1, archive_note = ?, updated = ? WHERE id = ?',
    );
    // Drop the embedding so archived rows stop occupying KNN slots.
    // Content stays in `memories`; restore() re-embeds it.
    const delVec = this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?');
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        stmt.run(tombstone, now, row.id);
        delVec.run(BigInt(row.id));
      }
    });
    retryWrite(() => tx());

    return { archived: rows.map((r) => r.ref) };
  }

  async restore(input: RestoreInput): Promise<RestoreResult> {
    type RestoreRow = { id: number; ref: string; title: string; content: string };
    let rows: RestoreRow[] = [];

    if (input.ref) {
      const row = this.db
        .prepare('SELECT id, ref, title, content FROM memories WHERE ref = ? AND archived = 1')
        .get(input.ref) as RestoreRow | undefined;
      if (row) rows = [row];
    } else if (input.category && input.title) {
      rows = this.db
        .prepare('SELECT id, ref, title, content FROM memories WHERE category = ? AND title = ? AND archived = 1')
        .all(input.category, input.title) as RestoreRow[];
    } else {
      return { restored: [] };
    }

    if (rows.length === 0) return { restored: [] };

    // Archive dropped the embedding; rebuild it from the stored content.
    const vectors = await this.embedder.embedBatch(
      rows.map((r) => `${r.title}\n\n${r.content}`),
    );

    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE memories SET archived = 0, archive_note = NULL, updated = ? WHERE id = ?',
    );
    // Delete-then-insert: legacy rows archived before delete-on-archive
    // may still hold a vector, and vec0 rowids must stay unique.
    const delVec = this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?');
    const insVec = this.db.prepare(
      'INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)',
    );
    const tx = this.db.transaction(() => {
      rows.forEach((row, i) => {
        stmt.run(now, row.id);
        delVec.run(BigInt(row.id));
        insVec.run(BigInt(row.id), toVecBuffer(vectors[i]));
      });
    });
    retryWrite(() => tx());

    return { restored: rows.map((r) => r.ref) };
  }

  listRevisions(ref: string): Promise<MemoryRevisionMeta[]> {
    const row = this.db
      .prepare('SELECT id FROM memories WHERE ref = ?')
      .get(ref) as { id: number } | undefined;
    if (!row) return Promise.resolve([]);

    const rows = this.db
      .prepare(
        `SELECT id, memory_id, ref, op, replaced_at, LENGTH(content) AS content_length
         FROM memory_revisions WHERE memory_id = ? ORDER BY id DESC`,
      )
      .all(row.id) as (Omit<MemoryRevisionMeta, 'content_length'> & { content_length: number })[];

    return Promise.resolve(
      rows.map((r) => ({
        id: r.id,
        memory_id: r.memory_id,
        ref: r.ref,
        op: r.op,
        replaced_at: r.replaced_at,
        content_length: r.content_length,
      })),
    );
  }

  getRevision(revisionId: number): Promise<MemoryRevision | null> {
    const row = this.db
      .prepare('SELECT id, memory_id, ref, op, replaced_at, content FROM memory_revisions WHERE id = ?')
      .get(revisionId) as MemoryRevision | undefined;
    return Promise.resolve(row ?? null);
  }

  async restoreRevision(
    input: MemoryRevisionRestoreInput,
  ): Promise<MemoryRevisionRestoreResult> {
    const mem = this.db
      .prepare('SELECT * FROM memories WHERE ref = ?')
      .get(input.ref) as MemoryRow | undefined;
    if (!mem) return { ref: input.ref, revision_id: input.revision_id, restored: false, snapshot_id: 0 };

    const rev = this.db
      .prepare('SELECT id, memory_id, content FROM memory_revisions WHERE id = ?')
      .get(input.revision_id) as { id: number; memory_id: number; content: string } | undefined;
    if (!rev || rev.memory_id !== mem.id) {
      return { ref: input.ref, revision_id: input.revision_id, restored: false, snapshot_id: 0 };
    }

    const timestamp = new Date().toISOString();
    // Snapshot the current body before replacing it.
    const snapshotId = this.snapshotRevision(mem.id, mem.ref, mem.content, 'revision-restore', timestamp);

    const vector = await this.embedder.embed(`${mem.title}\n\n${rev.content}`);

    const updateStmt = this.db.prepare(
      'UPDATE memories SET content = ?, updated = ? WHERE id = ?',
    );
    const updateVec = this.db.prepare(
      'UPDATE vec_memories SET embedding = ? WHERE rowid = ?',
    );
    const tx = this.db.transaction(() => {
      updateStmt.run(rev.content, timestamp, mem.id);
      updateVec.run(toVecBuffer(vector), BigInt(mem.id));
    });
    retryWrite(() => tx());

    return { ref: input.ref, revision_id: input.revision_id, restored: true, snapshot_id: snapshotId };
  }

  supersede(input: MemorySupersededInput): Promise<MemorySupersededResult> {
    const oldRow = this.db
      .prepare('SELECT id, archived FROM memories WHERE ref = ?')
      .get(input.old_ref) as { id: number; archived: number } | undefined;
    if (!oldRow) {
      return Promise.reject(new Error(`supersede: old_ref not found: ${input.old_ref}`));
    }

    const newRow = this.db
      .prepare('SELECT id FROM memories WHERE ref = ?')
      .get(input.new_ref) as { id: number } | undefined;
    if (!newRow) {
      return Promise.reject(new Error(`supersede: new_ref not found: ${input.new_ref}`));
    }

    if (oldRow.archived === 1) {
      // Already retired — record the supersession edge but don't re-archive.
      const timestamp = new Date().toISOString();
      retryWrite(() =>
        this.db
          .prepare(
            'INSERT INTO memory_supersessions (old_ref, new_ref, note, created) VALUES (?, ?, ?, ?)',
          )
          .run(input.old_ref, input.new_ref, input.note ?? null, timestamp),
      );
      return Promise.resolve({ old_ref: input.old_ref, new_ref: input.new_ref, archived: false });
    }

    const timestamp = new Date().toISOString();
    const tombstone = JSON.stringify({
      note: `Superseded by ${input.new_ref}.${input.note ? ' ' + input.note : ''}`,
      archived_at: timestamp,
    });

    const archiveStmt = this.db.prepare(
      'UPDATE memories SET archived = 1, archive_note = ?, updated = ? WHERE id = ?',
    );
    const delVec = this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?');
    const insertSup = this.db.prepare(
      'INSERT INTO memory_supersessions (old_ref, new_ref, note, created) VALUES (?, ?, ?, ?)',
    );

    const tx = this.db.transaction(() => {
      archiveStmt.run(tombstone, timestamp, oldRow.id);
      delVec.run(BigInt(oldRow.id));
      insertSup.run(input.old_ref, input.new_ref, input.note ?? null, timestamp);
    });
    retryWrite(() => tx());

    return Promise.resolve({ old_ref: input.old_ref, new_ref: input.new_ref, archived: true });
  }

  close(): void {
    this.db.close();
  }

  getDatabase(): Database {
    return this.db;
  }

  // ── Internals ──

  /**
   * Insert a content snapshot into memory_revisions and prune beyond the per-memory
   * cap. Mirrors the knowledge wing's snapshotRevision() in sqlite-knowledge.ts.
   */
  private snapshotRevision(
    memoryId: number,
    ref: string,
    content: string,
    op: string,
    timestamp: string,
  ): number {
    const result = retryWrite(() =>
      this.db
        .prepare(
          'INSERT INTO memory_revisions (memory_id, ref, content, op, replaced_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(memoryId, ref, content, op, timestamp),
    );
    retryWrite(() =>
      this.db
        .prepare(
          `DELETE FROM memory_revisions WHERE memory_id = ? AND id NOT IN (
             SELECT id FROM memory_revisions WHERE memory_id = ? ORDER BY id DESC LIMIT ?
           )`,
        )
        .run(memoryId, memoryId, MAX_REVISIONS_PER_MEMORY),
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * KNN search with a growing-k loop.
   *
   * sqlite-vec's KNN returns the k nearest rows regardless of archived
   * status or category/project filters (those live in `memories`, not in
   * the vec table). A single over-fetch can therefore starve the result
   * set when many near neighbours are filtered out — e.g. legacy archived
   * rows whose vectors predate delete-on-archive, or a narrow category.
   *
   * Policy: start at `startK`, multiply by 4 each round, stop when
   * `limit` accepted matches are collected, k has covered every vec row,
   * or a round surfaces no new candidates. Candidates are deduped across
   * rounds; because each round's KNN is distance-ordered and new
   * candidates always rank deeper than already-seen ones, appending
   * preserves global distance order.
   */
  private searchVectors(
    queryVector: number[],
    limit: number,
    startK: number,
    accept: (mem: MemoryRow, vr: VecMatch) => boolean,
  ): { mem: MemoryRow; distance: number }[] {
    const totalVecRows = (
      this.db.prepare('SELECT COUNT(*) AS c FROM vec_memories').get() as {
        c: number;
      }
    ).c;
    if (totalVecRows === 0) return [];

    const knnStmt = this.db.prepare(
      `SELECT rowid, distance FROM vec_memories
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    );
    const queryBuf = toVecBuffer(queryVector);

    const out: { mem: MemoryRow; distance: number }[] = [];
    const seen = new Set<number>();
    let k = Math.max(1, startK);

    for (;;) {
      const vecRows = knnStmt.all(queryBuf, k) as VecMatch[];
      const fresh = vecRows.filter((vr) => !seen.has(vr.rowid));
      if (fresh.length === 0) break;
      for (const vr of fresh) seen.add(vr.rowid);

      const placeholders = fresh.map(() => '?').join(',');
      const memRows = this.db
        .prepare(
          `SELECT * FROM memories WHERE id IN (${placeholders}) AND archived = 0`,
        )
        .all(...fresh.map((vr) => vr.rowid)) as MemoryRow[];
      const byId = new Map(memRows.map((r) => [r.id, r]));

      for (const vr of fresh) {
        const mem = byId.get(vr.rowid);
        if (!mem) continue;
        if (!accept(mem, vr)) continue;
        out.push({ mem, distance: vr.distance });
        if (out.length >= limit) break;
      }

      if (out.length >= limit) break;
      if (k >= totalVecRows) break;
      k = Math.min(k * 4, totalVecRows);
    }

    return out;
  }

  private observeRecall(obs: RecallObservation): void {
    if (!this.config.onRecall) return;
    try {
      this.config.onRecall(obs);
    } catch {
      // Telemetry never fails a search.
    }
  }

  /** Stored embeddings for a set of memory ids (point lookups; pools are small). */
  private loadVectors(ids: number[]): Map<number, Float32Array> {
    const stmt = this.db.prepare(
      'SELECT embedding FROM vec_memories WHERE rowid = ?',
    );
    const out = new Map<number, Float32Array>();
    for (const id of ids) {
      const row = stmt.get(BigInt(id)) as { embedding: Buffer } | undefined;
      if (!row) continue;
      out.set(id, new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ));
    }
    return out;
  }

  private initSchema(): void {
    const statements = [
      `CREATE TABLE IF NOT EXISTS memories (
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
        expires_at    TEXT,
        archived      INTEGER NOT NULL DEFAULT 0,
        archive_note  TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_project  ON memories(project)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_ref      ON memories(ref)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
        embedding float[${this.embedder.dimensions}] distance_metric=cosine
      )`,
    ];
    for (const sql of statements) {
      this.db.prepare(sql).run();
    }
    // Apply pending schema migrations. Throws on failure so a bad migration
    // aborts startup loudly rather than leaving memory half-broken.
    runMigrations(this.db, { strict: true });
  }

  private deleteById(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const delMem = this.db.prepare(
      `DELETE FROM memories WHERE id IN (${placeholders})`,
    );
    const delVec = this.db.prepare(
      `DELETE FROM vec_memories WHERE rowid IN (${placeholders})`,
    );
    const bigIds = ids.map((n) => BigInt(n));
    const tx = this.db.transaction(() => {
      delMem.run(...ids);
      delVec.run(...bigIds);
    });
    retryWrite(() => tx());
  }
}

// ── Helpers ──

const EMPTY_VECTOR: Float32Array = new Float32Array(0);

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return DEFAULT_DIVERSITY;
  return Math.min(1, Math.max(0, x));
}

function toVecBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function rowToMatch(row: MemoryRow, distance: number): MemoryMatch {
  return {
    path: row.ref,
    title: row.title,
    category: row.category,
    project: row.project ?? undefined,
    created: row.created,
    content: row.content,
    relevance: 1 - distance,
    lastAccessed: row.last_accessed ?? undefined,
    ttl: row.ttl ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}
