/** Trusted transport-to-conversation path. Call receipt methods only after the
 * platform transport authenticates. They persist original socket frames before
 * ACK/resume advancement; metadata lookup and admission happen in drain().
 * Channel resolvers read an authenticated adapter cache synchronously.
 * Nothing received is given up on before a day has passed. An event that cannot
 * be read yet (no channel metadata, or a frame this code cannot make sense of)
 * keeps its raw frame for UNREAD_EVENT_LIFETIME. A message that was read and
 * held gets a row that keeps what admission read: its raw frame goes after an
 * hour and drain goes on trying it from the row for HELD_LIFETIME. What is
 * still undelivered after that day is closed or removed, and composition is
 * told how many.
 * This service performs no network IO and is owned/closed by composition.
 */
import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeIncoming } from '../../core/data/schema.js';
import { BridgeEvents, RAW_EVENT_LIFETIME, UNREAD_EVENT_LIFETIME, type BridgeCheckpoint, type Consumed } from './events.js';
import { BridgeIncoming, type IncomingMessage, type StopJob } from './incoming.js';
import { normalizeDiscord, normalizeSlack, type DiscordChannel, type SlackChannel } from './normalize.js';

const id = z.string().min(1).max(256);
const discordFrame = z.object({ op: z.literal(0), t: id, s: z.number().int().nonnegative(), d: z.unknown() });
const slackFrame = z.object({ type: z.literal('events_api'), payload: z.object({
  type: z.literal('event_callback'), event_id: id, team_id: id, event: z.object({ type: id }).passthrough(),
}) });
const channelField = z.object({ channel_id: id });
const guildField = z.object({ guild_id: id.nullish() });
const slackChannelField = z.object({ channel: id });

/** How long a held message is still worth delivering. After a day an answer would come too late to be
 * wanted, so the message is closed as dropped and says why. The same day an unread frame is kept, by
 * construction: a retry that outlived the frame would be retrying a message whose only copy was gone. */
export const HELD_LIFETIME = UNREAD_EVENT_LIFETIME;
export interface BridgeChannelCache {
  discord(connection: string, channel: string): DiscordChannel | undefined;
  /** Whether a complete role list has arrived for this authenticated guild. */
  rolesKnown?(connection: string): boolean;
  /** Discord role id to the bot it is managed for; none known is an empty map. */
  botRoles?(connection: string): ReadonlyMap<string, string>;
  slack(connection: string, channel: string): SlackChannel | undefined;
}

export class BridgeReceiver {
  private readonly events: BridgeEvents;
  private readonly incoming: BridgeIncoming;
  /** Where the last pass over each connection's held rows stopped, so a full page of rows that stay held
   * cannot keep later ones from being tried. */
  private readonly heldAfter = new Map<string, { at: string; id: string }>();
  /** Frames already reported as unreadable, so each is reported once while it waits. */
  private readonly unreadable = new Set<string>();
  /** `lost` hears of what can no longer be delivered: `events` received and never read before their frames
   * expired, and `held` messages closed after HELD_LIFETIME. */
  constructor(private db: DataDatabase, private clock: Clock, private channels: BridgeChannelCache,
    private lost: (expired: { events: number; held: number }) => void = () => {}, stop?: StopJob) {
    this.events = new BridgeEvents(db, clock, events => lost({ events, held: this.closeExpiredHeld() }));
    // Rows left held by a process that stopped before they could be closed.
    this.closeHeld();
    this.incoming = new BridgeIncoming(db, () => new Date(clock.now()).toISOString(), stop);
  }

  /** The checkpoint must be the authenticated transport's cursor for this frame. */
  discord(connection: string, raw: Buffer, checkpoint: BridgeCheckpoint, persistCheckpoint = true): void {
    this.connection(connection, 'discord');
    const frame = discordFrame.parse(this.parse(raw));
    if (frame.s !== checkpoint.sequence) throw Error('Discord frame does not match checkpoint');
    this.events.retain(connection, JSON.stringify([checkpoint.session, frame.s]), raw, persistCheckpoint ? checkpoint : undefined);
  }

  slack(connection: string, raw: Buffer): void {
    const source = this.connection(connection, 'slack');
    const frame = slackFrame.parse(this.parse(raw));
    if (frame.payload.team_id !== source.workspace) throw Error('Slack event does not match connection workspace');
    // envelope_id is an ACK address and can change on retry. event_id is stable.
    this.events.retain(connection, frame.payload.event_id, raw);
  }

