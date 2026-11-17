/** Trusted bridge ingress. Platform adapters supply authenticated event fields;
 * person identity comes exclusively from household person links. */
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { Conversations } from '../../core/conversations/index.js';
import { incomingId, inboxSourceId, parseIncomingId } from './keys.js';
import { conversationPlace } from './place.js';
import { bridgeConnections, bridgeChannelFilters, bridgeChannels, bridgePeople, bridgeIncoming, bridgeSends, inbox, inboxRefs } from '../../core/data/schema.js';

export interface IncomingMessage {
  /** Stable platform message id, scoped to this connection by the service. */
  id: string;
  connection: string;
  channel: string;
  parent?: string;
  thread?: string;
  isDm: boolean;
  /** Authenticated channel kind; group DMs are not private to one sender. */
  groupDm?: boolean;
  user: string;
  text: string;
  postedAt: string;
  mentions: readonly string[];
  /** The outside user whose message this one explicitly answers, when the platform says: the author of
   * the message a Discord reply points at, or of the root a Slack thread reply hangs under. */
  repliesTo?: string;
  bot?: boolean;
  webhook?: boolean;
}

/** Stored words that are empty were sent empty, erased at the keep time
 * (core/conversations/private-bridge-words.ts) or never kept because the message
 * was dropped; none of these can be compared. */
function sameMessage(row:Pick<typeof bridgeIncoming.$inferSelect,'channel'|'thread'|'isDm'|'user'|'text'|'postedAt'>,message:IncomingMessage){
 return row.channel===message.channel&&row.thread===(message.thread??null)&&row.isDm===message.isDm
  &&row.user===message.user&&(row.text===''||row.text===message.text)&&row.postedAt===message.postedAt;
}

