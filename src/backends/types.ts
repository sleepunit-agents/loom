/**
 * Memory backend types — shared across all backend implementations.
 *
 * These types define the contract between the MCP tool layer and the
 * storage backend. Any backend that implements MemoryBackend can be
 * swapped in; v0.3.1 ships SqliteVecBackend as the single opinion.
 */

// ─── Input / Output Types ────────────────────────────────────────────────────

export interface MemoryInput {
  category: string;
  title: string;
  content: string;
  project?: string;
  metadata?: Record<string, unknown>;
  /** Optional time-to-live. Parsed durations like "7d", "30d", or "permanent". */
  ttl?: string;
}

export interface MemoryRef {
  ref: string;
  category: string;
  filename: string;
  title: string;
}

export interface RecallInput {
  query: string;
  category?: string;
  project?: string;
  limit?: number;
  /**
   * MMR diversity, 0..1 (default 0.3, i.e. λ = 0.7). Re-ranks the candidate
   * pool so near-duplicate memories don't crowd out different ones. 0 keeps
   * the pure relevance ranking.
   */
  diversity?: number;
}

/**
 * One line of the recall observation log (`<contextDir>/telemetry/recall.jsonl`).
 * Local-only: a file in the agent's own context dir, never sent anywhere.
 */
export interface RecallObservation {
  /** ISO timestamp of the search. */
  ts: string;
  tool: 'recall' | 'knowledge_recall';
  /** The query, truncated to 120 chars on write. */
  query: string;
  category?: string;
  project?: string;
  limit: number;
  /** MMR diversity that was applied (0 = plain relevance ranking). */
  diversity: number;
  /** Candidate pool size after filters, before MMR. */
  candidates: number;
  returned: number;
  /** Relevance of the best returned match, null on a miss. */
  topScore: number | null;
  /** Relevance floor applied, if any (recall currently applies none). */
  threshold: number | null;
  /** Top-relevance candidates displaced by MMR. */
  diversityDrops: number;
  latencyMs: number;
  hit: boolean;
}

export interface MemoryMatch {
  path: string;
  title: string;
  category: string;
  project?: string;
  created: string;
  content: string;
  relevance: number;
  /** ISO timestamp of last recall hit, if tracked */
  lastAccessed?: string;
  /** TTL value if set (e.g. "7d", "permanent") */
  ttl?: string;
  /** ISO timestamp when this memory expires, if TTL is set */
  expiresAt?: string;
}

export interface ForgetInput {
  /** Direct reference (category/filename) for single deletion */
  ref?: string;
  /** Find by category + title for single deletion */
  category?: string;
  title?: string;
  /** Bulk: delete all memories in this project */
  project?: string;
  /** Bulk: delete memories whose title matches this pattern.
   *  Supports glob-style `*` wildcards: "Forgejo sweep*" matches any title
   *  starting with "Forgejo sweep". Requires category or project as a scope guard. */
  title_pattern?: string;
}

export interface UpdateInput {
  /** Direct reference (category/filename) from remember's return value */
  ref?: string;
  /** Alternative: find by category + title */
  category?: string;
  title?: string;
  /** New content (replaces body, preserves frontmatter fields unless overridden) */
  content?: string;
  /** Metadata fields to add or update */
  metadata?: Record<string, unknown>;
}

export interface ForgetResult {
  /** Refs that were successfully deleted */
  deleted: string[];
}

export interface ArchiveInput {
  /** Direct reference (category/filename) for single archive */
  ref?: string;
  /** Find by category + title for single archive */
  category?: string;
  title?: string;
  /** Tombstone note: who/why retired. Stored alongside the original body. */
  note?: string;
}

export interface ArchiveResult {
  /** Refs that were successfully archived (soft-retired) */
  archived: string[];
}

export interface RestoreInput {
  /** Direct reference (category/filename) to restore */
  ref?: string;
  /** Find by category + title */
  category?: string;
  title?: string;
}

export interface RestoreResult {
  /** Refs that were successfully restored to the active set */
  restored: string[];
}

export interface UpdateResult {
  /** Whether the update was applied */
  updated: boolean;
  /** The ref of the updated memory (when found) */
  ref?: string;
  /** Id of the body snapshot taken before content was overwritten (if any). */
  snapshotId?: number;
}