  checkpoint(connection: string, identity: string): BridgeCheckpoint | undefined {
    this.connection(connection, 'discord');
    return this.events.checkpoint(connection, identity);
  }
  reset(connection: string): void {
    this.connection(connection, 'discord');
    this.events.reset(connection);
  }

  /** Discover API lookup targets after reconnect/restart, including frames that
   * arrived before this process. Examines at most limit receipts in arrival
   * order and returns distinct missing channel ids, never message fields as
   * channel-kind evidence. No receipt is consumed or delivered here. Root owns
   * authenticated fetches, cache lifetime and bounded retry scheduling; call
   * drain after filling the cache. A frame that cannot be read is passed over
   * here, so it cannot keep the others from being looked up; drain() reports it. */
  missingChannels(connection: string, limit = 64, rotate = false): string[] {
    const source = this.connection(connection);
    const missing = new Set<string>();
    this.events.drain(connection, (_id, raw) => { try {
      const payload = this.parse(raw);
      if (source.platform === 'discord') {
        const frame = discordFrame.parse(payload);
        if (frame.t === 'MESSAGE_CREATE' && !this.elsewhere(source, frame.d)) {
          const channel = channelField.parse(frame.d).channel_id;
          if (!this.channels.discord(connection, channel)) missing.add(channel);
        }
      } else {
        const frame = slackFrame.parse(payload);
        const event = frame.payload.event;
        if (event.type === 'message' || event.type === 'app_mention') {
          const channel = slackChannelField.parse(event).channel;
          if (!event.channel_type && !this.channels.slack(connection, channel)) missing.add(channel);
        }
      }
      // A frame that cannot be read names no channel to look up. drain() reports it.
      } catch { /* left for drain */ }
      return false;
    }, limit, rotate ? 'inspect' : 'peek');
    return [...missing];
  }

  /** Bounded synchronous pass; receipt removal and conversation delivery share
   * one transaction. Held rows are retried against current household rules, and
   * closed once they are too old to deliver. A frame that cannot be read does not
   * stop the pass: its receipt and nothing else of it is kept, the rest of the
   * pass runs, and then the first such error is thrown, once per frame, for
   * composition to report. */
  drain(connection: string, limit = 64, delivered?: (row: ReturnType<BridgeIncoming['receive']>, raw: Buffer) => boolean | void, observed?: (message:Pick<IncomingMessage,'user'|'postedAt'|'authorLabel'>) => void): number {
    const source = this.connection(connection);
    this.closeHeld();
    // Held messages whose receipt is gone are tried from their own rows. Such a delivery has no raw frame,
    // so `delivered` is not called for it: a Slack message that waited this long arrives without its files.
    const expired = new Date(this.clock.now() - RAW_EVENT_LIFETIME).toISOString();
    const page = (after?: { at: string; id: string }) => this.db.select({ id: bridgeIncoming.id, at: bridgeIncoming.receivedAt, channel: bridgeIncoming.channel }).from(bridgeIncoming)
      .where(and(eq(bridgeIncoming.connection, connection), eq(bridgeIncoming.state, 'held'), isNotNull(bridgeIncoming.mentions), sql`julianday(${bridgeIncoming.receivedAt}) <= julianday(${expired})`,
        after ? sql`(julianday(${bridgeIncoming.receivedAt}) > julianday(${after.at}) or (julianday(${bridgeIncoming.receivedAt}) = julianday(${after.at}) and ${bridgeIncoming.id} > ${after.id}))` : undefined))
      .orderBy(sql`julianday(${bridgeIncoming.receivedAt})`, asc(bridgeIncoming.id)).limit(limit).all();
    const after = this.heldAfter.get(connection);
    let held = page(after);
    if (!held.length && after) { this.heldAfter.delete(connection); held = page(); }
    for (const row of held) {
      this.heldAfter.set(connection, row);
      const channel = source.platform === 'discord' ? this.channels.discord(connection, row.channel) : undefined;
      const channelName = source.platform === 'slack' ? this.channels.slack(connection, row.channel)?.name : channel?.name;
      this.incoming.retry(row.id, { channelName, parentName: channel?.parentName });
    }
    let failure: unknown, failed = false;
    // A frame that cannot be taken in now: a later version of this code, better channel metadata or a
    // later pass may take it. It waits as any unread event does, is reported once, and is counted as lost
    // if it is still unread when its frame expires.
    const unread = (receipt: string, error: unknown): false => {
      const key = JSON.stringify([connection, receipt]);
      if (!this.unreadable.has(key)) {
        if (this.unreadable.size >= 4096) this.unreadable.clear();
        this.unreadable.add(key);
        if (!failed) { failed = true; failure = error; }
      }
      return false;
    };
    const count = this.events.drain(connection, (receipt, raw, receivedAt): Consumed => {
      let message;
      try {
        const payload = this.parse(raw);
        if (source.platform === 'discord') {
          const frame = discordFrame.parse(payload);
          if (frame.t !== 'MESSAGE_CREATE' || this.elsewhere(source, frame.d)) return;
          const channel = this.channels.discord(connection, channelField.parse(frame.d).channel_id);
          if (!channel) return false;
          const normalized = normalizeDiscord(source, frame, channel, this.channels.botRoles?.(connection), this.channels.rolesKnown?.(connection));
          if (normalized?.awaitRoles) return false;
          message = normalized;
        } else {
          const frame = slackFrame.parse(payload);
          const event = frame.payload.event;
          if (event.type !== 'message' && event.type !== 'app_mention') return;
          const channel = this.channels.slack(connection, slackChannelField.parse(event).channel);
          // normalizeSlack accepts the event's channel_type when present and
          // otherwise requires trusted metadata. No guessed DM classification.
          if (!channel && !event.channel_type) return false;
          message = normalizeSlack(source, frame.payload, channel);
        }
      } catch (error) { return unread(receipt,error); }
      if (!message) return;
      let row;
      // Intake that refuses one message (an id reused for another, a row that cannot be written now) must
      // not end the pass for the frames behind it. The frame waits and is reported as an unreadable one is.
      try { row=this.incoming.receive(message,true,receivedAt); }
      catch (error) { return unread(receipt,error); }
      // The row keeps what a retry needs, so the frame need not outlive its hour.
      if(row.state==='held')return 'recorded';
      // A delivered message whose files are still to be fetched keeps its frame, which lists them, for that hour.
      if(row.state!=='delivered')return;
      const keepFiles=delivered?.(row,raw)===false;
      if(observed&&!row.isDm&&row.bot===false&&row.webhook===false&&!message.bot&&!message.webhook){
        return {afterCommit:()=>{
          try { observed({user:row.user,postedAt:row.postedAt,authorLabel:message.authorLabel}); }
          catch(error){ return unread(receipt,error); }
          return !keepFiles;
        }};
      }
      return keepFiles?'recorded':undefined;
    }, limit);
    if (failed) throw failure;
    return count;
  }

