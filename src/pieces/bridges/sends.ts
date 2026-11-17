import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeIncoming, bridgeSends } from '../../core/data/schema.js';
import { BridgeReplyNotSent, postReply } from './outbound.js';

export type BridgeSend = typeof bridgeSends.$inferSelect;
/** How long an unsent reply waits before the next attempt. The daemon flushes at least this often. */
export const RETRY_UNSENT = 5000;
export interface SendTransport {
  /** Whether a post for this connection can be attempted now. A reply waits,
   * unclaimed, while this is false. Absent means always. */
  ready?(connection: typeof bridgeConnections.$inferSelect): boolean;
  /** Resolve the current connection. Suppress generated mentions in platform posts.
   * Throw BridgeReplyNotSent when refusing before any request is made. */
  post(connection: typeof bridgeConnections.$inferSelect, address: { channel: string; thread: string | null }, text: string): Promise<{ id: string }>;
}

/** Trusted in-process send queue on the approved shared schema. External callers
 * enter through their authenticated operation; this module owns no permissions.
 * One daemon owns a database. Construct once at startup, before draining sends.
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
    const recovered = this.commit(()=>db.update(bridgeSends).set({ state: 'uncertain' }).where(eq(bridgeSends.state, 'sending')).run());
    if (recovered.changes) changed();
  }

  queue(input: { id: string; incoming: string; text: string; held?: boolean }): BridgeSend {
    if (this.closed) throw new Error('Bridge sends closed');
    if (!input.id.trim() || !input.text.trim()) throw new Error('Reply needs an id and text');
    const result = this.commit(()=>this.db.transaction(tx => {
      const old = tx.select().from(bridgeSends).where(eq(bridgeSends.id, input.id)).get();
      if (old) {
        if (old.incoming !== input.incoming || old.text !== input.text) throw new Error('Reply id reused');
        return old;
      }
      const incoming = tx.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, input.incoming)).get();
      if (!incoming || incoming.state !== 'delivered') throw new Error('No delivered message for reply');
      return tx.insert(bridgeSends).values({ id: input.id, incoming: incoming.id,
        connection: incoming.connection, channel: incoming.channel, thread: incoming.thread,
        text: input.text, state: input.held ? 'held' : 'pending', createdAt: this.now(),
      }).returning().get();
    }));
    this.changed();
    return result;
  }

  /** Held replies may be released; uncertain replies require review and dismissal.
   * Releasing uncertainty would risk a duplicate message already received outside.
   */
  release(id: string): void { this.transition(id, 'held', 'pending'); }
  dismiss(id: string): void {
    const send = this.db.select().from(bridgeSends).where(eq(bridgeSends.id, id)).get();
    if (!send) throw new Error('No reply send');
    if (send.state === 'dismissed') return;
    if (send.state !== 'held' && send.state !== 'uncertain') throw new Error('Reply is not awaiting review');
    this.transition(id, send.state, 'dismissed');
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
      let postedId: string | undefined, notSent: BridgeReplyNotSent | undefined;
      try {
        const receipt = await postReply(connection.platform, send.text, async text => {
          const current = this.db.select().from(bridgeConnections).where(eq(bridgeConnections.id, connection.id)).get();
          if (this.closed || !current?.enabled || current.state !== 'connected'
            || current.platform !== connection.platform || current.workspace !== connection.workspace
            || current.botUser !== connection.botUser || current.agent !== connection.agent) throw new BridgeReplyNotSent(true);
          return this.transport.post(current, { channel: send.channel, thread: send.thread }, text);
        });
        postedId = receipt.id;
      } catch (error) {
        // Upstream errors can contain credentials and are never recorded. Only our own
        // refusal before the first request says the reply is still wholly unsent.
        if (error instanceof BridgeReplyNotSent) notSent = error;
      }
      if (notSent?.again) this.notBefore.set(send.id, Date.parse(this.now()) + RETRY_UNSENT);
      // Unsent goes back to wait for the connection, or to a person when waiting cannot help.
      const state = postedId ? 'sent' : notSent ? (notSent.again ? 'pending' : 'held') : 'uncertain';
      this.commit(()=>this.db.update(bridgeSends).set({ state, postedId: postedId ?? null })
        .where(and(eq(bridgeSends.id, send.id), eq(bridgeSends.state, 'sending'))).run());
      this.changed();
    }
  }

  /** Wait for any attempt already crossing the network before closing its DB. */
  async close(): Promise<void> { this.closed = true; await this.draining; }
}
