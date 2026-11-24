import { createHash } from 'node:crypto';
/** Read-only projection of the existing commons knowledge store. No schema writes. */
import { DAY_MS } from '../../core/day.js';
import type { Database } from 'better-sqlite3';
import {maySee,mayAct,type Viewer,type Sharing} from '../../core/index.js';
/** The same current capability projection for GraphQL and legacy clients. */
export function knowledgeAccess(viewer:Viewer,sharing:Sharing){return {id:'knowledge',allowed:maySee(viewer,{type:'knowledge'},sharing),
 canAdd:mayAct(viewer,{type:'knowledge'},sharing,'act'),
 canVerify:mayAct(viewer,{type:'knowledge'},sharing,'act'),
 canRecheck:mayAct(viewer,{type:'knowledge'},sharing,'act')};}

interface PageRow { slug: string; title: string; domain: string; updated: string; sourcing: string | null; body?: string; created_by?: string | null; author?: string | null; verified_at?: string | null; freshness_anchor?: string | null; sla_class?: string | null }
/** How long a check of a page stands. The page shows it as due after this, and the sweep raises it then. */
export const CHECK_DAYS = 30;
/** A device the household has retired needs only a quarterly routine check. */
export const RETIRED_CHECK_DAYS = 90;
export function retiredKnowledgePages(db: Database, slug?: string): Set<number> {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='page_annotations'").get()) return new Set();
  const rows = db.prepare(`SELECT a.page_id FROM page_annotations a JOIN (
    SELECT page_id, max(id) AS id FROM page_annotations
    WHERE kind IN ('no-longer-owned','in-use')
      AND (? IS NULL OR page_id=(SELECT id FROM pages WHERE slug=?)) GROUP BY page_id
  ) latest ON latest.id=a.id WHERE a.kind='no-longer-owned'`).all(slug ?? null, slug ?? null) as {page_id:number}[];
  return new Set(rows.map(row => row.page_id));
}
/** A page is shown as aging for the last third of that time. */
export const AGING_DAYS = (CHECK_DAYS * 2) / 3;
const activeSchedule = {agingDays: AGING_DAYS, checkDays: CHECK_DAYS};
const retiredSchedule = {agingDays: RETIRED_CHECK_DAYS * 2 / 3, checkDays: RETIRED_CHECK_DAYS};
export function knowledgeSchedule(retired: boolean) {
  return retired ? retiredSchedule : activeSchedule;
}
export type Freshness = 'fresh' | 'aging' | 'due';
export interface KnowledgeRow { archiveCandidate?: true; slug: string; title: string; domain: string; updated: string; verified_at?: string; freshness_anchor?: string; sla_class?: string; fresh: Freshness; by?: string;
  /** Its last check's outcome, when there was one. */
  checked?: { at: string; outcome: string; by?: string };
  /** Confirmed in the last RECENT_DAYS: Knowledge's Recently verified. */
  recent?: true }
export interface KnowledgeOpen extends KnowledgeRow {
  body: string; sourcing?: string;
  sources: Array<{ claim: string; kind: string; locator?: string; href?: string; excerpt: string; retrievedAt: string; createdAt: string }>;
  /** Other pages that link to this one ([[slug]], knowledge:slug, /knowledge/slug). */
  citedBy: Array<{ slug: string; title: string }>;

}
export interface KnowledgeView { total: number; checkDays: number; recentDays: number; pages: KnowledgeRow[]; open?: KnowledgeOpen }

/** How many days back "Recently verified" reaches. */
export const RECENT_DAYS = 7;