export class BridgeIncoming {
  private readonly conversations: Conversations;
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString()) {
    this.conversations = new Conversations(db, now);
  }

  /** Atomically records the event, turn, conversation and unified inbox item.
   * Duplicate events never append a second turn. A held event is tried again
   * only when asked: with the platform envelope while the raw-event adapter
   * still has it, and from its own row afterwards (retry). The trusted spool
   * supplies its original receipt time when processing was delayed. */
  receive(message: IncomingMessage, retryHeld = false, receivedAt?: string): typeof bridgeIncoming.$inferSelect {
    return this.db.transaction(() => {
      const id = incomingId(message.connection, message.id);
      const existing = this.db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, id)).get();
      if (existing) {
        if (!sameMessage(existing,message)) throw new Error('Incoming id reused for a different message');
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
      // Who the message is addressed to: whoever it mentions, the author of the message it explicitly
      // replies to, and the bot whose own message its thread hangs under. Nothing looser counts: a bot
      // that has merely spoken in the thread, or spoke last in the room, is not addressed. A thread's root
      // is known as a bot's only if loom posted it, and a reply posted in parts records its last part
      // (docs/accepted-tradeoffs.md, "Only the last part of a long reply is a known thread root").
      const addressed = new Set(message.mentions);
      if (message.repliesTo) addressed.add(message.repliesTo);
      if (message.thread) {
        const root = this.db.select({ connection: bridgeSends.connection }).from(bridgeSends)
          .where(and(inArray(bridgeSends.connection, peers.map(p => p.id)), eq(bridgeSends.channel, channel), eq(bridgeSends.postedId, message.thread))).get();
        const poster = root && peers.find(p => p.id === root.connection);
        if (poster) addressed.add(poster.botUser);
      }
      let state: 'held' | 'dropped' | 'delivered' = 'delivered';
      let reason: string | null = null;
      let matchedMember = sender ? null : link?.member ?? null;
      if (!connection.enabled) { state = 'held'; reason = 'Connection disabled'; }
      else if (filters.some(f => f.rule === 'ignore' && f.channel === channel) || (filters.some(f => f.rule === 'only') && !filters.some(f => f.rule === 'only' && f.channel === channel))) { state = 'dropped'; reason = 'Channel filtered'; }
      else if (message.user === connection.botUser) { state = 'dropped'; reason = 'Own message'; }
      else if (peers.some(p => p.botUser === connection.botUser && p.agent !== connection.agent)) { state = 'held'; reason = 'Ambiguous connection agent'; }
      // A Discord bot's session hears every direct message to the bot, whichever guild its connection
      // names. With enabled connections for one bot in two guilds both would deliver it, as two
      // conversations (within one guild the copies are one Inbox item, below). Settings refuses that
      // setup; a database that has it anyway delivers through neither.
      else if (message.isDm && connection.platform === 'discord' && this.db.select({ id: bridgeConnections.id }).from(bridgeConnections)
        .where(and(eq(bridgeConnections.platform, 'discord'), eq(bridgeConnections.botUser, connection.botUser), eq(bridgeConnections.enabled, true), ne(bridgeConnections.workspace, connection.workspace))).get()) { state = 'held'; reason = 'Bot is connected in another guild'; }
      else if (new Set(senders.map(p => p.agent)).size > 1) { state = 'held'; reason = 'Ambiguous bot identity'; }
      else if ((message.bot || message.webhook || sender) && (!sender || !route?.botsMayTalk)) { state = 'dropped'; reason = 'Unknown bot or bots disabled'; }
      else if (!message.isDm && !addressed.has(connection.botUser)) {
        if (peers.some(p => addressed.has(p.botUser)) || route?.answers !== connection.agent) { state = 'dropped'; reason = 'Another agent or no channel answer'; }
      }
      const at = this.now();
      const row = existing ?? this.db.insert(bridgeIncoming).values({ id, connection: connection.id, channel: message.channel, thread: message.thread, isDm: message.isDm, user: message.user, text: message.text, postedAt: message.postedAt, receivedAt: receivedAt ?? at, state: 'pending',
        // What admission reads and nothing else keeps, so a held message can be tried again from this row.
        mentions: JSON.stringify(message.mentions), repliesTo: message.repliesTo ?? null, parent: message.parent ?? null,
        groupDm: !!message.groupDm, bot: !!message.bot, webhook: !!message.webhook }).returning().get();
      let conversation: string | null = null;
      let deliveredAt = at;
      if (state === 'delivered') {
        // Include workspace and the real channel even for DMs: outside user ids
        // and thread ids are not globally unique. Never accept a claimed member.
        const sourceId = inboxSourceId(connection.workspace, message.channel, message.id);
        const delivered = this.db.select().from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.to, connection.agent), eq(inbox.source, connection.platform), eq(inbox.sourceId, sourceId))).get();
        const fromKind = sender ? 'agent' : link ? 'person' : 'unknown';
        const fromId = sender?.agent ?? link?.member ?? null;
        if (delivered) {
          if (!delivered.conversation) throw Error('Bridge delivery scope missing');
          const original = this.db.select({ id: bridgeIncoming.id, connection: bridgeIncoming.connection, user: bridgeIncoming.user,
            channel: bridgeIncoming.channel, thread: bridgeIncoming.thread, isDm: bridgeIncoming.isDm, text: bridgeIncoming.text, postedAt: bridgeIncoming.postedAt })
            .from(inboxRefs).innerJoin(bridgeIncoming, eq(bridgeIncoming.id, inboxRefs.ref))
            .where(and(eq(inboxRefs.item, delivered.id), eq(bridgeIncoming.state, 'delivered'))).all()
            .find(row => row.id === incomingId(row.connection, message.id));
          if (!original || !sameMessage(original,message)) throw Error('Bridge delivery identity changed');
          deliveredAt = delivered.at;
          conversation = delivered.conversation;
          matchedMember = delivered.fromKind === 'person' ? delivered.fromId : null;
        } else {
          // Which conversation a message joins is the rule in place.ts. Only a one-to-one DM from a linked
          // member is private to a member: a group DM has several senders, and an unlinked sender is
          // nobody in this household. A duplicate delivery (above) keeps its original recorded scope.
          const member = message.isDm && !message.groupDm && !sender ? matchedMember : null;
          const place = conversationPlace(connection.workspace, message, member);
          conversation = this.conversations.open({ agent: connection.agent, venue: connection.platform, place, label: message.thread ?? message.channel, member, direct: message.isDm }).id;
        }
        if (!delivered) {
          this.conversations.turn({ conversation, kind: 'message', fromKind, fromId });
          this.conversations.send({ toKind: 'agent', to: connection.agent, conversation, source: connection.platform, sourceId, fromKind, fromId, words: message.text, refs: [id] });
        }
      }
      // A dropped message is never delivered or tried again, and nobody is shown it: it keeps no words.
      return this.db.update(bridgeIncoming).set({ state, reason, member: matchedMember, conversation, deliveredAt: state === 'delivered' ? deliveredAt : null, ...(state === 'dropped' ? { text: '' } : {}) }).where(eq(bridgeIncoming.id, row.id)).returning().get()!;
    });
  }

  /** Try a held message again from its own row, against the household's rules as they are now. This is
   * the retry once the raw event has expired. A row from before the admission fields were stored cannot
   * say whom it mentioned and is returned as it is. */
  retry(id: string): typeof bridgeIncoming.$inferSelect | undefined {
    return this.db.transaction(() => {
      const row = this.db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, id)).get();
      const message = row && parseIncomingId(row.id, row.connection);
      if (!row || row.state !== 'held' || row.mentions === null || !message) return row;
      return this.receive({ id: message, connection: row.connection, channel: row.channel, isDm: row.isDm, user: row.user, text: row.text, postedAt: row.postedAt,
        mentions: JSON.parse(row.mentions) as string[], bot: !!row.bot, webhook: !!row.webhook,
        ...(row.thread === null ? {} : { thread: row.thread }), ...(row.parent === null ? {} : { parent: row.parent }),
        ...(row.repliesTo === null ? {} : { repliesTo: row.repliesTo }), ...(row.groupDm ? { groupDm: true } : {}) }, true, row.receivedAt);
    });
  }
}