// ─── Memory Revision Types ───────────────────────────────────────────────────

/** Revision listing entry — metadata only, no body payload. */
export interface MemoryRevisionMeta {
  id: number;
  memory_id: number;
  /** Ref the memory had when the snapshot was taken. */
  ref: string;
  /** What displaced this body: 'update' or 'revision-restore'. */
  op: string;
  replaced_at: string;
  content_length: number;
}

export interface MemoryRevision extends Omit<MemoryRevisionMeta, 'content_length'> {
  content: string;
}

export interface MemoryRevisionRestoreInput {
  ref: string;
  revision_id: number;
}

export interface MemoryRevisionRestoreResult {
  ref: string;
  revision_id: number;
  restored: boolean;
  /** Id of the snapshot taken of the body that was just displaced. */
  snapshot_id: number;
}

// ─── Memory Supersession Types ───────────────────────────────────────────────

export interface MemorySupersededInput {
  /** Ref of the memory being retired (the loser / stale version). */
  old_ref: string;
  /** Ref of the memory replacing it (the canonical version). */
  new_ref: string;
  /** Optional note explaining why this supersession happened. */
  note?: string;
}

export interface MemorySupersededResult {
  old_ref: string;
  new_ref: string;
  /** True when old_ref was archived by this call; false if already archived. */
  archived: boolean;
}

export interface PruneResult {
  /** Memories that were archived (moved to archive tier) because their TTL expired */
  expired: string[];
  /** Memories that haven't been accessed within the stale threshold */
  stale: string[];
}

export interface ListInput {
  category?: string;
  project?: string;
  limit?: number;
}

export interface MemoryEntry {
  ref: string;
  title: string;
  category: string;
  project?: string;
  created: string;
}

export interface FindSimilarInput {
  /** Anchor on an existing memory's embedding. Exactly one of `ref`/`text`. */
  ref?: string;
  /** Or anchor on fresh text — embedded on the fly. */
  text?: string;
  /** Max neighbours to return (default 10). */
  limit?: number;
  /** Restrict candidates to a category. */
  category?: string;
  /** Restrict candidates to a project. */
  project?: string;
  /** Filter out matches below this cosine similarity (0..1). */
  minRelevance?: number;
}

export interface DuplicatePair {
  a: { ref: string; title: string };
  b: { ref: string; title: string };
  relevance: number;
}

export interface AuditOptions {
  /** Stale threshold in days (last_accessed/updated/created). Default 30. */
  staleDays?: number;
  /** Cosine-similarity floor for duplicate pairs (0..1). Default 0.85. */
  similarityThreshold?: number;
  /** Max duplicate pairs to surface. Default 20. */
  maxDuplicates?: number;
}

export interface AuditStaleEntry {
  ref: string;
  title: string;
  category: string;
  project?: string;
  /** ISO timestamp of last_accessed, falling back to updated, then created. */
  lastTouch: string;
}

export interface AuditReport {
  totalMemories: number;
  byCategory: Record<string, number>;
  /** Memories not touched within `staleDays`, excluding TTL=permanent. */
  stale: AuditStaleEntry[];
  /** Pairs of memories whose vector similarity ≥ `similarityThreshold`. */
  duplicates: DuplicatePair[];
  /** Memories whose TTL has expired (would be archived by `prune`). */
  expired: string[];
}

// ─── Backend Interface ───────────────────────────────────────────────────────

