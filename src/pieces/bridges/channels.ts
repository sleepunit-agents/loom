/** Disposable metadata from authenticated platform adapters. Never feed message
 * fields into these writers. Composition binds after authentication and closes
 * on disconnect/setup changes; an old writer cannot update a newer lifetime.
 * No network, credentials, database writes or household admission live here.
 */
import { z } from 'zod';
import { bridgeConnections } from '../../core/data/schema.js';
import type { BridgeChannelCache } from './receiver.js';
import type { DiscordChannel, SlackChannel } from './normalize.js';

const id = z.string().min(1).max(256);
const discordEvidence = z.object({ id, type: z.number().int(), guild_id: id.nullish(), parent_id: id.nullish(), name: z.string().nullish() });
const slackEvidence = z.object({ id, context_team_id: id.optional(), is_im: z.boolean().optional(), is_mpim: z.boolean().optional(), is_channel: z.boolean().optional(), is_group: z.boolean().optional() });
type Binding = { platform: 'discord' | 'slack'; workspace: string };
/** A role Discord made for a bot when it joined (`managed`, with the bot's id in its tags). */
const discordRole = z.object({ id, managed: z.boolean().optional(), tags: z.object({ bot_id: id.nullish() }).passthrough().nullish() }).passthrough();
type Lifetime = Binding & { channels: Map<string, DiscordChannel | SlackChannel>; botRoles: Map<string, string> };

export class BridgeChannels implements BridgeChannelCache {
  private readonly connections = new Map<string, Lifetime>();

  /** Bind a new authenticated lifetime. Fetches may finish asynchronously; keep
   * this writer with the fetch so late results cannot cross a rebind/close.
   * Slack channel objects have no team field: the authenticated API client must
   * already be bound to this workspace, just like the receiver transport.
   */
  bind(connection: string, binding: Binding) {
    id.parse(connection);
    const source = z.object({ platform: z.enum(bridgeConnections.platform.enumValues), workspace: id }).parse(binding);
    const life: Lifetime = { ...source, channels: new Map(), botRoles: new Map() };
    this.connections.set(connection, life);
    const current = () => this.connections.get(connection) === life;
    return {
      /** Expected channel is the requested API channel or authenticated event's
       * channel. Invalidate before validation so bad updates leave no stale row.
       * A Discord kind loom carries no conversation in is remembered as `other`
       * and returns false; malformed/mismatched evidence throws.
       */
      /** `starter` is who wrote the message a Discord thread was started from, when the adapter could
       * read it (channel-api.ts): a thread under a bot's message addresses that bot (normalize.ts). */
      put: (channel: string, evidence: unknown, starter?: string, parentName?: string): boolean => {
        if (!current()) return false;
        id.parse(channel);
        life.channels.delete(channel);
        if (life.platform === 'discord') {
          const raw = discordEvidence.parse(evidence);
          if (raw.id !== channel) throw Error('Discord channel id mismatch');
          let value: DiscordChannel;
          if ([1, 3].includes(raw.type)) {
            if (raw.guild_id != null) throw Error('Discord DM has a guild');
            value = { id: channel, kind: 'dm', ...(raw.type === 3 ? { group: true } : {}) };
          } else {
            if (raw.guild_id !== life.workspace) throw Error('Discord channel workspace mismatch');
            if ([0, 5].includes(raw.type)) value = { id: channel, guild: life.workspace, kind: 'channel', ...(raw.name && { name: raw.name }) };
            else if ([10, 11, 12].includes(raw.type)) {
              if (!raw.parent_id || raw.parent_id === channel) throw Error('Discord thread needs a parent');
              value = { id: channel, guild: life.workspace, kind: 'thread', parent: raw.parent_id, ...(raw.name && { name: raw.name }), ...(parentName && { parentName }), ...(starter !== undefined ? { starter: id.parse(starter) } : {}) };
            } else {
              // Remembered, so its messages are set aside at once and nobody asks Discord about it again
              // (docs/accepted-tradeoffs.md, "Some Discord channels carry no conversation").
              life.channels.set(channel, { id: channel, guild: life.workspace, kind: 'other' });
              return false;
            }
          }
          life.channels.set(channel, value);
        } else {
          const raw = slackEvidence.parse(evidence);
          if (raw.id !== channel) throw Error('Slack channel id mismatch');
          if (raw.context_team_id !== undefined && raw.context_team_id !== life.workspace) throw Error('Slack channel workspace mismatch');
          // Slack's IM objects may omit unrelated flags; old MPIMs can also
          // carry is_group. A plain legacy group needs explicit non-DM flags.
          let kind: SlackChannel['kind'];
          if (raw.is_im && !raw.is_mpim && !raw.is_channel && !raw.is_group) kind = 'im';
          else if (raw.is_mpim && !raw.is_im && !raw.is_channel) kind = 'mpim';
          else if (raw.is_channel && !raw.is_im && !raw.is_mpim && !raw.is_group) kind = 'channel';
          else if (raw.is_group && raw.is_im === false && raw.is_mpim === false && !raw.is_channel) kind = 'group';
          else throw Error('Slack channel kind is ambiguous');
          life.channels.set(channel, { id: channel, kind });
        }
        return true;
      },
      /** The guild's roles as Discord lists them. Kept: each role Discord manages for a bot, by the bot it
       * is for. A ping of such a role is a mention of that bot; no other role is anybody's. Replaces what
       * was kept; evidence that is not a list of roles keeps none. */
      roles: (evidence: unknown): void => {
        if (!current() || life.platform !== 'discord') return;
        life.botRoles.clear();
        for (const role of z.array(discordRole).max(1000).parse(evidence)) if (role.managed && role.tags?.bot_id) life.botRoles.set(role.id, role.tags.bot_id);
      },
      remove: (channel: string): void => { if (current()) life.channels.delete(channel); },
      close: (): void => { if (current()) this.connections.delete(connection); },
    };
  }

  discord(connection: string, channel: string): DiscordChannel | undefined {
    const life = this.connections.get(connection);
    if (life?.platform !== 'discord') return;
    const value = life.channels.get(channel) as DiscordChannel | undefined;
    return value && { ...value };
  }
  /** Discord role id to the bot it is managed for, for this connection's lifetime. Empty until read. */
  botRoles(connection: string): ReadonlyMap<string, string> {
    const life = this.connections.get(connection);
    return new Map(life?.platform === 'discord' ? life.botRoles : []);
  }
  slack(connection: string, channel: string): SlackChannel | undefined {
    const life = this.connections.get(connection);
    if (life?.platform !== 'slack') return;
    const value = life.channels.get(channel) as SlackChannel | undefined;
    return value && { ...value };
  }
  close(): void { this.connections.clear(); }
}
