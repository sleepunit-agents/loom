/**
 * Capture-propose queue — the loom-side staging area for drafted memory writes.
 *
 * THE INTEGRITY INVARIANT: a proposal is NOT authored canon. Proposals live in
 * a SEPARATE table (`proposals`) and are INVISIBLE to recall / memory_list / the
 * salience digest / find_similar. A background lane drafts memory writes here;
 * Art ratifies them before they become real memories. There is no auto-commit —
 * a proposal becomes canon only via an explicit `ratifyProposal`, which routes
 * through the existing remember() tool path so it is validated like any write.
 *
 * This keeps loom's "one writer, authored" model intact while getting
 * auto-capture ergonomics: drafts can be rough; ratification is the gate.
 *
 * The store is opened raw (like salience.ts) — no embedder needed for the
 * staging table itself. Embedding happens at ratify-time, through remember().
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveSqliteDbPath } from '../config.js';
import { runMigrations } from './migrations.js';
import { remember } from '../tools/remember.js';
import type { MemoryRef } from './types.js';
import { retryWrite } from './retry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProposalInput {
  category: string;
  title: string;
  content: string;
  project?: string;
  ttl?: string;
  metadata?: Record<string, unknown>;
  /** Where the proposal came from, e.g. a lane name. */
  source?: string;
}

export interface ProposalRow {
  id: number;
  uuid: string;
  category: string | null;
  title: string | null;
  content: string | null;
  project: string | null;
  ttl: string | null;
  metadata: string;
  source: string | null;
  created: string;
  status: string;
}

export interface ProposalRef {
  id: number;
  uuid: string;
}

/** Optional Art-on-accept edits applied at ratify time. */
export interface ProposalOverrides {
  title?: string;
  content?: string;
  category?: string;
  project?: string;
  ttl?: string;
}

/** Thrown when a proposal id can't be found in the queue. */
export class UnknownProposalError extends Error {
  constructor(id: number) {
    super(`proposal not found: ${id}`);
    this.name = 'UnknownProposalError';
  }
}

// ─── DB plumbing ──────────────────────────────────────────────────────────────

function hasTable(db: Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * Open memories.db raw (no vector/embedder stack) and ensure the proposals
 * table exists. Self-heals a store that predates the proposals migration —
 * migrations are idempotent, so this is safe on any store.
 */
function openProposalsDb(contextDir: string): Database {
  const dbPath = resolveSqliteDbPath(contextDir);
  const db = new BetterSqlite3(dbPath);
  db.pragma('busy_timeout = 5000');
  if (!hasTable(db, 'proposals')) runMigrations(db, { strict: false });
  return db;
}

// ─── Queue operations ─────────────────────────────────────────────────────────

/**
 * Stage a pending proposal. A draft can be rough, so this does NOT run the
 * full validateMemoryInput gate — but it DOES require a non-empty
 * title + content + category so the row is at least shaped like a memory.
 * Hard validation is deferred to ratify.
 */
export function propose(contextDir: string, input: ProposalInput): ProposalRef {
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new Error('proposal title is required and cannot be empty');
  }
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    throw new Error('proposal content is required and cannot be empty');
  }
  if (typeof input.category !== 'string' || input.category.trim() === '') {
    throw new Error('proposal category is required and cannot be empty');
  }

  const db = openProposalsDb(contextDir);
  try {
    const uuid = randomUUID();
    const created = new Date().toISOString();
    const result = retryWrite(() =>
      db
        .prepare(`
          INSERT INTO proposals (
            uuid, category, title, content, project, ttl, metadata, source, created, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `)
        .run(
          uuid,
          input.category,
          input.title,
          input.content,
          input.project ?? null,
          input.ttl ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.source ?? null,
          created,
        ),
    );
    return { id: Number(result.lastInsertRowid), uuid };
  } finally {
    db.close();
  }
}

/** All pending proposals, newest first. */
export function listProposals(contextDir: string): ProposalRow[] {
  const dbPath = resolveSqliteDbPath(contextDir);
  if (!existsSync(dbPath)) return [];
  const db = openProposalsDb(contextDir);
  try {
    return db
      .prepare(
        `SELECT id, uuid, category, title, content, project, ttl, metadata, source, created, status
         FROM proposals WHERE status = 'pending' ORDER BY id DESC`,
      )
      .all() as ProposalRow[];
  } finally {
    db.close();
  }
}

/** Fetch a single proposal by id (any status), or null if not found. */
export function getProposal(contextDir: string, id: number): ProposalRow | null {
  const dbPath = resolveSqliteDbPath(contextDir);
  if (!existsSync(dbPath)) return null;
  const db = openProposalsDb(contextDir);
  try {
    const row = db
      .prepare(
        `SELECT id, uuid, category, title, content, project, ttl, metadata, source, created, status
         FROM proposals WHERE id = ?`,
      )
      .get(id) as ProposalRow | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

/** Delete a pending proposal. Returns false if no pending row with that id. */
export function rejectProposal(contextDir: string, id: number): boolean {
  const dbPath = resolveSqliteDbPath(contextDir);
  if (!existsSync(dbPath)) return false;
  const db = openProposalsDb(contextDir);
  try {
    const result = retryWrite(() =>
      db
        .prepare("DELETE FROM proposals WHERE id = ? AND status = 'pending'")
        .run(id),
    );
    return result.changes > 0;
  } finally {
    db.close();
  }
}

/**
 * Ratify a pending proposal into a REAL memory.
 *
 * Loads the proposal, applies optional Art-on-accept overrides, then commits it
 * via the existing remember() path — so validateMemoryInput runs. If the
 * resulting memory is invalid, remember() throws its typed reason, NOTHING is
 * committed, and the proposal row STAYS pending (the throw propagates before the
 * delete). On success the memory is authored and the proposal row is removed.
 *
 * Throws UnknownProposalError if the id isn't in the queue.
 */
export async function ratifyProposal(
  contextDir: string,
  id: number,
  overrides: ProposalOverrides = {},
): Promise<MemoryRef> {
  const proposal = getProposal(contextDir, id);
  if (!proposal) throw new UnknownProposalError(id);

  const metadata = parseMetadata(proposal.metadata);

  // remember() validates (validateMemoryInput) and throws on an invalid write
  // BEFORE anything is committed — so an invalid proposal is refused with its
  // typed reason and, because the throw happens before the delete below, the
  // proposal stays pending for a later fix.
  const ref = await remember(contextDir, {
    category: overrides.category ?? proposal.category ?? '',
    title: overrides.title ?? proposal.title ?? '',
    content: overrides.content ?? proposal.content ?? '',
    project: overrides.project ?? proposal.project ?? undefined,
    ttl: overrides.ttl ?? proposal.ttl ?? undefined,
    metadata,
  });

  // Committed as canon — drop the staging row.
  const db = openProposalsDb(contextDir);
  try {
    retryWrite(() => db.prepare('DELETE FROM proposals WHERE id = ?').run(id));
  } finally {
    db.close();
  }

  return ref;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
