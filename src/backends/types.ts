/**
 * Memory backend types — shared across all backend implementations.
 *
 * These types define the contract between the MCP tool layer and the
 * storage backend. Any backend that implements MemoryBackend can be
 * swapped in; v0.3.1 ships SqliteVecBackend as the single opinion.
 */

// ─── Input / Output Types ────────────────────────────────────────────────────

/**
 * How a memory was sourced — mirrors the knowledge wing's sourcing field.
 * Displayed at injection time so readers can calibrate confidence.
 *
 * - `observed`  — directly witnessed by this body: measured, tested, read from source.
 * - `relayed`   — learned from another person/body: conversation, letter, episode.
 * - `inferred`  — AI-generated reasoning/synthesis: extrapolation, pattern-matching.
 *                 Treat with appropriate skepticism — not ground truth.
 * - `system`    — auto-written by the harness (episode fallback, lane output, etc.).
 */
export type MemorySourcing = 'observed' | 'relayed' | 'inferred' | 'system';

export type { MemoryScope } from './scope.js';
import type { MemoryScope } from './scope.js';

export interface MemoryInput {
  category: string;
  title: string;
  content: string;
  project?: string;
  metadata?: Record<string, unknown>;
  /** Optional time-to-live. Parsed durations like "7d", "30d", or "permanent". */
  ttl?: string;
  /**
   * How this memory was sourced. Displayed at injection so the reader can
   * calibrate confidence — 'inferred' flags AI-generated reasoning that should
   * not be treated as ground truth.
   */
  sourcing?: MemorySourcing;
  /**
   * Free-form origin: surface, body, session, or person. E.g. "wake:w-74fccc
   * 2026-09-07", "Jonathan, Discord #loom", "lane:letters". For episodes,
   * prefer metadata.where (already conventional); this carries additional detail.
   */
  provenance?: string;
  /**
   * Explicit scope override — 'project' (only recallable while scoped to
   * this memory's project) or 'global' (recallable regardless of project).
   * Omit to take the category default (see backends/scope.ts): 'user' and
   * 'reference' default global, everything else defaults project when a
   * project is attached, global when it isn't. Set this explicitly to flag
   * a genuinely cross-project fact learned in a project context — e.g. a
   * git/security/tool-workflow practice that happened to surface while
   * working on one project but applies everywhere (t-337).
   */
  scope?: MemoryScope;
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

export interface MemoryMatch {
  path: string;
  title: string;
  category: string;
  project?: string;
  created: string;
  content: string;
  /**
   * Final ranking score for this result's position in the returned list.
   * Equals `similarity` unless MMR re-ranking (recall's `diversity` > 0)
   * traded this pick off against ones already selected — in that case this
   * is the blended score (λ·similarity − (1−λ)·max similarity-to-selected)
   * that actually placed it, not its raw similarity. See `similarity` for
   * the pre-MMR number alongside it (t-337a; modeled on MemoriLabs/Memori's
   * FactSearchResult.{similarity, rank_score} split).
   */
  relevance: number;
  /** Raw cosine similarity (1 − distance) to the query, before any MMR re-ranking. */
  similarity: number;
  /** Effective scope this memory was recalled under — see backends/scope.ts (t-337b). */
  scope: MemoryScope;
  /** ISO timestamp of last recall hit, if tracked */
  lastAccessed?: string;
  /** TTL value if set (e.g. "7d", "permanent") */
  ttl?: string;
  /** ISO timestamp when this memory expires, if TTL is set */
  expiresAt?: string;
  /** Sourcing tier — how the memory was produced. Null on legacy records. */
  sourcing?: MemorySourcing;
  /** Free-form origin text (surface / person / session). Null on legacy records. */
  provenance?: string;
  /**
   * Evidence-backed confidence (0.3-0.9), feedback memories only (t-338).
   * Decayed toward neutral by category half-life — see salience.ts
   * decayedConfidence(). Undefined for non-feedback memories.
   */
  confidence?: number;
  /** Number of observations (creation + confirm/contradict) behind `confidence`. */
  evidenceCount?: number;
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
  /**
   * Record an observation against this memory's confidence (feedback
   * memories only, t-338): 'confirm' raises it, 'contradict' lowers it.
   * Computed in code (see salience.ts applyObservation) — never a prompt.
   * Ignored on non-feedback memories.
   */
  observation?: Observation;
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
  /** Raw (undecayed) confidence after applying `observation`, when one was given. */
  confidence?: number;
  /** Evidence count after applying `observation`, when one was given. */
  evidenceCount?: number;
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

// ─── Memory Merge Types ──────────────────────────────────────────────────────

export interface MemoryMergeInput {
  /** Refs of the losing memories to fold into the target (all must be active). */
  source_refs: string[];
  /** Ref of the canonical memory that survives the merge (must already exist, active). */
  target_ref: string;
  /** Optional note about this merge, stored in supersession tombstones on the losers. */
  note?: string;
  /** Hard-delete losers after archiving/superseding them (default false). */
  hard_delete_losers?: boolean;
  /** Append loser bodies to the target content under section markers (default false). */
  append_loser_bodies?: boolean;
}

export interface MemoryMergeResult {
  target_ref: string;
  sources_merged: number;
  /** Target's times_seen after summing in each merged source's count. */
  times_seen: number;
  losers: { ref: string; title: string; content: string }[];
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
  /** Sourcing tier — how the memory was produced. Null on legacy records. */
  sourcing?: MemorySourcing;
  /** Free-form origin text (surface / person / session). Null on legacy records. */
  provenance?: string;
  /** Decayed confidence (feedback memories only, t-338). */
  confidence?: number;
  /** Observation count behind `confidence`. */
  evidenceCount?: number;
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
  /**
   * Consolidate 2+ memories into one canonical row. Acts on an audit()
   * duplicate-finding: sources are archived with a supersession pointer to
   * the target (parity with supersede(), but N:1), times_seen is summed
   * onto the target, and bodies are optionally concatenated.
   */
  mergeMemories(input: MemoryMergeInput): Promise<MemoryMergeResult>;
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
  /**
   * Machine-readable SLA class: 'device' (7d), 'software' (14d), 'default' (30d).
   * Derived from freshness_anchor shape and domain on write; may be overridden
   * explicitly when the page is made (NewKnowledgePage.sla_class).
   */
  sla_class: string;
  /** ours/ class: who created or last owned this artifact (e.g. "art", "jonathan"). */
  created_by?: string | null;
  /** ours/ class: artifact version or revision tag (e.g. "v2", "2026-08-19"). */
  version?: string | null;
  /**
   * Identity that wrote v1 of this page — set once at creation, never
   * changed by later upserts. Null for pages created before this column
   * existed, or written by a direct backend caller that omitted actor.
   */
  author?: string | null;
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
  /**
   * Caller's loom identity, resolved server-side (never a free-text tool
   * argument). Recorded as verifications.verifier for every page stamped
   * by this call. Omitted means "unknown" (legacy direct callers, tests).
   */
  verifier?: string;
  /** What the verification found. Defaults to 'confirmed' (the claims still hold). */
  outcome?: 'confirmed' | 'stale' | 'corrected';
  /** Whether the verifier actually checked the page's citations against their sources. Defaults to false. */
  citation_checked?: boolean;
}

export interface KnowledgeVerifyResult {
  verified: number;
  slugs: string[];
  /** The verification time recorded in the audit trail. */
  verified_at: string;
  /**
   * True when pages.verified_at was advanced to `verified_at`. False for an
   * outcome of 'stale' — a failed verification is audited but does not
   * renew the page's successful-freshness stamp.
   */
  stamped: boolean;
  /** True when a note section was appended to the body. */
  noted: boolean;
}

/** The most characters one memory's content may have. The commands that write a memory and the terminal's
 * tools over them (src/pieces/mind/semantic-commands.ts, src/shared-mcp-named.ts) both take it from here. */
export const MEMORY_CONTENT_MAX = 65536;

/** What a later look at a feedback memory found: it held, or it did not. */
export const OBSERVATIONS = ['confirm', 'contradict'] as const;
export type Observation = (typeof OBSERVATIONS)[number];
