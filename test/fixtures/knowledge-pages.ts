/** A knowledge store for tests to fill and change, in the few ways the readers and the door have to
 * cope with. The running program writes pages only through the door (src/pieces/mind/actions.ts); this
 * is not a second writer for it.
 *
 * A new page, a citation, a kept version and a check go through the same primitives the door uses
 * (src/backends/knowledge-writes.ts, knowledge-revisions.ts, knowledge-verification.ts). The rest are
 * states an existing household's file can hold that no door makes: a page archived, renamed or removed
 * by the program that kept this file before. They are written here as that program left them. */
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { upgradeKnowledgeStore } from '../../src/backends/sqlite-knowledge.js';
import { insertKnowledgeCitation, insertKnowledgePage } from '../../src/backends/knowledge-writes.js';
import { snapshotKnowledgeRevision } from '../../src/backends/knowledge-revisions.js';
import { verifyKnowledgePages } from '../../src/backends/knowledge-verification.js';
import type { KnowledgeCitation, KnowledgeCitationInput, KnowledgePage, KnowledgeVerifyInput } from '../../src/backends/types.js';

export interface FixturePage {
  slug: string; title: string; domain: string; body: string;
  sourcing?: string; verified_at?: string; freshness_anchor?: string; actor?: string;
  citations?: KnowledgeCitationInput[];
}

export class KnowledgePages {
  private readonly db: BetterSqlite3.Database;
  constructor(config: { dbPath: string }) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new BetterSqlite3(config.dbPath);
    try { upgradeKnowledgeStore(this.db); } catch (error) { this.db.close(); throw error; }
  }
  close(): void { if (this.db.open) this.db.close(); }

  /** Makes the page, or replaces its title, domain and words and keeps the displaced words as a version. */
  async writePage(page: FixturePage): Promise<void> {
    const at = new Date().toISOString();
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id, body FROM pages WHERE slug = ?').get(page.slug) as { id: number; body: string } | undefined;
      let id: number;
      if (existing) {
        id = existing.id;
        if (page.body !== existing.body) snapshotKnowledgeRevision(this.db, id, page.slug, existing.body, 'write-replace', at, page.actor ?? null);
        this.db.prepare('UPDATE pages SET title = ?, domain = ?, body = ?, verified_at = COALESCE(?, verified_at), updated = ? WHERE id = ?')
          .run(page.title, page.domain, page.body, page.verified_at ?? null, at, id);
      } else ({ id } = insertKnowledgePage(this.db, page, at));
      for (const citation of page.citations ?? []) insertKnowledgeCitation(this.db, id, citation, at, { skipDuplicate: true });
    }).immediate();
  }
  async getPage(slug: string) {
    const page = this.db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug) as (KnowledgePage | undefined);
    return page ? { ...page, citations: this.db.prepare('SELECT * FROM citations WHERE page_id = ? ORDER BY id').all(page.id) as KnowledgeCitation[] } : null;
  }
  /** The kept versions of a page, newest first. */
  async listRevisions(slug: string) {
    return this.db.prepare('SELECT r.id, r.op, r.actor, r.body FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.slug = ? ORDER BY r.id DESC').all(slug) as Array<{ id: number; op: string; actor: string | null; body: string }>;
  }
  async verifyPages(input: KnowledgeVerifyInput) { return verifyKnowledgePages(this.db, input, Date.now()); }
  async getVerifications(slug: string) {
    const rows = this.db.prepare(`SELECT v.id, v.page_id, v.verifier, v.verified_at, v.outcome, v.citation_checked
      FROM verifications v JOIN pages p ON p.id = v.page_id WHERE p.slug = ? ORDER BY v.id DESC`).all(slug) as Array<{ id: number; page_id: number; verifier: string | null; verified_at: string; outcome: string; citation_checked: number }>;
    return rows.map(row => ({ ...row, citation_checked: row.citation_checked !== 0 }));
  }

  // As the earlier program left them.
  async archivePage(input: { slug: string; note?: string }): Promise<void> {
    this.db.prepare("UPDATE pages SET status = 'archived', tombstone_note = ?, updated = ? WHERE slug = ? AND status <> 'archived'").run(input.note ?? null, new Date().toISOString(), input.slug);
  }
  async restorePage(input: { slug: string }): Promise<void> {
    this.db.prepare("UPDATE pages SET status = 'active', tombstone_note = NULL, updated = ? WHERE slug = ? AND status = 'archived'").run(new Date().toISOString(), input.slug);
  }
  /** A rename that left no pointer behind. */
  async renamePage(input: { slug: string; new_slug: string }): Promise<void> {
    this.db.prepare('UPDATE pages SET slug = ?, updated = ? WHERE slug = ?').run(input.new_slug, new Date().toISOString(), input.slug);
  }
  /** Removes archived pages for good; their citations go with them. */
  async purgePages(slugs: string[]): Promise<void> {
    this.db.pragma('foreign_keys = ON');
    for (const slug of slugs) this.db.prepare("DELETE FROM pages WHERE slug = ? AND status = 'archived'").run(slug);
  }
}
