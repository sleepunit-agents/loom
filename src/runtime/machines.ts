/** Trusted worker health records. Authentication of a worker belongs at the door. */
import { and, eq, isNull } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { machineFacts } from './machine-facts.js';
import { boxes, boxFacts, inbox } from '../core/data/schema.js';
import { Conversations } from '../core/conversations/index.js';
import { SILENCE_MS } from './silence.js';

type Box = typeof boxes.$inferSelect;
const outage = (box: Box) => `machine-silent:${JSON.stringify([box.id, box.lastSeenAt ?? box.enrolledAt])}`;

/** Timers belong to the composition root, so tests and callers can supply time. */
export class Machines {
  constructor(readonly db: DataDatabase, readonly now: () => string) {}

  heartbeat(id: string, facts?: readonly string[]): Box {
    const reported = facts === undefined ? undefined : machineFacts.parse(facts);
    return this.db.transaction(() => {
      const box = this.db.select().from(boxes).where(and(eq(boxes.id, id), isNull(boxes.revokedAt))).get();
      if (!box) throw new Error('Machine not available');
      const at = this.now();
      if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid machine time');
      // The stamp is always this server's present time, also when that is earlier than the stamp before it.
      // After the server's clock is set back, refusing the report would fail every worker call until the
      // clock caught up, and a kept future stamp would hide the machine from placement for as long.
      if (reported !== undefined) {
        // Owner labels are a separate source of truth, including a fact that
        // overlaps a report. Omitted facts preserve the previous report.
        this.db.delete(boxFacts).where(and(eq(boxFacts.box, id), eq(boxFacts.fromOwner, false))).run();
        if (reported.length) this.db.insert(boxFacts).values(reported.map(fact => ({ box: id, fact, fromOwner: false }))).onConflictDoNothing().run();
      }
      new Conversations(this.db, () => at).resolveSource('notice', outage(box), 'Machine is reporting again', { kind: 'person', id: box.owner });
      return this.db.update(boxes).set({ lastSeenAt: at }).where(eq(boxes.id, id)).returning().get()!;
    }, { behavior: 'immediate' });
  }

  /** One private notice per owner/outage, also across service/process restarts.
   * A same-machine or report-only worker still needs to report its health. */
  sweep(silenceMs = SILENCE_MS): typeof inbox.$inferSelect[] {
    if (!Number.isFinite(silenceMs) || silenceMs <= 0) throw new Error('Invalid silence interval');
    const at = this.now(), now = Date.parse(at);
    if (!Number.isFinite(now)) throw new Error('Invalid machine time');
    return this.db.transaction(() => {
      const notices = new Conversations(this.db, () => at);
      return this.db.select().from(boxes).where(and(eq(boxes.alwaysOn, true), isNull(boxes.revokedAt))).all()
        .filter(box => now - Date.parse(box.lastSeenAt ?? box.enrolledAt) > silenceMs)
        .map(box => notices.send({ toKind: 'person', to: box.owner, member: box.owner, source: 'notice', sourceId: outage(box),
          fromKind: 'unknown', words: `Machine ${box.name} has stopped reporting.`, refs: [box.id] }));
    }, { behavior: 'immediate' });
  }
}
