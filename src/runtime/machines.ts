import { inboxContentChanged } from '../core/tempo/volume.js';
/** Trusted worker health records. Authentication of a worker belongs at the door. */
import { and, eq, isNull } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { machineFacts } from './machine-facts.js';
import { boxes, boxFacts, inbox } from '../core/data/schema.js';
import { Conversations } from '../core/conversations/index.js';

export const MACHINE_SILENCE_MS = 120_000;
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
      if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(box.lastSeenAt ?? box.enrolledAt)) throw new Error('Invalid machine time');
      if (reported !== undefined) {
        // Owner labels are a separate source of truth, including a fact that
        // overlaps a report. Omitted facts preserve the previous report.
        this.db.delete(boxFacts).where(and(eq(boxFacts.box, id), eq(boxFacts.fromOwner, false))).run();
        if (reported.length) this.db.insert(boxFacts).values(reported.map(fact => ({ box: id, fact, fromOwner: false }))).onConflictDoNothing().run();
      }
      const resolved = this.db.update(inbox).set({ state: 'resolved', resolution: 'Machine is reporting again', changedAt: at })
        .where(and(eq(inbox.toKind, 'person'), eq(inbox.to, box.owner), eq(inbox.source, 'notice'), eq(inbox.sourceId, outage(box)), eq(inbox.state, 'waiting'))).returning().all();
      for (const item of resolved) inboxContentChanged(this.db, {kind:item.toKind,id:item.to}, item.id);
      return this.db.update(boxes).set({ lastSeenAt: at }).where(eq(boxes.id, id)).returning().get()!;
    }, { behavior: 'immediate' });
  }

  /** One private notice per owner/outage, also across service/process restarts.
   * A same-machine or report-only worker still needs to report its health. */
  sweep(silenceMs = MACHINE_SILENCE_MS): typeof inbox.$inferSelect[] {
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