export interface MemoryBackend {
  remember(input: MemoryInput): Promise<MemoryRef>;
  recall(input: RecallInput): Promise<MemoryMatch[]>;
  forget(input: ForgetInput): Promise<ForgetResult>;
  update(input: UpdateInput): Promise<UpdateResult>;
  /** Remove expired memories and report stale ones. */
  prune(options?: { dryRun?: boolean; staleDays?: number }): Promise<PruneResult>;
  list(input: ListInput): Promise<MemoryEntry[]>;
  /** Surface memories near (in embedding space) an existing ref or fresh text. */
  findSimilar(input: FindSimilarInput): Promise<MemoryMatch[]>;
  /** One-shot health report: counts, stale, duplicates, expired. Read-only. */
  audit(options?: AuditOptions): Promise<AuditReport>;
  /** Soft-retire a memory: archive with tombstone instead of hard delete. */
  archive(input: ArchiveInput): Promise<ArchiveResult>;
  /** Restore a previously archived memory to the active set. */
  restore(input: RestoreInput): Promise<RestoreResult>;
  /** List body snapshots for a memory (metadata only, newest-first). */
  listRevisions(ref: string): Promise<MemoryRevisionMeta[]>;
  /** Fetch a single body snapshot including its content. */
  getRevision(revisionId: number): Promise<MemoryRevision | null>;
  /** Roll back a memory to a prior body snapshot. Snapshots the current body first. */
  restoreRevision(input: MemoryRevisionRestoreInput): Promise<MemoryRevisionRestoreResult>;
  /** Archive old_ref with a tombstone and record that new_ref supersedes it. */
  supersede(input: MemorySupersededInput): Promise<MemorySupersededResult>;
  /** Release the underlying store handle. Cached backends evict on close. */
  close(): void;
}

// ─── Embedding Interface (used by vector backends) ───────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Optional: query-optimized embedding for search (BGE-family models).
   *  Falls back to embed() when absent. */
  embedQuery?(text: string): Promise<number[]>;
  readonly dimensions: number;
}

// ─── Knowledge Backend Types ─────────────────────────────────────────────────

export interface KnowledgePageInput {
  slug: string;
  title: string;
  domain: string;
  body: string;
  sourcing?: 'sourced' | 'provisional' | 'internal';
  provenance?: string;
  /** ISO timestamp the page's claims were last verified as true. Defaults to write time. */
  verified_at?: string;
  /** The version/date the claims are valid as-of, e.g. "Syntakt OS 1.21" or "as of 2026-05". */
  freshness_anchor?: string;
  citations?: KnowledgeCitationInput[];
  /**
   * How `body` combines with an existing page on upsert.
   * 'replace' (default) overwrites the stored body; 'append' adds the new
   * body after the existing one separated by a blank line. Ignored on create.
   */
  bodyMode?: 'replace' | 'append';
  /**
   * For ours/ class pages: who created or last owned this artifact
   * (e.g. "art", "jonathan"). Preserved across upserts when omitted.
   */
  created_by?: string;
  /**
   * For ours/ class pages: artifact version or revision tag
   * (e.g. "v2", "2026-08-19", "t-81"). Preserved across upserts when omitted.
   */
  version?: string;
}

export interface KnowledgeCitationInput {
  claim: string;
  source_kind: 'web' | 'loom_memory' | 'conversation' | 'repo';
  source_locator?: string;
  excerpt: string;
}

export interface KnowledgePage {
  id: number;
  uuid: string;
  slug: string;
  title: string;
  domain: string;
  body: string;
  sourcing: string;
  provenance: string | null;
  status: string;
  tombstone_note?: string | null;
  created: string;
  updated: string | null;
  last_accessed: string | null;
  hit_count: number;
  /** ISO timestamp the page's claims were last verified as true. */
  verified_at?: string | null;
  /** The version/date the claims are valid as-of, e.g. "Syntakt OS 1.21". */
  freshness_anchor?: string | null;
  /** ours/ class: who created or last owned this artifact (e.g. "art", "jonathan"). */
  created_by?: string | null;
  /** ours/ class: artifact version or revision tag (e.g. "v2", "2026-08-19"). */
  version?: string | null;
}

export interface KnowledgeCitation {
  id: number;
  page_id: number;
  claim: string;
  source_kind: string;
  source_locator: string | null;
  excerpt: string;
  retrieved_at: string;
  created: string;
}

export interface KnowledgePageWithCitations extends KnowledgePage {
  citations: KnowledgeCitation[];
}

export interface KnowledgeQueryInput {
  query?: string;
  domain?: string;
  excludeStatus?: string;
  limit?: number;
  /**
   * When false, queryPages does NOT stamp last_accessed / increment
   * hit_count on the returned pages. Index-style browsing must pass false —
   * hit_count is the Phase-4 expansion-engine signal and means "this page
   * was actually read", not "this page appeared in a listing".
   */
  stampAccess?: boolean;
  /**
   * Stale-first ordering for the verification engine: verified_at ASC with
   * never-verified pages first. Overrides the default hit-count ordering.
   */
  sortByVerified?: boolean;
}