export function knowledgeTotal(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pages WHERE status = 'active'").get() as { n: number }).n;
}

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
    const rows = db.prepare(`SELECT id, slug, title, domain, updated, verified_at, freshness_anchor, sla_class, created_by, author FROM pages WHERE status = 'active' AND (? IS NULL OR slug = ?) ORDER BY updated DESC, slug`)
      .all(detailOnly ? open : null, detailOnly ? open : null) as Array<PageRow & { id: number }>;
    const retired = retiredKnowledgePages(db, detailOnly ? open : undefined);
    const day = DAY_MS;
    const fresh = (r: { id: number; updated: string; verified_at?: string | null }): Freshness => {
      const at = Date.parse(r.verified_at ?? r.updated);
      const age = (nowMs - at) / day;
      const {agingDays, checkDays} = knowledgeSchedule(retired.has(r.id));
      if (last.get(r.id)?.outcome === 'stale' || !(age < checkDays)) return 'due';
      return age >= agingDays ? 'aging' : 'fresh';
    };
    const recent = (r: { verified_at?: string | null }) => !!r.verified_at && nowMs - Date.parse(r.verified_at) < RECENT_DAYS * day;
    const line = (r: PageRow & { id: number }): KnowledgeRow => ({ ...(retired.has(r.id) ? {archiveCandidate:true as const} : {}), slug: r.slug, title: r.title, domain: r.domain, updated: r.updated,
      ...(r.verified_at ? { verified_at: r.verified_at } : {}), ...(r.freshness_anchor ? { freshness_anchor: r.freshness_anchor } : {}), ...(r.sla_class ? { sla_class: r.sla_class } : {}), ...(last.has(r.id) ? {checked: last.get(r.id)} : {}), fresh: fresh(r), ...(recent(r) ? { recent: true as const } : {}), ...((r.created_by ?? r.author) ? { by: (r.created_by ?? r.author)! } : {}) });
    const out: KnowledgeView = { total: detailOnly ? knowledgeTotal(db) : rows.length, checkDays: CHECK_DAYS, recentDays: RECENT_DAYS, pages: rows.map(line) };
    if (open) {
      const r = db.prepare("SELECT id, slug, title, domain, body, updated, sourcing, created_by, author, verified_at, freshness_anchor, sla_class FROM pages WHERE slug = ? AND status = 'active'").get(open) as (PageRow & { id: number }) | undefined;
      if (r) {
        let sources: KnowledgeOpen['sources'] = [];
        try {
          sources = (db.prepare('SELECT claim, source_kind, source_locator, excerpt, retrieved_at, created FROM citations WHERE page_id = ? ORDER BY id').all(r.id) as Array<{ claim: string; source_kind: string; source_locator: string | null; excerpt: string; retrieved_at: string; created: string }>)
            .map((c) => ({ claim: c.claim, kind: c.source_kind, excerpt: c.excerpt, retrievedAt: c.retrieved_at, createdAt: c.created, ...(c.source_locator ? { locator: c.source_locator } : {}), ...(c.source_locator && /^https?:\/\//.test(c.source_locator) ? { href: c.source_locator } : {}) }));
        } catch { /* no citations table */ }
        const esc = (x: string) => x.replace(/[\\%_]/g, (c) => `\\${c}`);
        const target = r.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const refers = new RegExp(`\\[\\[${target}(?:\\|[^\\]]*)?\\]\\]|(?:knowledge:|/knowledge/)${target}(?![\\w/.-])`);
        const citedBy = (db.prepare("SELECT slug, title, body FROM pages WHERE status = 'active' AND slug != ? AND (body LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY title, slug")
          .all(r.slug, `%[[${esc(r.slug)}%`, `%knowledge:${esc(r.slug)}%`, `%/knowledge/${esc(r.slug)}%`) as Array<{ slug: string; title: string; body: string }>)
          .filter(page => refers.test(page.body)).map(({slug,title}) => ({slug,title}));
        const sourcing = sources.some(source => source.kind !== 'conversation') ? r.sourcing ?? 'sourced' : 'provisional';
        out.open = { ...line(r), body: r.body ?? '', sourcing, sources, citedBy };
      }
    }
    return out;
  }
}



/** An exact reference to the claims and version anchor read for a check. */
export function knowledgeCheckRevision(page: {body:string; freshness_anchor?:string|null}): string {
  return createHash('sha256').update(JSON.stringify([page.body,page.freshness_anchor ?? null])).digest('hex');
}