  /** The jobs that stop words ended in the passes since this was last asked (incoming.ts). */
  takeStopped(): { job: string; incoming: string }[] { return this.incoming.takeStopped(); }

  /** A Discord gateway session is the bot's, not the guild's: it also carries the messages of every other
   * guild the bot has been added to. Those are not this connection's. The frame's own guild id is enough to
   * set them aside; it is never used to decide what a message that is kept is. */
  private elsewhere(source: { workspace: string }, data: unknown): boolean {
    const guild = guildField.parse(data).guild_id;
    return guild != null && guild !== source.workspace;
  }

  private closeHeld(): void {
    const held = this.closeExpiredHeld();
    if (held) this.lost({ events: 0, held });
  }

  /** Close the held rows nothing can deliver any more, and say so on the row: one held for HELD_LIFETIME,
   * and one whose receipt has expired and whose row was written before it stored what a retry needs. A
   * message that was never delivered keeps no words. */
  private closeExpiredHeld(): number {
    const before = (ms: number) => sql`julianday(${bridgeIncoming.receivedAt}) <= julianday(${new Date(this.clock.now() - ms).toISOString()})`;
    return this.db.update(bridgeIncoming).set({ state: 'dropped', text: '', reason: sql`'Held too long to deliver: ' || coalesce(${bridgeIncoming.reason}, 'no reason recorded')` })
      .where(and(eq(bridgeIncoming.state, 'held'), or(before(HELD_LIFETIME), and(isNull(bridgeIncoming.mentions), before(RAW_EVENT_LIFETIME))))).run().changes;
  }

  private connection(connection: string, platform?: 'discord' | 'slack') {
    const source = this.db.select().from(bridgeConnections).where(eq(bridgeConnections.id, connection)).get();
    if (!source || (platform && source.platform !== platform)) throw Error('Unknown or mismatched bridge connection');
    return source;
  }
  private parse(raw: Buffer): unknown {
    if (!raw.length || raw.length > 1024 * 1024) throw Error('Invalid bridge frame size');
    return JSON.parse(raw.toString('utf8'));
  }
  close(): void { this.events.close(); }
}