export interface KnowledgePageRef {
  uuid: string;
  slug: string;
  title: string;
}

export interface KnowledgeWriteResult extends KnowledgePageRef {
  citationsAdded: number;
  /** Exact-duplicate citations skipped at the write boundary. */
  citationsDeduped: number;
  /** True when the write created a new page rather than updating an existing one. */
  created: boolean;
  /** Body combine mode actually applied: 'create' for new pages, else the requested mode. */
  bodyMode: 'create' | 'replace' | 'append';
}

export interface KnowledgeArchiveInput {
  slug: string;
  /** Optional tombstone note explaining why the page was retired. */
  note?: string;
}

export interface KnowledgeArchiveResult {
  slug: string;
  /** true if the page was found and archived; false if not found or already archived. */
  archived: boolean;
}

export interface KnowledgeRestoreInput {
  slug: string;
}

export interface KnowledgeRestoreResult {
  slug: string;
  /** true if the page was found in the archive and restored; false otherwise. */
  restored: boolean;
}

export interface KnowledgeSupersededInput {
  /** Slug of the page being retired (the duplicate / loser). */
  old_slug: string;
  /** Slug of the canonical replacement page (must already exist). */
  new_slug: string;
  /** Optional note explaining the merge/supersession decision. */
  note?: string;
}

export interface KnowledgeSupersessionRecord {
  id: number;
  old_slug: string;
  new_slug: string;
  note: string | null;
  created: string;
}

export interface KnowledgeSupersededResult {
  old_slug: string;
  new_slug: string;
  /** true if the old page was archived as part of this operation. */
  archived: boolean;
}

export interface KnowledgeMoveInput {
  // ── Single-page mode (requires slug + at least one of new_slug/new_domain) ──
  slug?: string;
  new_slug?: string;
  new_domain?: string;
  /** Write a supersessions pointer when the slug changes. Default true. */
  leave_pointer?: boolean;

  // ── Batch re-domain by explicit slug list (requires new_domain) ──
  slugs?: string[];

  // ── Batch re-domain by domain prefix substitution ──
  from_domain_prefix?: string;
  to_domain_prefix?: string;
}

export interface KnowledgeMovedPageRecord {
  /** Slug after the move (= new_slug when slug changed, else original slug). */
  slug: string;
  /** Set only when the slug was renamed. */
  old_slug?: string;
  old_domain: string;
  new_domain: string;
}

export interface KnowledgeMoveResult {
  moved: number;
  pages: KnowledgeMovedPageRecord[];
  pointers_written: number;
}

export interface KnowledgeMergeInput {
  /** Slugs of the pages to merge into the target (all must exist and differ from target_slug). */
  source_slugs: string[];
  /** Slug of the canonical target page that survives (must already exist). */
  target_slug: string;
  /** Optional note about this merge, stored in supersession tombstones on the losers. */
  note?: string;
  /** Hard-delete losers after archiving them. Losers are archived (supersession pointer written) then DELETEd from the database, cascading their citations. */
  hard_delete_losers?: boolean;
  /** Append loser bodies to the target body under section markers. Default false. */
  append_loser_bodies?: boolean;
}

export interface KnowledgeMergeLoserRecord {
  slug: string;
  body: string;
}

export interface KnowledgeMergeResult {
  target_slug: string;
  sources_merged: number;
  citations_moved: number;
  citations_deduped: number;
  verified_at: string | null;
  losers: KnowledgeMergeLoserRecord[];
}

export interface KnowledgeVerifyInput {
  /** Single-page mode: slug of the page to verify. */
  slug?: string;
  /** Batch mode: stamp many pages at once. Mutually exclusive with slug; no note/anchor allowed. */
  slugs?: string[];
  /** ISO timestamp to stamp. Defaults to now. */
  verified_at?: string;
  /** New freshness anchor (single-page mode only). Preserved when omitted. */
  freshness_anchor?: string;
  /** Optional note — appended to the body as a "## Verification — <date>" section (single-page mode only). */
  note?: string;
}

