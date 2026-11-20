/** The knowledge store's writes of a page row, a page's words and a citation, each stated once.
 * Synchronous, on the caller's connection and inside the caller's transaction, like the verification
 * and revision primitives beside this file. The door's page actions (pieces/mind/actions.ts) are the
 * program's only writer of pages and write through these, so a rule added here (a cap, a derived
 * column) reaches every way a page is made or changed. */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { deriveSlaClass, enforcePageBodyCap } from './knowledge-verification.js';
import type { KnowledgeCitationInput } from './types.js';

/** Hard size cap on a citation's excerpt, enforced wherever one is written. */
export const MAX_CITATION_EXCERPT_LENGTH = 4096; // 4 KB
export function enforceExcerptCap(excerpt: string): void {
  if (excerpt.length > MAX_CITATION_EXCERPT_LENGTH) {
    throw new Error(
      `Citation excerpt exceeds hard cap of ${MAX_CITATION_EXCERPT_LENGTH} characters ` +
      `(got ${excerpt.length}).`,
    );
  }
}

export interface NewKnowledgePage {
  slug: string; title: string; domain: string; body: string;
  sourcing?: string; provenance?: string; verified_at?: string | null; freshness_anchor?: string;
  sla_class?: string; created_by?: string; version?: string;
  /** Who wrote the first version. Kept for the life of the page. */
  actor?: string;
}

/** Insert a page that does not exist yet. A new page counts as checked at its writing unless the
 * writer says otherwise, and its freshness class follows from its anchor and domain. */
export function insertKnowledgePage(db: Database, page: NewKnowledgePage, at: string): { id: number; uuid: string } {
  enforcePageBodyCap(page.body);
  const uuid = randomUUID();
  const result = db.prepare(
    `INSERT INTO pages (uuid, slug, title, domain, body, sourcing, provenance, verified_at, freshness_anchor, sla_class, created_by, version, author, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid, page.slug, page.title, page.domain, page.body, page.sourcing ?? 'sourced', page.provenance ?? null,
    page.verified_at === undefined ? at : page.verified_at, page.freshness_anchor ?? null,
    page.sla_class ?? deriveSlaClass(page.freshness_anchor ?? null, page.domain),
    page.created_by ?? null, page.version ?? null, page.actor ?? null, at, at,
  );
  return { id: Number(result.lastInsertRowid), uuid };
}

/** Replace a page's words and nothing else. The caller saves the displaced words as a version first. */
export function setKnowledgePageBody(db: Database, pageId: number, body: string, at: string): void {
  enforcePageBodyCap(body);
  db.prepare('UPDATE pages SET body = ?, updated = ? WHERE id = ?').run(body, at, pageId);
}

/** A page that gains a source is sourced from then on. */
export function markKnowledgePageSourced(db: Database, pageId: number): void {
  db.prepare("UPDATE pages SET sourcing = 'sourced' WHERE id = ?").run(pageId);
}

/** Add one citation to a page. With `skipDuplicate`, a citation whose claim, kind, locator and excerpt
 * all match one the page already has is not added again. Returns whether a row was added. */
export function insertKnowledgeCitation(db: Database, pageId: number, citation: KnowledgeCitationInput, at: string, options: { skipDuplicate?: boolean } = {}): boolean {
  enforceExcerptCap(citation.excerpt);
  if (options.skipDuplicate && db.prepare(
    `SELECT 1 FROM citations
     WHERE page_id = ? AND claim = ? AND source_kind = ?
       AND COALESCE(source_locator, '') = COALESCE(?, '')
       AND excerpt = ?`,
  ).get(pageId, citation.claim, citation.source_kind, citation.source_locator ?? null, citation.excerpt)) return false;
  db.prepare(
    `INSERT INTO citations (page_id, claim, source_kind, source_locator, excerpt, retrieved_at, created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(pageId, citation.claim, citation.source_kind, citation.source_locator ?? null, citation.excerpt, at, at);
  return true;
}
