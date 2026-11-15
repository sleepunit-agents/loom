import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeRawEvents, bridgeResume } from '../../core/data/schema.js';

export interface BridgeCheckpoint { session: string; sequence: number; resumeUrl: string }
const HOUR = 3_600_000;

/** Trusted adapter spool. Receipt and Discord cursor commit before platform ack.
 * Drain callbacks are synchronous and use this same database connection, so
 * normalisation and receipt removal either both commit or both roll back.
 * Raw reads reject expired events. Physical cleanup waits for any unrelated
 * SQL transaction to finish; callers must not hold transactions across awaits.
 */
export class BridgeEvents {
  private closed = false;
  private cancel?: () => void;
  private readonly cursors = new Map<string, Map<string, { at: string; row: number }>>();
  constructor(private db: DataDatabase, private clock: Clock) { this.assertAvailable(); this.sweep(); }

  retain(connection: string, id: string, event: Buffer, checkpoint?: BridgeCheckpoint): void {
    this.assertAvailable();
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
    this.assertAvailable();
    const row = this.db.select().from(bridgeResume).where(eq(bridgeResume.connection, connection)).get();
    return row && { session: row.session, sequence: row.sequence, resumeUrl: row.resumeUrl };
  }

  reset(connection: string): void {
    this.assertAvailable();
    this.db.delete(bridgeResume).where(eq(bridgeResume.connection, connection)).run();
  }

  /** One bounded pass. Returning false commits any writes but retains the raw
   * receipt for retry, without blocking later rows in this pass. Throwing rolls
   * back that event's writes; earlier committed events stay consumed. The limit
   * bounds rows examined, and the return value counts receipts removed. */
  drain(connection: string, consume: (id: string, event: Buffer, receivedAt: string) => void | boolean, limit = 64, scan: 'consume' | 'inspect' | 'peek' = 'consume'): number {
    this.assertAvailable();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw Error('Drain limit must be 1 through 64');
    this.sweep();
    let cursors = this.cursors.get(connection);
    if (!cursors) { cursors = new Map(); this.cursors.set(connection, cursors); }
    const cursor = scan === 'peek' ? undefined : cursors.get(scan);
    const read = (after?: typeof cursor) => this.db.select({ ...getTableColumns(bridgeRawEvents), position: sql<number>`rowid` }).from(bridgeRawEvents)
      .where(and(eq(bridgeRawEvents.connection, connection), after ? sql`(julianday(${bridgeRawEvents.receivedAt}) > julianday(${after.at}) or (julianday(${bridgeRawEvents.receivedAt}) = julianday(${after.at}) and rowid > ${after.row}))` : undefined))
      .orderBy(sql`julianday(${bridgeRawEvents.receivedAt})`, sql`rowid`).limit(limit).all();
    // Independent disposable scan positions keep a full batch of held/malformed
    // receipts from starving later arrivals. Inspection cannot advance delivery.
    let rows = read(cursor);
    if (!rows.length && cursor) { cursors.delete(scan); rows = read(); }
    let count = 0;
    for (const row of rows) {
      if (scan !== 'peek') cursors.set(scan, { at: row.receivedAt, row: row.position });
      this.db.transaction(tx => {
        // Recheck after earlier callbacks; a callback may have consumed a row.
        const key = and(eq(bridgeRawEvents.connection, connection), eq(bridgeRawEvents.id, row.id));
        const current = tx.select().from(bridgeRawEvents).where(key).get();
        if (!current || Date.parse(current.expiresAt) <= this.clock.now()) return;
        const result: unknown = consume(current.id, current.event, current.receivedAt);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') throw Error('Event consumer must be synchronous');
        if (result === false) return;
        tx.delete(bridgeRawEvents).where(key).run();
        count++;
      });
    }
    this.sweep();
    return count;
  }

  private assertAvailable(): void {
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
      // Finish at the same clock time once a synchronous transaction unwinds.
      // If a caller holds it across an await, keep the fallback timer instead
      // of spinning microtasks or joining that transaction.
      queueMicrotask(() => { if (!this.db.$client.inTransaction) this.sweep(); });
      return;
    }
    const now = new Date(this.clock.now()).toISOString();
    this.db.delete(bridgeRawEvents).where(sql`julianday(${bridgeRawEvents.expiresAt}) <= julianday(${now})`).run();
    const first = this.db.select({ expiresAt: bridgeRawEvents.expiresAt }).from(bridgeRawEvents)
      .orderBy(sql`julianday(${bridgeRawEvents.expiresAt})`).get();
    if (first) this.cancel = this.clock.at(Date.parse(first.expiresAt), () => this.sweep());
  }
  close(): void { this.closed = true; this.cancel?.(); this.cancel = undefined; this.cursors.clear(); }
}