export interface KnowledgeVerifyResult {
  verified: number;
  slugs: string[];
  verified_at: string;
  /** True when a note section was appended to the body. */
  noted: boolean;
}

/** Revision listing entry — metadata only, no body payload. */
export interface KnowledgeRevisionMeta {
  id: number;
  page_id: number;
  /** Slug the page had when the snapshot was taken. */
  slug: string;
  /** What displaced this body: 'write-replace' or 'history-restore'. */
  op: string;
  replaced_at: string;
  body_length: number;
}

export interface KnowledgeRevision extends Omit<KnowledgeRevisionMeta, 'body_length'> {
  body: string;
}

export interface KnowledgeRevisionRestoreInput {
  slug: string;
  revision_id: number;
}

export interface KnowledgeRevisionRestoreResult {
  slug: string;
  revision_id: number;
  restored: boolean;
  /** Id of the snapshot taken of the body that was just displaced. */
  snapshot_id: number;
}

export interface KnowledgePurgeInput {
  /** Explicit list of slugs to hard-delete. All must have status='archived' (archive-first guard). */
  slugs: string[];
  /** Must be explicitly true — required to execute an irreversible hard delete. */
  confirm: true;
}

export interface KnowledgePurgeResult {
  purged: number;
  slugs: string[];
}

// ─── Knowledge Backend Interface ─────────────────────────────────────────────

export interface KnowledgeBackend {
  /** Upsert an entity page by slug; create or append. */
  writePage(input: KnowledgePageInput): Promise<KnowledgeWriteResult>;
  /** Get a single page by slug. opts.stampAccess marks the fetch as a real read (last_accessed / hit_count). */
  getPage(slug: string, opts?: { stampAccess?: boolean }): Promise<KnowledgePageWithCitations | null>;
  /** List pages with optional filters. */
  listPages(input?: KnowledgeQueryInput): Promise<KnowledgePageWithCitations[]>;
  /** LIKE search over title, body, and domain. */
  queryPages(input: KnowledgeQueryInput): Promise<KnowledgePageWithCitations[]>;
  /** Add citations to an existing page by slug. */
  addCitations(slug: string, citations: KnowledgeCitationInput[]): Promise<number>;
  /** Soft-retire a page: set status='archived' with an optional tombstone note. */
  archivePage(input: KnowledgeArchiveInput): Promise<KnowledgeArchiveResult>;
  /** Restore a previously archived page back to active. */
  restorePage(input: KnowledgeRestoreInput): Promise<KnowledgeRestoreResult>;
  /** Mark old_slug as superseded by new_slug, archive old_slug, and record the supersession. */
  supersedePage(input: KnowledgeSupersededInput): Promise<KnowledgeSupersededResult>;
  /** Re-key or re-domain a page in place: change slug and/or domain atomically without creating a new row. */
  movePage(input: KnowledgeMoveInput): Promise<KnowledgeMoveResult>;
  /** Consolidate N source pages into one canonical target: re-parent citations (dedup), take MAX(verified_at), supersede losers. */
  mergePages(input: KnowledgeMergeInput): Promise<KnowledgeMergeResult>;
  /** Hard-delete archived pages and cascade their citations. Archive-first guard: rejects any non-archived slug. */
  purgePages(input: KnowledgePurgeInput): Promise<KnowledgePurgeResult>;
  /** Stamp verified_at / freshness_anchor without touching the body (optional appended note in single-page mode). */
  verifyPages(input: KnowledgeVerifyInput): Promise<KnowledgeVerifyResult>;
  /** List body snapshots for a page, newest first. Metadata only — no body payloads. */
  listRevisions(slug: string): Promise<KnowledgeRevisionMeta[]>;
  /** Fetch one revision including its full body. */
  getRevision(revisionId: number): Promise<KnowledgeRevision | null>;
  /** Restore a revision's body onto its page; the displaced body is snapshotted first. */
  restoreRevision(input: KnowledgeRevisionRestoreInput): Promise<KnowledgeRevisionRestoreResult>;
  /** Close the underlying SQLite connection. */
  close(): void;
}
