import { and, eq, sql } from 'drizzle-orm';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeFiles, bridgeIncoming } from '../../core/data/schema.js';

const RETENTION = 14 * 86400_000;

/** Slack's attachment cache on the shared schema. The daemon calls store after
 * fetching through its credential-owning adapter. Reads use the data endpoint.
 * One owner schedules exact expiry, including for files present at startup.
 */
export class BridgeFiles {
  private cancel?: () => void;
  private closed = false;
  constructor(private db: DataDatabase, private clock: Clock, private changed: () => void = () => {}) {
    this.sweep();
  }

  store(input: { connection: string; file: string; incoming: string; name: string; contents: Buffer }): void {
    if (this.closed) throw new Error('Bridge files closed');
    if (!input.file.trim() || !input.name.trim()) throw new Error('Attachment needs an id and name');
    this.db.transaction(tx => {
      const connection = tx.select().from(bridgeConnections).where(eq(bridgeConnections.id, input.connection)).get();
      const incoming = tx.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, input.incoming)).get();
      if (connection?.platform !== 'slack' || incoming?.connection !== input.connection) throw new Error('Attachment does not belong to this Slack connection');
      // A duplicate fetch must not reset the fourteen-day retention clock.
      // The key is the connection and the file id, so a file is kept under the first message that carried
      // it: the same Slack file shared again in a later message is not listed under that message
      // (bridges.file reads by message). Naming it there needs a row per message, which is a schema change.
      tx.insert(bridgeFiles).values({ ...input, fetchedAt: new Date(this.clock.now()).toISOString() }).onConflictDoNothing().run();
    });
    this.sweep();
    this.changed();
  }

  private sweep(): void {
    if (this.closed) return;
    this.cancel?.();
    this.cancel = undefined;
    const cutoff = new Date(this.clock.now() - RETENTION).toISOString();
    // UTC text accepts both whole seconds and milliseconds; date arithmetic
    // avoids lexical disagreement between equivalent timestamp spellings.
    const removed = this.db.delete(bridgeFiles).where(sql`julianday(${bridgeFiles.fetchedAt}) <= julianday(${cutoff})`).run();
    if (removed.changes) this.changed();
    const first = this.db.select({ fetchedAt: bridgeFiles.fetchedAt }).from(bridgeFiles)
      .orderBy(sql`julianday(${bridgeFiles.fetchedAt})`).get();
    if (first) this.cancel = this.clock.at(Date.parse(first.fetchedAt) + RETENTION, () => this.sweep());
  }

  /** Removing one cached file does not remove its incoming message or history. */
  remove(connection: string, file: string): void {
    if (this.closed) throw new Error('Bridge files closed');
    this.db.delete(bridgeFiles).where(and(eq(bridgeFiles.connection, connection), eq(bridgeFiles.file, file))).run();
    this.sweep();
    this.changed();
  }

  close(): void { this.closed = true; this.cancel?.(); this.cancel = undefined; }
}
