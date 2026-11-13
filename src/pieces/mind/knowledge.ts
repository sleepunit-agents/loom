/** Read-only projection of the existing commons knowledge store. No schema writes. */
import type { Database } from 'better-sqlite3';
interface PageRow { slug: string; title: string; domain: string; updated: string; sourcing: string | null; body?: string; created_by?: string | null; author?: string | null; verified_at?: string | null }
const CHECK_DAYS = 30;
export type Freshness = 'fresh' | 'aging' | 'due';
export interface KnowledgeRow { slug: string; title: string; domain: string; updated: string; verified_at?: string; fresh: Freshness; by?: string;
  /** Confirmed in the last RECENT_DAYS: Knowledge's Recently verified. */
  recent?: true }
export interface KnowledgeOpen extends KnowledgeRow {
  body: string; sourcing?: string;
  sources: Array<{ claim: string; kind: string; locator?: string; href?: string }>;
  /** Other pages that link to this one ([[slug]], knowledge:slug, /knowledge/slug). */
  citedBy: Array<{ slug: string; title: string }>;
  /** Its last check's outcome, when there was one. */
  checked?: { at: string; outcome: string; by?: string };
}
export interface KnowledgeView { total: number; checkDays: number; recentDays: number; pages: KnowledgeRow[]; open?: KnowledgeOpen }

/** How many days back "Recently verified" reaches. */
const RECENT_DAYS = 7;
/** The most pages the reader lists (the whole commons, today 188). */
const READER_MAX = 2000;

/** Every active page's line (title, domain, freshness), and the one asked for whole: Knowledge's own view. */
export function knowledgeView(db: Database | undefined, nowMs: number, open?: string, detailOnly = false): KnowledgeView {
  const empty: KnowledgeView = { total: 0, checkDays: CHECK_DAYS, recentDays: RECENT_DAYS, pages: [] };
  if (!db) return empty;
  {
    // Each page's last check's outcome (a stale one means "check again").
    let last = new Map<number, { at: string; outcome: string; by?: string }>();
    try {
      last = new Map((db.prepare('SELECT v.page_id AS id, v.verified_at AS at, v.outcome AS outcome, v.verifier AS by FROM verifications v JOIN (SELECT page_id, MAX(id) AS m FROM verifications GROUP BY page_id) x ON x.m = v.id WHERE (? IS NULL OR v.page_id = (SELECT id FROM pages WHERE slug = ?))').all(detailOnly ? open : null, detailOnly ? open : null) as Array<{ id: number; at: string; outcome: string; by: string | null }>)
        .map((r) => [r.id, { at: r.at, outcome: r.outcome, ...(r.by ? { by: r.by } : {}) }]));
    } catch { /* an older store: no verifications table */ }
    const rows = db.prepare(`SELECT id, slug, title, domain, updated, verified_at, created_by, author FROM pages WHERE status = 'active' AND (? IS NULL OR slug = ?) ORDER BY updated DESC LIMIT ${READER_MAX}`)
      .all(detailOnly ? open : null, detailOnly ? open : null) as Array<PageRow & { id: number }>;
    const day = 86_400_000;
    const fresh = (r: { id: number; updated: string; verified_at?: string | null }): Freshness => {
      const at = Date.parse(r.verified_at ?? r.updated);
      const age = (nowMs - at) / day;
      if (last.get(r.id)?.outcome === 'stale' || !(age < CHECK_DAYS)) return 'due';
      return age >= (CHECK_DAYS * 2) / 3 ? 'aging' : 'fresh';
    };
    const recent = (r: { verified_at?: string | null }) => !!r.verified_at && nowMs - Date.parse(r.verified_at) < RECENT_DAYS * day;
    const line = (r: PageRow & { id: number }): KnowledgeRow => ({ slug: r.slug, title: r.title, domain: r.domain, updated: r.updated,
      ...(r.verified_at ? { verified_at: r.verified_at } : {}), fresh: fresh(r), ...(recent(r) ? { recent: true as const } : {}), ...((r.created_by ?? r.author) ? { by: (r.created_by ?? r.author)! } : {}) });
    const out: KnowledgeView = { total: (db.prepare("SELECT COUNT(*) AS n FROM pages WHERE status = 'active'").get() as { n: number }).n, checkDays: CHECK_DAYS, recentDays: RECENT_DAYS, pages: rows.map(line) };
    if (open) {
      const r = db.prepare("SELECT id, slug, title, domain, body, updated, sourcing, created_by, author, verified_at FROM pages WHERE slug = ? AND status = 'active'").get(open) as (PageRow & { id: number }) | undefined;
      if (r) {
        let sources: KnowledgeOpen['sources'] = [];
        try {
          sources = (db.prepare('SELECT claim, source_kind, source_locator FROM citations WHERE page_id = ? LIMIT 40').all(r.id) as Array<{ claim: string; source_kind: string; source_locator: string | null }>)
            .map((c) => ({ claim: c.claim, kind: c.source_kind, ...(c.source_locator ? { locator: c.source_locator } : {}), ...(c.source_locator && /^https?:\/\//.test(c.source_locator) ? { href: c.source_locator } : {}) }));
        } catch { /* no citations table */ }
        const esc = (x: string) => x.replace(/[\\%_]/g, (c) => `\\${c}`);
        const citedBy = db.prepare("SELECT slug, title FROM pages WHERE status = 'active' AND slug != ? AND (body LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY title LIMIT 20")
          .all(r.slug, `%[[${esc(r.slug)}]]%`, `%knowledge:${esc(r.slug)}%`, `%/knowledge/${esc(r.slug)}%`) as Array<{ slug: string; title: string }>;
        const checked = last.get(r.id);
        out.open = { ...line(r), body: (r.body ?? '').slice(0, 20000), ...(r.sourcing ? { sourcing: r.sourcing } : {}), sources, citedBy, ...(checked ? { checked } : {}) };
      }
    }
    return out;
  }
}

