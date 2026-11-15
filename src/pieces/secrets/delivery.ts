import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../../core/data/database.js';
import { jobs, secretUses } from '../../core/data/schema.js';
import { secretName } from './input.js';
import { SecretRequests } from './requests.js';

/** Composition routes this destination to an authenticated runtime sink. Values
 * go straight from the key holder to that sink, never back through this service.
 * A fulfilled call acknowledges completed delivery. Output and errors are discarded.
 */
export interface SecretDeliveryHolder {
  handTo(secret: string, destination: { agent: string; job: string }): void | Promise<void>;
}

/** Trusted installed-code seam, not an outside operation. The outside door must
 * bind the caller to its job. No service grants or proof tickets are involved.
 * Without an attempt id each call is a new hand-off. A supplied stable id
 * replays metadata only; no started/failed/released attempt calls the holder twice.
 * A crash leaves started; it is never automatically replayed or called released.
 * Failed means no completed acknowledgement, not proof that no bytes escaped.
 * Neither failed nor started attempts are automatically retried.
 */
export class SecretDelivery {
  private requests: SecretRequests;
  private closed = false;
  private readonly running = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(private db: DataDatabase, private now: () => string, private holder: SecretDeliveryHolder, private readonly commit: <T>(write: () => T) => T = write => db.transaction(() => write())) {
    this.requests = new SecretRequests(db, now);
  }

  handTo(secret: string, job: string, attempt?: string): Promise<{ id: string; state: 'started' | 'released' | 'failed' }> {
    if (this.closed) return Promise.reject(Error('Secret delivery closed'));
    let resolve!: (value: { id: string; state: 'started' | 'released' | 'failed' }) => void, reject!: (error: unknown) => void;
    const work = new Promise<{ id: string; state: 'started' | 'released' | 'failed' }>((done, failed) => { resolve = done; reject = failed; });
    this.running.add(work);
    void work.finally(() => this.running.delete(work)).catch(() => {});
    // Publish before a trusted provider can synchronously reenter close().
    void this.perform(secret, job, attempt).then(resolve, reject);
    return work;
  }

  private async perform(secret: string, job: string, attempt?: string): Promise<{ id: string; state: 'started' | 'released' | 'failed' }> {
    secretName.parse(secret);
    z.string().min(1).parse(job);
    this.ownTransaction();
    const id = attempt === undefined ? `use-${randomUUID()}` : z.string().min(1).max(200).parse(attempt);
    const reserved = this.commit(() => {
      const tx = this.db;
      const target = tx.select({ agent: jobs.agent }).from(jobs).where(eq(jobs.id, job)).get();
      if (!target) throw Error('Secret delivery needs an existing job');
      const old = tx.select().from(secretUses).where(eq(secretUses.id, id)).get();
      if (old) {
        if (old.secret !== secret || old.job !== job || old.agent !== target.agent) throw Error('Secret use identity changed');
        return { prior: old };
      }
      if (!this.requests.grantFor(secret, target.agent, job)) throw Error('Secret delivery needs a current grant');
      tx.insert(secretUses).values({ id, secret, agent: target.agent, job, at: this.now(), state: 'started' }).run();
      return { destination: { agent: target.agent, job } };
    });
    if (reserved.prior) return { id, state: reserved.prior.state };
    const destination = reserved.destination!;
    // The audit transaction has committed before this potentially asynchronous
    // side effect. Revocation prevents subsequent dispatches, not one in flight.
    let state: 'released' | 'failed' = 'released';
    try { await this.holder.handTo(secret, destination); }
    catch { state = 'failed'; }
    // A failed metadata write leaves started even if the holder acknowledged.
    // Never downgrade a completed hand-off to failed because its audit failed.
    try {
      this.ownTransaction();
      this.commit(() => this.db.update(secretUses).set({ state }).where(eq(secretUses.id, id)).run());
    } catch { throw Error('Secret delivery completion could not be recorded'); }
    return { id, state };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = Promise.allSettled([...this.running]).then(() => {});
  }

  private ownTransaction(): void {
    if (this.closed) throw Error('Secret delivery closed');
    if (this.db.$client.inTransaction) throw Error('Secret delivery requires its own transaction');
  }
}
