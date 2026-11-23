/** Trusted bridge ingress. Platform adapters supply authenticated event fields;
 * person identity comes exclusively from household person links.
 *
 * A person's message is taken only from somebody the household knows: an account linked to a member who is
 * in the household now, or one the answering agent's owner has given a tier. Anybody else is dropped, in a
 * room and in a direct message alike.
 *
 * Who counts is the household's answer as it is now (policy.ts, inHousehold), asked each time a message is
 * received or tried again. A person link stands for its member only while that member is in the household:
 * removing a member keeps the link, and their account is then nobody's. A connection speaks for its agent
 * only while it is in use (enabled and not removed) and that agent is in the household: a retired
 * connection's bot is no agent's, so it is neither a peer that could be addressed, nor a household sender,
 * nor a second claim on a bot that another connection now holds. */
import { discordBodyWords } from './discord-link.js';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { Conversations, lateMailWaits, refreshConversationLabel } from '../../core/conversations/index.js';
import { incomingId, inboxSourceId, outsidePersonKey, parseIncomingId } from './keys.js';
import { conversationPlace, discordPlace, slackRoomLabel } from './place.js';
import { holds, inHousehold, rules } from '../../policy.js';
import { unendedJobStates } from '../../core/data/job-states.js';
import { sharedSharing } from '../../shared-sharing.js';
import { agentPeople, conversations, jobs, bridgeConnections, bridgeChannelFilters, bridgeChannels, bridgeContactSightings, bridgePeople, bridgeIncoming, bridgeSendParts, bridgeSends, inbox, inboxRefs } from '../../core/data/schema.js';

// A held receipt keeps the reason nobody received it and the routing fact Discord supplied.
const BOT_MENTION_HELD = '; the message explicitly mentioned a bot';

export interface IncomingMessage {
  /** Stable platform message id, scoped to this connection by the service. */
  id: string;
  connection: string;
  channel: string;
  parent?: string;
  channelName?: string;
  parentName?: string;
  mentionsBot?: boolean;
  thread?: string;
  isDm: boolean;
  /** Authenticated channel kind; group DMs are not private to one sender. */
  groupDm?: boolean;
  user: string;
  /** Provider display text for a human sender in a room. Identity is resolved by account ID. */
  authorLabel?: string;
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
function sameMessage(row:Pick<typeof bridgeIncoming.$inferSelect,'channel'|'thread'|'isDm'|'user'|'text'|'postedAt'>,message:IncomingMessage,platform:'discord'|'slack'){
 return samePosting(row,message)&&(row.text===''||row.text===message.text||platform==='discord'&&discordBodyWords(row.text)===discordBodyWords(message.text));
}
/** The same message by everything but its words: where it was posted, by whom and when. */
function samePosting(row:Pick<typeof bridgeIncoming.$inferSelect,'channel'|'thread'|'isDm'|'user'|'postedAt'>,message:IncomingMessage){
 return row.channel===message.channel&&row.thread===(message.thread??null)&&row.isDm===message.isDm
  &&row.user===message.user&&row.postedAt===message.postedAt;
}

/** Why a person's message was not delivered: nobody the household knows sent it. */
export const UNKNOWN_SENDER = 'Unknown sender';
/** Why a message was neither delivered nor answered: it was the stop word, and it stopped a job. */
export const STOP_WORD = 'Stop word';
/** Why a stop word loom came to late is neither acted on nor delivered: too late to stop what it was said about. */
export const STOP_WORD_LATE = 'Stop word, too late to stop anything';
/** How long after it was said a stop word still stops: taken in later than this, it is spent. Said once. */
export const STOP_WORD_FRESH_MS = 120_000;
/** A message that is only "stop" or "cancel", in any case, with trailing full stops or exclamation marks
 * and its mentions set aside. The list is the earlier bridge's. */
export function isStopWord(text: string): boolean {
  return /^(stop|cancel)[.!]*$/i.test(text.replace(/<@[!&]?[^<>\s]+>/g, '').trim());
}
/** Ends a job on a member's word, inside the caller's transaction. The runtime's: bridges write no job. */
export type StopJob = (job: string, member: string) => void;
/** Why a bot's message was not delivered. */
export const BOT_NOT_ADMITTED = 'Bot did not mention this agent, or bots may not talk here';

export class BridgeIncoming {
  private readonly conversations: Conversations;
  private stopped: { job: string; incoming: string }[] = [];
  /** `stop` ends a job the way an owner's Stop does. Without it the stop word is an ordinary message. */
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString(), private readonly stop?: StopJob) {
    this.conversations = new Conversations(db, now, lateMailWaits);
  }

  /** The jobs stop words have ended since this was last asked, each with the message that said it, for
   * the caller to announce and to answer once its transaction has committed. */
  takeStopped(): { job: string; incoming: string }[] { return this.stopped.splice(0); }

