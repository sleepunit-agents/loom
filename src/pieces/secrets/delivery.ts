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
 * Each call is a new hand-off, with a durable attempt before the holder runs.
 * A crash leaves started; it is never automatically replayed or called released.
 * Failed means no completed acknowledgement, not proof that no bytes escaped.
 * Neither failed nor started attempts are automatically retried.
 */
export class SecretDelivery {
  private requests: SecretRequests;
  constructor(private db: DataDatabase, private now: () => string, private holder: SecretDeliveryHolder) {
    this.requests = new SecretRequests(db, now);
  }

  async handTo(secret: string, job: string): Promise<{ id: string; state: 'released' | 'failed' }> {
    secretName.parse(secret);
    z.string().min(1).parse(job);
    this.ownTransaction();
    const id = `use-${randomUUID()}`;
    const destination = this.db.transaction(tx => {
      const target = tx.select().from(jobs).where(eq(jobs.id, job)).get();
      if (!target || !['starting', 'running', 'waiting'].includes(target.state)) throw Error('Secret delivery needs an active job');
      if (!this.requests.grantFor(secret, target.agent, job)) throw Error('Secret delivery needs a current grant');
      tx.insert(secretUses).values({ id, secret, agent: target.agent, job, at: this.now(), state: 'started' }).run();
      return { agent: target.agent, job };
    });
    // The audit transaction has committed before this potentially asynchronous
    // side effect. Revocation prevents subsequent dispatches, not one in flight.
    let state: 'released' | 'failed' = 'released';
    try { await this.holder.handTo(secret, destination); }
    catch { state = 'failed'; }
    // A failed metadata write leaves started even if the holder acknowledged.
    // Never downgrade a completed hand-off to failed because its audit failed.
    try {
      this.ownTransaction();
      this.db.update(secretUses).set({ state }).where(eq(secretUses.id, id)).run();
    } catch { throw Error('Secret delivery completion could not be recorded'); }
    return { id, state };
  }

  private ownTransaction(): void {
    if (this.db.$client.inTransaction) throw Error('Secret delivery requires its own transaction');
  }
}
