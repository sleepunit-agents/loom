import { DAY_MS } from '../../core/day.js';
import { and, eq, sql } from 'drizzle-orm';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeFileMessages, bridgeFiles, bridgeIncoming } from '../../core/data/schema.js';

const RETENTION = 14 * DAY_MS;
/** The largest kept file a body, or a member's page, is handed whole (bridges.file). A Discord attachment
 * larger than this is not fetched at all: it stays a link in the message's words. */
export const HANDED_FILE_BYTES = 8 * 1024 * 1024;

/** The attachment cache on the shared schema, for both platforms: a Slack message's files, fetched with
 * the connection's credential, and a Discord message's, fetched from Discord's signed links. The daemon calls store after
 * fetching through its credential-owning adapter. Reads use the data endpoint.
 * One owner schedules exact expiry, including for files present at startup.
 *
 * A file's bytes are kept once, by connection and Slack file id. Which messages carried it is
 * `bridge_file_messages` and nowhere else (the file's own row names no message): the same file shared in a second message is linked to that message too (carry)
 * and is not fetched again. A message's files are read through its links (bridges.file), so the links say
 * who may read a file. A file is removed with its links after fourteen days from its first fetch; the files
 * of a private direct message go earlier, with its words (core/conversations/private-bridge-words.ts).
 */
export class BridgeFiles {
  private cancel?: () => void;
  private closed = false;
  constructor(private db: DataDatabase, private clock: Clock, private changed: () => void = () => {}) {
    this.sweep();
  }

  /** The message must be one of this connection's. */
  private belongs(tx: Pick<DataDatabase, 'select'>, input: { connection: string; incoming: string }): void {
    const connection = tx.select().from(bridgeConnections).where(eq(bridgeConnections.id, input.connection)).get();
    const incoming = tx.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, input.incoming)).get();
    if (!connection || incoming?.connection !== input.connection) throw new Error('Attachment does not belong to this connection');
  }

  store(input: { connection: string; file: string; incoming: string; name: string; contents: Buffer }): void {
    if (this.closed) throw new Error('Bridge files closed');
    if (!input.file.trim() || !input.name.trim()) throw new Error('Attachment needs an id and name');
    this.db.transaction(tx => {
      this.belongs(tx, input);
      // A duplicate fetch must not reset the fourteen-day retention clock, or replace what is kept.
      tx.insert(bridgeFiles).values({ connection: input.connection, file: input.file, name: input.name, contents: input.contents, fetchedAt: new Date(this.clock.now()).toISOString() }).onConflictDoNothing().run();
      tx.insert(bridgeFileMessages).values({ connection: input.connection, file: input.file, incoming: input.incoming }).onConflictDoNothing().run();
    });
    this.sweep();
    this.changed();
  }

  /** List files that are already kept under one more message that carried them. Returns the ids that
   * are not kept on this connection, which the caller has still to fetch. */
  carry(input: { connection: string; incoming: string; files: readonly string[] }): string[] {
    if (this.closed) throw new Error('Bridge files closed');
    const missing = this.db.transaction(tx => {
      this.belongs(tx, input);
      return input.files.filter(file => {
        if (!tx.select({ file: bridgeFiles.file }).from(bridgeFiles).where(and(eq(bridgeFiles.connection, input.connection), eq(bridgeFiles.file, file))).get()) return true;
        tx.insert(bridgeFileMessages).values({ connection: input.connection, file, incoming: input.incoming }).onConflictDoNothing().run();
        return false;
      });
    });
    if (missing.length < input.files.length) this.changed();
    return missing;
  }

  private sweep(): void {
    if (this.closed) return;
    this.cancel?.();
    this.cancel = undefined;
    const cutoff = new Date(this.clock.now() - RETENTION).toISOString();
    // UTC text accepts both whole seconds and milliseconds; date arithmetic
    // avoids lexical disagreement between equivalent timestamp spellings.
    const expired = sql`julianday(${bridgeFiles.fetchedAt}) <= julianday(${cutoff})`;
    const removed = this.db.transaction(tx => {
      const old = tx.select({ connection: bridgeFiles.connection, file: bridgeFiles.file }).from(bridgeFiles).where(expired).all();
      for (const row of old) tx.delete(bridgeFileMessages).where(and(eq(bridgeFileMessages.connection, row.connection), eq(bridgeFileMessages.file, row.file))).run();
      return tx.delete(bridgeFiles).where(expired).run().changes;
    });
    if (removed) this.changed();
    const first = this.db.select({ fetchedAt: bridgeFiles.fetchedAt }).from(bridgeFiles)
      .orderBy(sql`julianday(${bridgeFiles.fetchedAt})`).get();
    if (first) this.cancel = this.clock.at(Date.parse(first.fetchedAt) + RETENTION, () => this.sweep());
  }

  /** Removing one cached file does not remove its incoming message or history. */
  remove(connection: string, file: string): void {
    if (this.closed) throw new Error('Bridge files closed');
    this.db.transaction(tx => {
      tx.delete(bridgeFileMessages).where(and(eq(bridgeFileMessages.connection, connection), eq(bridgeFileMessages.file, file))).run();
      tx.delete(bridgeFiles).where(and(eq(bridgeFiles.connection, connection), eq(bridgeFiles.file, file))).run();
    });
    this.sweep();
    this.changed();
  }

  close(): void { this.closed = true; this.cancel?.(); this.cancel = undefined; }
}
