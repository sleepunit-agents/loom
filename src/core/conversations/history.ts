/** Wordless history kept after detailed turns expire. Uses the same connection
 * and fake clock as conversation writes; no background process or separate DB. */
import { DAY_MS } from '../day.js';
import { lt, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { agentStatus, conversationDays, findings, turns } from '../data/schema.js';

export class ConversationHistory {
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString()) {}

  status(agent: string, state: typeof agentStatus.$inferInsert['state'], work: string): void {
    const changedAt = this.now();
    this.db.insert(agentStatus).values({ agent, state, work, changedAt }).onConflictDoUpdate({ target: agentStatus.agent, set: { state, work, changedAt } }).run();
  }

  finding(input: typeof findings.$inferInsert): void {
    this.db.insert(findings).values(input).onConflictDoUpdate({
      target: [findings.conversation, findings.day, findings.turnSeq, findings.measure], set: { score: input.score, text: input.text },
    }).run();
  }

  /** Keep complete UTC days: an in-progress day cannot acquire a second median
   * later. Thus a turn is kept at least 90 days, at most 91 until the next sweep.
   * Lifetime turn_count is deliberately unchanged, so sequence numbers never repeat.
   */
  rollup(): number {
    const cutoff = new Date(Date.parse(this.now()) - 90 * DAY_MS).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    return this.db.transaction(() => {
      const days = this.db.all<typeof conversationDays.$inferSelect>(sql`
        WITH expired AS (
          SELECT *, substr(at, 1, 10) AS day FROM turns WHERE at < ${cutoff}
        ), ranked AS (
          SELECT conversation, day, latency_ms,
            row_number() OVER (PARTITION BY conversation, day ORDER BY latency_ms) AS position,
            count(*) OVER (PARTITION BY conversation, day) AS total
          FROM expired WHERE kind = 'reply' AND latency_ms IS NOT NULL
        ), medians AS (
          SELECT conversation, day, avg(latency_ms) AS latency
          FROM ranked WHERE position IN ((total + 1) / 2, (total + 2) / 2)
          GROUP BY conversation, day
        )
        SELECT e.conversation, e.day,
          sum(e.kind = 'message') AS messages, sum(e.kind = 'reply') AS replies,
          sum(e.kind = 'action') AS actions, coalesce(m.latency, 0) AS medianLatencyMs
        FROM expired e LEFT JOIN medians m ON m.conversation = e.conversation AND m.day = e.day
        GROUP BY e.conversation, e.day
      `);
      // Existing days reject late backdated records instead of silently losing
      // the first group's median. Normal turn writes always use the current clock.
      for (const day of days) this.db.insert(conversationDays).values(day).run();
      return this.db.delete(turns).where(lt(turns.at, cutoff)).run().changes;
    });
  }
}
