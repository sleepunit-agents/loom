/** Wordless history kept after detailed turns expire. Uses the same connection
 * and fake clock as conversation writes; no background process or separate DB. */
import { and, eq, lt } from 'drizzle-orm';
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
    const cutoff = new Date(Date.parse(this.now()) - 90 * 86400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    return this.db.transaction(() => {
      const expired = this.db.select().from(turns).where(lt(turns.at, cutoff)).all();
      const groups = new Map<string, typeof expired>();
      for (const turn of expired) {
        const key = JSON.stringify([turn.conversation, turn.at.slice(0, 10)]);
        const group = groups.get(key) ?? []; group.push(turn); groups.set(key, group);
      }
      for (const group of groups.values()) {
        const conversation = group[0].conversation, day = group[0].at.slice(0, 10);
        // A second roll-up would lose the first group's median; reject late
        // backdated writes instead of silently corrupting the historical total.
        if (this.db.select().from(conversationDays).where(and(eq(conversationDays.conversation, conversation), eq(conversationDays.day, day))).get()) throw new Error('Day already rolled up');
        const latencies = group.filter(t => t.kind === 'reply' && t.latencyMs !== null).map(t => t.latencyMs!).sort((a, b) => a - b);
        const mid = Math.floor(latencies.length / 2);
        const medianLatencyMs = latencies.length === 0 ? 0 : latencies.length % 2 ? latencies[mid] : (latencies[mid - 1] + latencies[mid]) / 2;
        this.db.insert(conversationDays).values({ conversation, day,
          messages: group.filter(t => t.kind === 'message').length,
          replies: group.filter(t => t.kind === 'reply').length,
          actions: group.filter(t => t.kind === 'action').length,
          medianLatencyMs,
        }).run();
      }
      this.db.delete(turns).where(lt(turns.at, cutoff)).run();
      return expired.length;
    });
  }
}