  /** Atomically records the event, turn, conversation and unified inbox item.
   * Duplicate events never append a second turn. A held event is tried again
   * only when asked: with the platform envelope while the raw-event adapter
   * still has it, and from its own row afterwards (retry). The trusted spool
   * supplies its original receipt time when processing was delayed. */
  receive(message: IncomingMessage, retryHeld = false, receivedAt?: string, recordSighting = false): typeof bridgeIncoming.$inferSelect {
    return this.db.transaction(() => {
      const id = incomingId(message.connection, message.id);
      const connection = this.db.select().from(bridgeConnections).where(eq(bridgeConnections.id, message.connection)).get();
      if (!connection) throw new Error('Unknown bridge connection');
      const existing = this.db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, id)).get();
      if (existing) {
        // A second event for a message already on record, with other words, is an edit (Slack sends an
        // `app_mention` when a posted message is edited to mention the bot). An edit is not a new message:
        // nothing new is recorded, whatever state the first is in, and the agent keeps the words it was
        // given. The caller has its row and counts the event as read.
        if (!sameMessage(existing,message,connection.platform)) {
          if (samePosting(existing,message)) return existing;
          throw new Error('Incoming id reused for a different message');
        }
        if (existing.state !== 'held' || !retryHeld) return existing;
      }
      const channel = message.parent ?? message.channel;
      const route = this.db.select().from(bridgeChannels).where(and(eq(bridgeChannels.platform, connection.platform), eq(bridgeChannels.workspace, connection.workspace), eq(bridgeChannels.channel, channel))).get();
      const filters = this.db.select().from(bridgeChannelFilters).where(eq(bridgeChannelFilters.connection, connection.id)).all();
      const sharing = sharedSharing(this.db);
      // The connections of this workspace that speak for an agent now, and this one whatever its state:
      // what it may not do when it is off is said below, by its own row.
      const peers = this.db.select().from(bridgeConnections).where(and(eq(bridgeConnections.platform, connection.platform), eq(bridgeConnections.workspace, connection.workspace))).all()
        .filter(p => p.id === connection.id || (p.enabled && !p.removedAt && inHousehold({ kind: 'agent', id: p.agent }, sharing)));
      const senders = peers.filter(p => p.botUser === message.user);
      const sender = senders[0];
      const linked = this.db.select().from(bridgePeople).where(and(eq(bridgePeople.platform, connection.platform), eq(bridgePeople.workspace, connection.workspace), eq(bridgePeople.user, message.user))).get();
      const link = linked && inHousehold({ kind: 'member', id: linked.member }, sharing) ? linked : undefined;
      // Who the message is addressed to: whoever it mentions, the author of the message it explicitly
      // replies to, and the bot whose own message its thread hangs under. Nothing looser counts: a bot
      // that has merely spoken in the thread, or spoke last in the room, is not addressed. A thread's root
      // is known as a bot's only if loom posted it; every part of a long reply is on record as one.
      const addressed = new Set(message.mentions);
      if (message.repliesTo) addressed.add(message.repliesTo);
      if (message.thread) {
        const root = this.db.select({ connection: bridgeSends.connection }).from(bridgeSendParts).innerJoin(bridgeSends, eq(bridgeSends.id, bridgeSendParts.send))
          .where(and(inArray(bridgeSends.connection, peers.map(p => p.id)), eq(bridgeSends.channel, channel), eq(bridgeSendParts.postedId, message.thread))).get();
        const poster = root && peers.find(p => p.id === root.connection);
        if (poster) addressed.add(poster.botUser);
      }
      let state: 'held' | 'dropped' | 'delivered' = 'delivered';
      let reason: string | null = null;
      let matchedMember = sender ? null : link?.member ?? null;
      if (!connection.enabled || connection.removedAt) { state = 'held'; reason = 'Connection disabled'; }
      // An `only` filter chooses which rooms are answered. A direct message is not a room: it is dropped only by
      // an `ignore` that names it.
      else if (filters.some(f => f.rule === 'ignore' && f.channel === channel) || (!message.isDm && filters.some(f => f.rule === 'only') && !filters.some(f => f.rule === 'only' && f.channel === channel))) { state = 'dropped'; reason = 'Channel filtered'; }
      else if (message.user === connection.botUser) { state = 'dropped'; reason = 'Own message'; }
      else if (peers.some(p => p.botUser === connection.botUser && p.agent !== connection.agent)) { state = 'held'; reason = 'Ambiguous connection agent'; }
      // A Discord bot's session hears every direct message to the bot, whichever guild its connection
      // names. With enabled connections for one bot in two guilds both would deliver it, as two
      // conversations (within one guild the copies are one Inbox item, below). Settings refuses that
      // setup; a database that has it anyway delivers through neither.
      else if (message.isDm && connection.platform === 'discord' && this.db.select({ id: bridgeConnections.id }).from(bridgeConnections)
        .where(and(eq(bridgeConnections.platform, 'discord'), eq(bridgeConnections.botUser, connection.botUser), eq(bridgeConnections.enabled, true), isNull(bridgeConnections.removedAt), ne(bridgeConnections.workspace, connection.workspace))).get()) { state = 'held'; reason = 'Bot is connected in another guild'; }
      else if (new Set(senders.map(p => p.agent)).size > 1) { state = 'held'; reason = 'Ambiguous bot identity'; }
      // A stop word that loom comes to late is spent: one that was held and is tried again, and one first
      // taken in more than STOP_WORD_FRESH_MS after it was said (its frame waited in the spool, or loom was
      // down). It was said about whatever was working when it was said, and must not stop a job that started
      // since, nor arrive later as a message nobody meant. It is dropped, saying so, whoever said it.
      else if (isStopWord(message.text) && (existing || Date.parse(this.now()) - Date.parse(message.postedAt) > STOP_WORD_FRESH_MS)) { state = 'dropped'; reason = STOP_WORD_LATE; }
      // A bot wakes an agent only by writing its mention, and only where the channel's rule lets bots talk. A
      // reply, a thread and the channel's own agent count for people alone, so two agents cannot wake each other
      // unless each chooses to. The platform's own flag says what a bot is; one that is no agent of this
      // household is delivered as from nobody.
      else if (message.bot || message.webhook || sender) {
        if (message.isDm || !route?.botsMayTalk || !message.mentions.includes(connection.botUser)) { state = 'dropped'; reason = BOT_NOT_ADMITTED; }
      }
      else if (!link && !this.hasTier(connection, message.user)) { state = 'dropped'; reason = UNKNOWN_SENDER; }
      // An explicit bot mention takes precedence over the channel default, a reply, and the thread's starter.
      else if (connection.platform === 'discord' && !message.isDm
        && !message.mentions.includes(connection.botUser) && (message.mentionsBot || peers.some(peer => message.mentions.includes(peer.botUser)))) {
        state = 'dropped'; reason = 'Another agent or no channel answer';
      }
      // The stop word, from a member who may end this agent's jobs, in a place where a job of the agent's is
      // working, and not said to another agent: that job is ended and the message is nobody's mail. It is
      // acted on only as the message is first taken in, and only fresh (a held or late one is spent, above),
      // and names the one job found unended here then, so it can never reach a later one. Anywhere else, and from anybody else,
      // the same words are an ordinary message.
      else if (link && this.stop && isStopWord(message.text) && (addressed.has(connection.botUser) || !peers.some(p => addressed.has(p.botUser)))
        && holds(rules.stopJob, { kind: 'member', id: link.member }, { agent: connection.agent }, sharing)) {
        const place = conversationPlace(connection.workspace, message, message.isDm && !message.groupDm ? link.member : null);
        const working = this.db.select({ id: jobs.id }).from(jobs).innerJoin(conversations, eq(conversations.id, jobs.conversation))
          .where(and(eq(conversations.agent, connection.agent), eq(conversations.venue, connection.platform), eq(conversations.place, place), inArray(jobs.state, unendedJobStates))).get();
        if (working) { this.stop(working.id, link.member); this.stopped.push({ job: working.id, incoming: id }); state = 'dropped'; reason = STOP_WORD; }
      }
      // In a room, a person's message that addresses nobody goes to the agent that answers the room.
      if (state === 'delivered' && !message.isDm && !(message.bot || message.webhook || sender) && !addressed.has(connection.botUser)) {
        if (peers.some(p => addressed.has(p.botUser)) || route?.answers !== connection.agent) { state = 'dropped'; reason = 'Another agent or no channel answer'; }
      }
      const at = this.now();
      const row = existing ?? this.db.insert(bridgeIncoming).values({ id, connection: connection.id, channel: message.channel, thread: message.thread, isDm: message.isDm, user: message.user, text: message.text, postedAt: message.postedAt, receivedAt: receivedAt ?? at, state: 'pending',
        // What admission reads and nothing else keeps, so a held message can be tried again from this row.
        mentions: JSON.stringify(message.mentions), repliesTo: message.repliesTo ?? null, parent: message.parent ?? null,
        groupDm: !!message.groupDm, bot: !!message.bot, webhook: !!message.webhook }).returning().get();
      const humanRoom = !message.isDm && !message.bot && !message.webhook && !sender && message.user !== connection.botUser;
      if (!existing && recordSighting && humanRoom && state !== 'dropped') {
        this.db.insert(bridgeContactSightings).values({incoming:id,platform:connection.platform,workspace:connection.workspace,label:message.authorLabel}).run();
      } else if (existing && (state === 'dropped' || !humanRoom)) {
        this.db.delete(bridgeContactSightings).where(eq(bridgeContactSightings.incoming,id)).run();
      } else if (existing) {
        // A connection that was retargeted while a message waited cannot witness that old account.
        this.db.delete(bridgeContactSightings).where(and(eq(bridgeContactSightings.incoming,id),
          sql`(${bridgeContactSightings.workspace} <> ${connection.workspace} or ${bridgeContactSightings.platform} <> ${connection.platform})`)).run();
      }
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
          if (!original || !sameMessage(original,message,connection.platform)) throw Error('Bridge delivery identity changed');
          deliveredAt = delivered.at;
          conversation = delivered.conversation;
          matchedMember = delivered.fromKind === 'person' ? delivered.fromId : null;
        } else {
          // Which conversation a message joins is the rule in place.ts. Only a one-to-one DM from a linked
          // member is private to a member: a group DM has several senders, and an unlinked sender is
          // nobody in this household. A duplicate delivery (above) keeps its original recorded scope.
          const member = message.isDm && !message.groupDm && !sender ? matchedMember : null;
          const place = conversationPlace(connection.workspace, message, member);
          const slackLabel = connection.platform === 'slack' && !message.isDm && message.channelName
            ? slackRoomLabel + message.channelName : undefined;
          const label = connection.platform === 'discord' ? discordPlace(message, member) : slackLabel ?? message.thread ?? message.channel;
          const cv = this.conversations.open({ agent: connection.agent, venue: connection.platform, place, label, member, direct: message.isDm });
          conversation = cv.id;
          if (slackLabel && cv.label !== slackLabel && (cv.label === message.thread || cv.label === message.channel || cv.label.startsWith(slackRoomLabel)))
            refreshConversationLabel(this.db, cv, slackLabel);
          if (connection.platform === 'discord' && label !== cv.label && (cv.label === message.channel || (message.channelName && /^(Discord channel #|Discord thread #)/.test(cv.label)
            && (!message.parent || message.parentName || cv.label.endsWith(' under #' + message.parent)))))
            refreshConversationLabel(this.db, cv, label);
        }
        if (!delivered) {
          this.conversations.turn({ conversation, kind: 'message', fromKind, fromId });
          this.conversations.send({ toKind: 'agent', to: connection.agent, conversation, source: connection.platform, sourceId, fromKind, fromId, words: message.text, refs: [id] });
        }
      }
      // A dropped message is never delivered or tried again, and nobody is shown it: it keeps no words.
      if (state === 'held' && message.mentionsBot) reason += BOT_MENTION_HELD;
      return this.db.update(bridgeIncoming).set({ state, reason, member: matchedMember, conversation, deliveredAt: state === 'delivered' ? deliveredAt : null, ...(state === 'dropped' ? { text: '' } : {}) }).where(eq(bridgeIncoming.id, row.id)).returning().get()!;
    });
  }

  /** Whether this agent's owner has placed the outside account: a tier of any rank, set by a card the owner
   * allowed (shared-agent-body-policy.ts). With a person link, this is everybody a message is taken from.
   * A tier admits; it never says who somebody is (docs/accepted-tradeoffs.md, "A stranger wakes nothing"). */
  private hasTier(connection: Pick<typeof bridgeConnections.$inferSelect, 'platform' | 'workspace' | 'agent'>, user: string): boolean {
    return !!this.db.select({ tier: agentPeople.tier }).from(agentPeople)
      .where(and(eq(agentPeople.agent, connection.agent), eq(agentPeople.person, outsidePersonKey(connection.platform, connection.workspace, user)))).get();
  }

  /** Try a held message again from its own row, against the household's rules as they are now. This is
   * the retry once the raw event has expired. A row from before the admission fields were stored cannot
   * say whom it mentioned and is returned as it is. */
  retry(id: string, names?: Pick<IncomingMessage, 'channelName' | 'parentName'>): typeof bridgeIncoming.$inferSelect | undefined {
    return this.db.transaction(() => {
      const row = this.db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id, id)).get();
      const message = row && parseIncomingId(row.id, row.connection);
      if (!row || row.state !== 'held' || row.mentions === null || !message) return row;
      return this.receive({ ...names, id: message, connection: row.connection, channel: row.channel, isDm: row.isDm, user: row.user, text: row.text, postedAt: row.postedAt,
        mentions: JSON.parse(row.mentions) as string[], mentionsBot: row.reason?.endsWith(BOT_MENTION_HELD), bot: !!row.bot, webhook: !!row.webhook,
        ...(row.thread === null ? {} : { thread: row.thread }), ...(row.parent === null ? {} : { parent: row.parent }),
        ...(row.repliesTo === null ? {} : { repliesTo: row.repliesTo }), ...(row.groupDm ? { groupDm: true } : {}) }, true, row.receivedAt);
    });
  }
}
