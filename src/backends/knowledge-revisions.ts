import type { Database } from 'better-sqlite3';
import { MAX_REVISIONS } from './cards.js';
import { retryWrite } from './retry.js';

/** Save the displaced body and retain the newest MAX_REVISIONS versions. The caller's
 * transaction includes both this snapshot and the edit it protects. */
export function snapshotKnowledgeRevision(
  db: Database, pageId: number, slug: string, body: string, op: string,
  timestamp: string, actor: string | null = null,
): number {
  const result = retryWrite(() => db.prepare(
    'INSERT INTO page_revisions (page_id, slug, body, op, replaced_at, actor) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(pageId, slug, body, op, timestamp, actor));
  retryWrite(() => db.prepare(
    `DELETE FROM page_revisions WHERE page_id = ? AND id NOT IN (
      SELECT id FROM page_revisions WHERE page_id = ? ORDER BY id DESC LIMIT ?
    )`,
  ).run(pageId, pageId, MAX_REVISIONS));
  return Number(result.lastInsertRowid);
}
