import { DAY_MS } from '../../core/day.js';
import type { Database } from 'better-sqlite3';
import type { Clock } from '../../core/clock.js';
import type { OpenItem, SweepPart } from '../../core/tempo/sweep.js';
import { knowledgeSchedule, retiredKnowledgePages } from './knowledge.js';



/** Trusted sweep contribution, routed to the explicitly configured checking agent.
 * Reads metadata only; delivering a reminder never counts as checking a page.
 */
export function knowledgeSweep(db: Database | undefined, clock: Pick<Clock,'now'>, agent: string, alternate?: string): SweepPart {
  if (!agent.trim()) throw new Error('Knowledge sweep needs a checking agent');
  return { name: 'Knowledge', open(who) {
    if (!db || who.kind !== 'agent' || (who.id !== agent && who.id !== alternate)) return [];
    return db.transaction(() => {
      const hasChecks = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'verifications'").get();
      const latest = hasChecks ? `(SELECT outcome FROM verifications WHERE page_id = p.id ORDER BY id DESC LIMIT 1)` : 'NULL';
      const checkedAt = hasChecks ? `(SELECT verified_at FROM verifications WHERE page_id = p.id ORDER BY id DESC LIMIT 1)` : 'NULL';
      // A missing attribution stays unknown. Older stores can still be swept by their primary checker.
      const attributed = alternate && hasChecks
        && db.prepare("SELECT 1 FROM pragma_table_info('pages') WHERE name='author'").get()
        && db.prepare("SELECT 1 FROM pragma_table_info('verifications') WHERE name='verifier'").get();
      const rotate = attributed ? `p.author = @primary AND
        (SELECT count(*) FROM (SELECT verifier FROM verifications WHERE page_id=p.id ORDER BY id DESC LIMIT 3)
         WHERE verifier=@primary) = 3` : '0';
      const retired = retiredKnowledgePages(db);
      const rows = db.prepare(`SELECT p.id, (${rotate}) AS rotate, slug, title, updated, verified_at, ${latest} AS outcome, ${checkedAt} AS checked_at FROM pages p WHERE status = 'active' ORDER BY slug`).all(...(attributed ? [{primary: agent}] : [])) as Array<{
        id: number; rotate: number | null; slug: string; title: string; updated: string; verified_at: string | null; outcome: string | null; checked_at: string | null;
      }>;
      const now = clock.now();
      const items: OpenItem[] = [];
      for (const row of rows) {
        if (who.id !== (row.rotate ? alternate : agent)) continue;
        const anchor = Date.parse(row.verified_at ?? row.updated);
        const stale = row.outcome === 'stale';
        const due = stale ? Date.parse(row.checked_at ?? '') : anchor + knowledgeSchedule(retired.has(row.id)).checkDays * DAY_MS;
        if (!stale && due > now) continue;
        // Malformed legacy timestamps must not hide a page needing attention.
        items.push({ id: row.slug, words: `Re-check knowledge page ${row.slug}: ${row.title}${row.rotate ? " (independent check after three checks by the author)" : ""}`,
          openedAt: new Date(Number.isFinite(due) ? due : now).toISOString() });
      }
      return items;
    })();
  } };
}
