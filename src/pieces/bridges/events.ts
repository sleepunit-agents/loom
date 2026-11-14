import { and, eq, sql } from 'drizzle-orm';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeRawEvents, bridgeResume } from '../../core/data/schema.js';

export interface BridgeCheckpoint { session: string; sequence: number; resumeUrl: string }
const HOUR = 3_600_000;

/** Trusted adapter spool. Receipt and Discord cursor commit before platform ack.
 * Drain callbacks are synchronous and use this same database connection, so
 * normalisation and receipt removal either both commit or both roll back.
 */
export class BridgeEvents {
  private closed = false;
  private cancel?: () => void;
  constructor(private db: DataDatabase, private clock: Clock) { this.open(); this.sweep(); }

  retain(connection: string, id: string, event: Buffer, checkpoint?: BridgeCheckpoint): void {
    this.open();
    if (!id.trim()) throw Error('Event needs an id');
    const now = this.clock.now();
    this.db.transaction(tx => {
      const source = tx.select().from(bridgeConnections).where(eq(bridgeConnections.id, connection)).get();
      if (!source) throw Error('Unknown bridge connection');
      if (checkpoint) {
        if (source.platform !== 'discord' || !checkpoint.session || !checkpoint.resumeUrl
          || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0) throw Error('Invalid Discord checkpoint');
        const old = tx.select().from(bridgeResume).where(eq(bridgeResume.connection, connection)).get();
        if (old && (old.session !== checkpoint.session || old.sequence > checkpoint.sequence)) {
          throw Error('Reset Discord checkpoint before changing session or rewinding');
        }
        tx.insert(bridgeResume).values({ connection, ...checkpoint }).onConflictDoUpdate({
          target: bridgeResume.connection, set: checkpoint,
        }).run();
      }
      // Retries preserve both original bytes and their original deadline.
      tx.insert(bridgeRawEvents).values({ connection, id, event,
        receivedAt: new Date(now).toISOString(), expiresAt: new Date(now + HOUR).toISOString(),
      }).onConflictDoNothing().run();
    });
    this.sweep();
  }

  checkpoint(connection: string): BridgeCheckpoint | undefined {
    this.open();
    const row = this.db.select().from(bridgeResume).where(eq(bridgeResume.connection, connection)).get();
    return row && { session: row.session, sequence: row.sequence, resumeUrl: row.resumeUrl };
  }

  reset(connection: string): void {
    this.open();
    this.db.delete(bridgeResume).where(eq(bridgeResume.connection, connection)).run();
  }

  /** One bounded pass. Throwing leaves the failed event and its writes intact
   * for retry; successfully committed earlier events stay consumed. */
  drain(connection: string, consume: (id: string, event: Buffer) => void, limit = 64): number {
    this.open();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw Error('Drain limit must be 1 through 64');
    this.sweep();
    const rows = this.db.select().from(bridgeRawEvents).where(eq(bridgeRawEvents.connection, connection))
      .orderBy(sql`julianday(${bridgeRawEvents.receivedAt})`, bridgeRawEvents.id).limit(limit).all();
    let count = 0;
    for (const row of rows) {
      this.db.transaction(tx => {
        // Recheck after earlier callbacks; a callback may have consumed a row.
        const key = and(eq(bridgeRawEvents.connection, connection), eq(bridgeRawEvents.id, row.id));
        const current = tx.select().from(bridgeRawEvents).where(key).get();
        if (!current || Date.parse(current.expiresAt) <= this.clock.now()) return;
        const result: unknown = consume(current.id, current.event);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') throw Error('Event consumer must be synchronous');
        tx.delete(bridgeRawEvents).where(key).run();
        count++;
      });
    }
    this.sweep();
    return count;
  }

  private open(): void {
    if (this.closed) throw Error('Bridge events closed');
    if (this.db.$client.inTransaction) throw Error('Bridge events require their own transaction');
  }
  private sweep(): void {
    if (this.closed) return;
    this.cancel?.(); this.cancel = undefined;
    // A fake clock or a caller may fire the timer inside an unrelated SQL
    // transaction. Never let its rollback restore bytes after losing our timer.
    if (this.db.$client.inTransaction) {
      this.cancel = this.clock.at(this.clock.now() + 1, () => this.sweep());
      return;
    }
    const now = new Date(this.clock.now()).toISOString();
    this.db.delete(bridgeRawEvents).where(sql`julianday(${bridgeRawEvents.expiresAt}) <= julianday(${now})`).run();
    const first = this.db.select({ expiresAt: bridgeRawEvents.expiresAt }).from(bridgeRawEvents)
      .orderBy(sql`julianday(${bridgeRawEvents.expiresAt})`).get();
    if (first) this.cancel = this.clock.at(Date.parse(first.expiresAt), () => this.sweep());
  }
  close(): void { this.closed = true; this.cancel?.(); this.cancel = undefined; }
}
