/** Trusted bridge ingress. Platform adapters supply authenticated event fields;
 * person identity comes exclusively from household person links. */
import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { Conversations } from '../../core/conversations/index.js';
import { bridgeConnections, bridgeChannelFilters, bridgeChannels, bridgePeople, bridgeIncoming, inbox } from '../../core/data/schema.js';

export interface IncomingMessage {
  /** Stable platform message id, scoped to this connection by the service. */
  id: string;
  connection: string;
  channel: string;
  parent?: string;
  thread?: string;
  isDm: boolean;
  user: string;
  text: string;
  postedAt: string;
  mentions: readonly string[];
  bot?: boolean;
  webhook?: boolean;
}

export class BridgeIncoming {
  private readonly conversations: Conversations;
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString()) {
    this.conversations = new Conversations(db, now);
  }

  /** Atomically records the event, turn, conversation and unified inbox item.
   * Duplicate events never append a second turn. Held events require explicit
   * retry with the platform envelope (kept by the raw-event adapter). The trusted
   * spool supplies its original receipt time when processing was delayed. */
  receive(message: IncomingMessage, retryHeld = false, receivedAt?: string): typeof bridgeIncoming.$inferSelect {
    return this.db.transaction(() => {
      const id = `bi:${JSON.stringify([message.connection, message.id])}`;
      const existing = this.db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, id)).get();
      if (existing) {
        if (existing.channel !== message.channel || existing.thread !== (message.thread ?? null) || existing.isDm !== message.isDm || existing.user !== message.user || existing.text !== message.text || existing.postedAt !== message.postedAt) throw new Error('Incoming id reused for a different message');
        if (existing.state !== 'held' || !retryHeld) return existing;
      }
      const connection = this.db.select().from(bridgeConnections).where(eq(bridgeConnections.id, message.connection)).get();
      if (!connection) throw new Error('Unknown bridge connection');
      const channel = message.parent ?? message.channel;
      const route = this.db.select().from(bridgeChannels).where(and(eq(bridgeChannels.platform, connection.platform), eq(bridgeChannels.workspace, connection.workspace), eq(bridgeChannels.channel, channel))).get();
      const filters = this.db.select().from(bridgeChannelFilters).where(eq(bridgeChannelFilters.connection, connection.id)).all();
      const peers = this.db.select().from(bridgeConnections).where(and(eq(bridgeConnections.platform, connection.platform), eq(bridgeConnections.workspace, connection.workspace))).all();
      const senders = peers.filter(p => p.botUser === message.user);
      const sender = senders[0];
      const link = this.db.select().from(bridgePeople).where(and(eq(bridgePeople.platform, connection.platform), eq(bridgePeople.workspace, connection.workspace), eq(bridgePeople.user, message.user))).get();
      let state: 'held' | 'dropped' | 'delivered' = 'delivered';
      let reason: string | null = null;
      if (!connection.enabled) { state = 'held'; reason = 'Connection disabled'; }
      else if (filters.some(f => f.rule === 'ignore' && f.channel === channel) || (filters.some(f => f.rule === 'only') && !filters.some(f => f.rule === 'only' && f.channel === channel))) { state = 'dropped'; reason = 'Channel filtered'; }
      else if (message.user === connection.botUser) { state = 'dropped'; reason = 'Own message'; }
      else if (peers.some(p => p.botUser === connection.botUser && p.agent !== connection.agent)) { state = 'held'; reason = 'Ambiguous connection agent'; }
      else if (new Set(senders.map(p => p.agent)).size > 1) { state = 'held'; reason = 'Ambiguous bot identity'; }
      else if ((message.bot || message.webhook || sender) && (!sender || !route?.botsMayTalk)) { state = 'dropped'; reason = 'Unknown bot or bots disabled'; }
      else if (!message.isDm && !message.mentions.includes(connection.botUser)) {
        if (peers.some(p => message.mentions.includes(p.botUser)) || route?.answers !== connection.agent) { state = 'dropped'; reason = 'Another agent or no channel answer'; }
      }
      const at = this.now();
      const row = existing ?? this.db.insert(bridgeIncoming).values({ id, connection: connection.id, channel: message.channel, thread: message.thread, isDm: message.isDm, user: message.user, text: message.text, postedAt: message.postedAt, receivedAt: receivedAt ?? at, state: 'pending' }).returning().get();
      let conversation: string | null = null;
      if (state === 'delivered') {
        // Include workspace and the real channel even for DMs: outside user ids
        // and thread ids are not globally unique. Never accept a claimed member.
        const place = JSON.stringify([connection.workspace, message.channel, message.thread ?? null]);
        const opened = this.conversations.open({ agent: connection.agent, venue: connection.platform, place, label: message.thread ?? message.channel, member: message.isDm && !sender ? link?.member : null });
        conversation = opened.id;
        const fromKind = sender ? 'agent' : link ? 'person' : 'unknown';
        const fromId = sender?.agent ?? link?.member ?? null;
        // Two connections can speak for the same agent in the same place.
        // Record both receipts, but deliver the platform message only once.
        const sourceId = JSON.stringify([connection.workspace, message.channel, message.id]);
        const delivered = this.db.select().from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.to, connection.agent), eq(inbox.source, connection.platform), eq(inbox.sourceId, sourceId))).get();
        if (!delivered) {
          this.conversations.turn({ conversation, kind: 'message', fromKind, fromId });
          this.conversations.send({ toKind: 'agent', to: connection.agent, conversation, source: connection.platform, sourceId, fromKind, fromId, words: message.text, refs: [id] });
        }
      }
      return this.db.update(bridgeIncoming).set({ state, reason, member: sender ? null : link?.member ?? null, conversation, deliveredAt: state === 'delivered' ? at : null }).where(eq(bridgeIncoming.id, row.id)).returning().get()!;
    });
  }
}
