import { and, asc, eq, inArray, max } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeIncoming, bridgeSendFiles, bridgeSendParts, bridgeSends } from '../../core/data/schema.js';
import { BridgeReplyNotSent, postReply, replyParts, type ReplyAttempt } from './outbound.js';
import { STOP_WORD } from './incoming.js';

/** What the bot says where a stop word stopped a job, as the earlier bridge said it. */
export const STOPPED_LINE = 'Stopped here.';

import { SEND_FILES, SEND_FILES_BYTES, sendFileName } from './send-file-limit.js';
export interface SendFile { name: string; contents: Buffer }

export type BridgeSend = typeof bridgeSends.$inferSelect;
/** How long an unsent reply waits before the next attempt. The daemon flushes at least this often. */
export const RETRY_UNSENT = 5000;
export interface SendTransport {
  /** Whether a post for this connection can be attempted now. A reply waits,
   * unclaimed, while this is false. Absent means always. */
  ready?(connection: typeof bridgeConnections.$inferSelect): boolean;
  /** Resolve the current connection. Suppress generated mentions in platform posts.
   * Throw BridgeReplyNotSent when refusing before any request is made. */
  post(connection: typeof bridgeConnections.$inferSelect, address: { channel: string; thread: string | null }, text: string, files?: readonly SendFile[]): Promise<{ id: string }>;
}

/** A person's decision on one reply awaiting review, as one statement of the
 * rule. A held reply may be released to be sent or dismissed. An uncertain
 * reply may only be dismissed: the platform may already have it, and sending
 * again would risk posting it twice (docs/accepted-tradeoffs.md, "A reply in
 * doubt is never sent again"). The caller commits and publishes. */
export function reviewReply(db: DataDatabase, id: string, decision: 'release' | 'dismiss'): void {
  const send = db.select().from(bridgeSends).where(eq(bridgeSends.id, id)).get();
  if (!send) throw new Error('Unknown send');
  if (send.state !== 'held' && (decision !== 'dismiss' || send.state !== 'uncertain')) throw new Error('Reply is not awaiting this review');
  const changed = db.update(bridgeSends).set({ state: decision === 'release' ? 'pending' : 'dismissed' })
    .where(and(eq(bridgeSends.id, id), eq(bridgeSends.state, send.state))).run();
  if (!changed.changes) throw new Error('Reply state changed');
  dropSettledFiles(db);
}

/** The one rule for how long a post's files are kept: while the post may still be sent. A post that is
 * waiting (`pending`), being sent (`sending`), or held for a person who may release it (`held`) keeps
 * them. One that is `sent`, `dismissed`, or `uncertain` (never sent again) has no more use for them, and
 * they go in the write that puts it there, whichever path that was: the attempt itself, a person's
 * dismissal, or the start-up that finds a post a crash left mid-send. Called in the same transaction as
 * every such change, so no file outlives its post's last chance. */
export function dropSettledFiles(db: Pick<DataDatabase, 'delete' | 'select'>): void {
  db.delete(bridgeSendFiles).where(inArray(bridgeSendFiles.send, db.select({ id: bridgeSends.id }).from(bridgeSends).where(inArray(bridgeSends.state, ['sent', 'uncertain', 'dismissed'])))).run();
}

/** Trusted in-process send queue on the approved shared schema. External callers
 * enter through their authenticated operation; this module owns no permissions.
 * One daemon owns a database. Construct once at startup, before draining sends.
 *
 * A long reply is posted in parts, and each part the platform confirms is recorded
 * as it is confirmed (bridge_send_parts). A reply is one row whatever happens to it.
 * If an attempt stops part way, the row is `pending` when the next part provably
 * never left, so a later flush goes on from the parts on record; `held` when no
 * request can be built for it; `uncertain` when that part may have arrived. Nothing
 * confirmed is posted twice, and nothing in doubt is posted again.
 */
export class BridgeSends {
  private draining?: Promise<void>;
  private again=false;
  private closed = false;
  /** Replies that came back unsent, and when each may be tried again. Its own
   * write wakes the daemon, which flushes: without this wait a transport that
   * keeps refusing would be asked again at once, for ever. Memory only: a new
   * process starts with a new transport. */
  private readonly notBefore = new Map<string, number>();

