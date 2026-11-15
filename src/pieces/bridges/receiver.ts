/** Trusted transport-to-conversation path. Call receipt methods only after the
 * platform transport authenticates. They persist original socket frames before
 * ACK/resume advancement; metadata lookup and admission happen in drain().
 * Channel resolvers read an authenticated adapter cache synchronously. Missing
 * metadata and held messages retain their receipt until retry or one-hour expiry.
 * This service performs no network IO and is owned/closed by composition.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections } from '../../core/data/schema.js';
import { BridgeEvents, type BridgeCheckpoint } from './events.js';
import { BridgeIncoming } from './incoming.js';
import { normalizeDiscord, normalizeSlack, type DiscordChannel, type SlackChannel } from './normalize.js';

const id = z.string().min(1).max(256);
const discordFrame = z.object({ op: z.literal(0), t: id, s: z.number().int().nonnegative(), d: z.unknown() });
const slackFrame = z.object({ type: z.literal('events_api'), payload: z.object({
  type: z.literal('event_callback'), event_id: id, team_id: id, event: z.object({ type: id }).passthrough(),
}) });
const channelField = z.object({ channel_id: id });
const slackChannelField = z.object({ channel: id });

export interface BridgeChannelCache {
  discord(connection: string, channel: string): DiscordChannel | undefined;
  slack(connection: string, channel: string): SlackChannel | undefined;
}

export class BridgeReceiver {
  private readonly events: BridgeEvents;
  private readonly incoming: BridgeIncoming;
  constructor(private db: DataDatabase, clock: Clock, private channels: BridgeChannelCache) {
    this.events = new BridgeEvents(db, clock);
    this.incoming = new BridgeIncoming(db, () => new Date(clock.now()).toISOString());
  }

  /** The checkpoint must be the authenticated transport's cursor for this frame. */
  discord(connection: string, raw: Buffer, checkpoint: BridgeCheckpoint): void {
    this.connection(connection, 'discord');
    const frame = discordFrame.parse(this.parse(raw));
    if (frame.s !== checkpoint.sequence) throw Error('Discord frame does not match checkpoint');
    this.events.retain(connection, JSON.stringify([checkpoint.session, frame.s]), raw, checkpoint);
  }

  slack(connection: string, raw: Buffer): void {
    const source = this.connection(connection, 'slack');
    const frame = slackFrame.parse(this.parse(raw));
    if (frame.payload.team_id !== source.workspace) throw Error('Slack event does not match connection workspace');
    // envelope_id is an ACK address and can change on retry. event_id is stable.
    this.events.retain(connection, frame.payload.event_id, raw);
  }

  checkpoint(connection: string): BridgeCheckpoint | undefined {
    this.connection(connection, 'discord');
    return this.events.checkpoint(connection);
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
   * drain after filling the cache. Malformed frames throw as in drain(). */
  missingChannels(connection: string, limit = 64, rotate = false): string[] {
    const source = this.connection(connection);
    const missing = new Set<string>();
    this.events.drain(connection, (_id, raw) => {
      const payload = this.parse(raw);
      if (source.platform === 'discord') {
        const frame = discordFrame.parse(payload);
        if (frame.t === 'MESSAGE_CREATE') {
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
      return false;
    }, limit, rotate ? 'inspect' : 'peek');
    return [...missing];
  }

  /** Bounded synchronous pass; receipt removal and conversation delivery share
   * one transaction. Held rows are retried against current household rules. A
   * malformed message throws, leaving its receipt/writes intact for inspection;
   * composition must report the failure, rather than spin an immediate retry. */
  drain(connection: string, limit = 64): number {
    const source = this.connection(connection);
    return this.events.drain(connection, (_id, raw, receivedAt) => {
      const payload = this.parse(raw);
      let message;
      if (source.platform === 'discord') {
        const frame = discordFrame.parse(payload);
        if (frame.t !== 'MESSAGE_CREATE') return;
        const channel = this.channels.discord(connection, channelField.parse(frame.d).channel_id);
        if (!channel) return false;
        message = normalizeDiscord(source, frame, channel);
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
      if (!message) return;
      return this.incoming.receive(message, true, receivedAt).state !== 'held';
    }, limit);
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
