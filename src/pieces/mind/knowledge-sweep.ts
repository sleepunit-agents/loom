import type { Database } from 'better-sqlite3';
import type { Clock } from '../../core/clock.js';
import type { OpenItem, SweepPart } from '../../core/tempo/sweep.js';

const CHECK_INTERVAL = 30 * 86_400_000;

/** Trusted sweep contribution, routed to the explicitly configured checking agent.
 * Reads metadata only; delivering a reminder never counts as checking a page.
 */
export function knowledgeSweep(db: Database | undefined, clock: Clock, agent: string): SweepPart {
  if (!agent.trim()) throw new Error('Knowledge sweep needs a checking agent');
  return { name: 'Knowledge', open(who) {
    if (!db || who.kind !== 'agent' || who.id !== agent) return [];
    return db.transaction(() => {
      const hasChecks = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'verifications'").get();
      const latest = hasChecks ? `(SELECT outcome FROM verifications WHERE page_id = p.id ORDER BY id DESC LIMIT 1)` : 'NULL';
      const checkedAt = hasChecks ? `(SELECT verified_at FROM verifications WHERE page_id = p.id ORDER BY id DESC LIMIT 1)` : 'NULL';
      const rows = db.prepare(`SELECT slug, title, updated, verified_at, ${latest} AS outcome, ${checkedAt} AS checked_at FROM pages p WHERE status = 'active' ORDER BY slug`).all() as Array<{
        slug: string; title: string; updated: string; verified_at: string | null; outcome: string | null; checked_at: string | null;
      }>;
      const now = clock.now();
      const items: OpenItem[] = [];
      for (const row of rows) {
        const anchor = Date.parse(row.verified_at ?? row.updated);
        const stale = row.outcome === 'stale';
        const due = stale ? Date.parse(row.checked_at ?? '') : anchor + CHECK_INTERVAL;
        if (!stale && due > now) continue;
        // Malformed legacy timestamps must not hide a page needing attention.
        items.push({ id: row.slug, words: `Re-check knowledge page ${row.slug}: ${row.title}`,
          openedAt: new Date(Number.isFinite(due) ? due : now).toISOString() });
      }
      return items;
    })();
  } };
}