  constructor(private db: DataDatabase, private transport: SendTransport,
    private now: () => string, private changed: () => void = () => {},
    private commit:<T>(write:()=>T)=>T=write=>db.transaction(write)) {
    // The app may have accepted the post before a crash lost its receipt.
    const recovered = this.commit(()=>{
      const left = db.update(bridgeSends).set({ state: 'uncertain' }).where(eq(bridgeSends.state, 'sending')).run();
      // Never sent again, so its files go too; and any a crash left beside a post already settled.
      dropSettledFiles(db);
      return left;
    });
    if (recovered.changes) changed();
  }

  /** `stopped` is loom's own line after a stop word (STOPPED_LINE): the one post made to a message that
   * was not delivered, addressed like any other to where that message was said. */
  queue(input: { id: string; incoming: string; text: string; held?: boolean; stopped?: boolean; files?: readonly SendFile[] }): BridgeSend {
    if (this.closed) throw new Error('Bridge sends closed');
    if (!input.id.trim() || !input.text.trim()) throw new Error('Reply needs an id and text');
    const queued: (typeof bridgeSendFiles.$inferInsert)[] = [];
    const result = this.commit(()=>this.db.transaction(tx => {
      queued.length = 0;
      const old = tx.select().from(bridgeSends).where(eq(bridgeSends.id, input.id)).get();
      if (old) {
        if (old.incoming !== input.incoming || old.text !== input.text) throw new Error('Reply id reused');
        // The same id is the same post, files and all. While the post still has its files they are compared;
        // once it is settled they are gone, and a repeat that names files cannot be told from the first.
        const kept = tx.select({ name: bridgeSendFiles.name, contents: bridgeSendFiles.contents }).from(bridgeSendFiles).where(eq(bridgeSendFiles.send, old.id)).orderBy(asc(bridgeSendFiles.position)).all();
        const given = input.files ?? [], settled = ['sent', 'uncertain', 'dismissed'].includes(old.state);
        if (!(settled && !kept.length) && (kept.length !== given.length || kept.some((file, at) => file.name !== sendFileName(given[at].name) || !file.contents.equals(given[at].contents)))) throw new Error('Reply id reused');
        return old;
      }
      const incoming = tx.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, input.incoming)).get();
      if (!incoming || !(input.stopped ? incoming.state === 'dropped' && incoming.reason === STOP_WORD && input.text === STOPPED_LINE : incoming.state === 'delivered')) throw new Error('No delivered message for reply');
      // The reply carries its own address, copied from the message it answers (place.ts): a message's
      // channel and thread never change, and the queue then needs no join to send.
      // A post's files are kept with it until it is settled (bridge_send_files), and go out with its last part.
      const files = input.files ?? [];
      const platform = tx.select({ platform: bridgeConnections.platform }).from(bridgeConnections).where(eq(bridgeConnections.id, incoming.connection)).get()?.platform;
      if (files.length && (platform !== 'discord' || files.length > SEND_FILES || files.some(file => !file.contents.byteLength)
        || files.reduce((sum, file) => sum + file.contents.byteLength, 0) > SEND_FILES_BYTES)) throw new Error('Files cannot be posted');
      files.forEach((file, position) => { queued.push({ send: input.id, position, name: sendFileName(file.name), contents: Buffer.from(file.contents) }); });
      const row = tx.insert(bridgeSends).values({ id: input.id, incoming: incoming.id,
        connection: incoming.connection, channel: incoming.channel, thread: incoming.thread,
        text: input.text, state: input.held ? 'held' : 'pending', createdAt: this.now(),
      }).returning().get();
      if (queued.length) tx.insert(bridgeSendFiles).values(queued).run();
      return row;
    }));
    this.changed();
    return result;
  }

  private transition(id: string, from: BridgeSend['state'], to: BridgeSend['state']): void {
    if (this.closed) throw new Error('Bridge sends closed');
    const result = this.commit(()=>this.db.update(bridgeSends).set({ state: to })
      .where(and(eq(bridgeSends.id, id), eq(bridgeSends.state, from))).run());
    if (!result.changes) throw new Error('Reply state changed');
    this.changed();
  }

  /** A single pass, with no retries of a post whose outcome is unknown. A reply
   * that was claimed but never left stays pending for a later flush, not this one. */
  flush(): Promise<void> {
    if (this.db.$client.inTransaction) throw new Error('Flush sends after committing the transaction');
    if (this.closed) return Promise.resolve();
    if (this.draining) { this.again=true; return this.draining; }
    // Publish the shared promise before a transport callback can reenter flush.
    this.draining = Promise.resolve().then(async() => { do { this.again=false; await this.drain(); } while(this.again&&!this.closed); }).finally(() => { this.draining = undefined; });
    return this.draining;
  }

  private async drain(): Promise<void> {
    const pending = this.db.select().from(bridgeSends).where(eq(bridgeSends.state, 'pending')).all();
    for (const send of pending) {
      if (this.closed) return;
      if ((this.notBefore.get(send.id) ?? 0) > Date.parse(this.now())) continue;
      this.notBefore.delete(send.id);
      const connection = this.db.select().from(bridgeConnections).where(eq(bridgeConnections.id, send.connection)).get();
      if (!connection?.enabled) { this.transition(send.id, 'pending', 'held'); continue; }
      // A reconnect can resume a pending send; it has not crossed the network yet.
      if (connection.state !== 'connected' || this.transport.ready?.(connection) === false) continue;
      const claim = this.commit(()=>this.db.update(bridgeSends).set({ state: 'sending' })
        .where(and(eq(bridgeSends.id, send.id), eq(bridgeSends.state, 'pending'))).run());
      if (!claim.changes) continue;
      this.changed();
      // Go on from the parts an earlier attempt, in this run or one before it, had confirmed.
      const posted = this.db.select({ last: max(bridgeSendParts.part) }).from(bridgeSendParts).where(eq(bridgeSendParts.send, send.id)).get()?.last;
      // The files go with the last part, so a long post reads in order and its files follow it.
      const files = this.db.select({ name: bridgeSendFiles.name, contents: bridgeSendFiles.contents }).from(bridgeSendFiles).where(eq(bridgeSendFiles.send, send.id)).orderBy(asc(bridgeSendFiles.position)).all();
      const parts = files.length ? replyParts(connection.platform, send.text).length : 0;
      let part = posted === null || posted === undefined ? 0 : posted + 1;
      const post = async (text: string) => {
        const current = this.db.select().from(bridgeConnections).where(eq(bridgeConnections.id, connection.id)).get();
        if (this.closed || !current?.enabled || current.state !== 'connected'
          || current.platform !== connection.platform || current.workspace !== connection.workspace
          || current.botUser !== connection.botUser || current.agent !== connection.agent) throw new BridgeReplyNotSent(true);
        const last = files.length > 0 && part++ === parts - 1;
        const address = { channel: send.channel, thread: send.thread };
        return last ? this.transport.post(current, address, text, files) : this.transport.post(current, address, text);
      };
      // On record before the next part is tried: a crash between two parts leaves exactly what is out.
      const confirmed = (part: number, postedId: string) => { this.commit(() => this.db.insert(bridgeSendParts).values({ send: send.id, part, postedId }).run()); };
      let attempt: ReplyAttempt;
      try {
        attempt = await postReply(connection.platform, send.text, posted === null || posted === undefined ? 0 : posted + 1, post, confirmed);
      } catch {
        // No part could be made of this text, so nothing was posted and waiting cannot help.
        attempt = { parts: 0, done: false, refused: new BridgeReplyNotSent(false) };
      }
      // What is not confirmed waits for the connection when it never left, goes to a person when waiting
      // cannot help, and is uncertain when the platform may already have it.
      const state = attempt.done ? 'sent' : !attempt.refused ? 'uncertain' : attempt.refused.again ? 'pending' : 'held';
      if (state === 'pending') this.notBefore.set(send.id, Date.parse(this.now()) + RETRY_UNSENT);
      this.commit(() => {
        this.db.update(bridgeSends).set({ state }).where(and(eq(bridgeSends.id, send.id), eq(bridgeSends.state, 'sending'))).run();
        dropSettledFiles(this.db);
      });
      this.changed();
    }
  }

  /** Wait for any attempt already crossing the network before closing its DB. */
  async close(): Promise<void> { this.closed = true; await this.draining; }
}
