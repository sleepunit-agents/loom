import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { approvals, changes, inbox, jobs, secretRequests, triggers } from '../data/schema.js';
import type { TriggerEngine } from './triggers.js';

/** Stable watch names shared by the source writers and trigger creators. */
export const tempoWatch = {
  change: (id: string) => `change:${id}`,
  approval: (id: string) => `approval:${id}`,
  question: (id: string) => `question:${id}`,
  secret: (id: string) => `secret-request:${id}`,
  job: (id: string) => `job:${id}`,
};

/** Call after the source transaction commits, never from inside it. Read the
 * durable result rather than trusting an external notification's payload.
 * Repeated callbacks/recovery replay use the same event id, so TriggerEngine
 * persists deduplication, including while the recipient is paused. */
export class TempoSources {
  private closed = false;
  /** Stop late source notifications before the shared database is closed. */
  close(): void { this.closed = true; }
  constructor(private db: DataDatabase, private engine: Pick<TriggerEngine, 'event'>) {}

  /** Recover the commit-to-callback gap after restart. Only active watches are
   * read; the normal event log deduplicates callbacks already delivered. Changes
   * owns its revision: never invent one from the current snapshot or timestamp.
   * This recovers the latest durable outcome, not intermediate offline changes.
   */
  recover(changeRevision?: (id: string) => string | undefined): void {
    if (this.closed) return;
    const watches = new Set<string>();
    for (const row of this.db.select({ kind: triggers.sourceKind, watches: triggers.watches }).from(triggers).where(eq(triggers.enabled, true)).all()) {
      if (this.closed) return;
      if (!row.watches || row.kind === 'time') continue;
      const key = JSON.stringify([row.kind, row.watches]);
      if (watches.has(key)) continue;
      watches.add(key);
      const prefixes = row.kind === 'pull-request' ? ['change'] : row.kind === 'job' ? ['job'] : ['approval', 'question', 'secret-request'];
      for (const prefix of prefixes) {
        if (!row.watches.startsWith(`${prefix}:`)) continue;
        const id = row.watches.slice(prefix.length + 1);
        if (!id) continue;
        if (prefix === 'change') {
          const revision = changeRevision?.(id);
          if (revision) this.change(id, revision);
        } else if (prefix === 'approval') this.approval(id);
        else if (prefix === 'question') this.question(id);
        else if (prefix === 'secret-request') this.secret(id);
        else this.job(id);
      }
    }
  }

  change(id: string, revision: string): void {
    if (this.closed) return;
    if (!revision) throw new Error('A change needs its durable source revision');
    const row = this.db.select().from(changes).where(eq(changes.id, id)).get();
    if (!row) return;
    // The Changes service supplies its persisted occurrence revision, including
    // check/review transitions. A snapshot hash alone would lose A -> B -> A.
    const event = createHash('sha256').update(JSON.stringify(['change', id, revision])).digest('hex');
    this.engine.event('pull-request', tempoWatch.change(id), `change:${event}`);
  }

  approval(id: string): void {
    if (this.closed) return;
    const row = this.db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (!row?.decidedAt || !['allowed', 'denied', 'used'].includes(row.state)) return;
    // Spending an allowed answer must not produce a second answer event.
    this.engine.event('answer', tempoWatch.approval(id), JSON.stringify(['approval', id, row.decidedAt, row.decidedBy]));
  }

  question(id: string): void {
    if (this.closed) return;
    const row = this.db.select().from(inbox).where(eq(inbox.id, id)).get();
    if (!row?.answeredAt || row.state !== 'answered') return;
    this.engine.event('answer', tempoWatch.question(id), JSON.stringify(['question', id, row.answeredAt, row.answer, row.answerText]));
  }

  secret(id: string): void {
    if (this.closed) return;
    const row = this.db.select().from(secretRequests).where(eq(secretRequests.id, id)).get();
    if (!row?.answeredAt || !['allowed', 'denied', 'revoked'].includes(row.state)) return;
    // Revoking an earlier grant is not a new answer to the original request.
    this.engine.event('answer', tempoWatch.secret(id), JSON.stringify(['secret-request', id, row.answeredAt, row.answeredBy]));
  }

  job(id: string): void {
    if (this.closed) return;
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row?.endedAt || !['done', 'failed', 'stopped', 'lost'].includes(row.state)) return;
    this.engine.event('job', tempoWatch.job(id), JSON.stringify(['job', id, row.endedAt, row.state]));
  }
}
