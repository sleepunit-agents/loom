/** Disposable metadata from authenticated platform adapters. Never feed message
 * fields into these writers. Composition binds after authentication and closes
 * on disconnect/setup changes; an old writer cannot update a newer lifetime.
 * No network, credentials, database writes or household admission live here.
 */
import { z } from 'zod';
import type { BridgeChannelCache } from './receiver.js';
import type { DiscordChannel, SlackChannel } from './normalize.js';

const id = z.string().min(1).max(256);
const discordEvidence = z.object({ id, type: z.number().int(), guild_id: id.nullish(), parent_id: id.nullish() });
const slackEvidence = z.object({ id, context_team_id: id.optional(), is_im: z.boolean().optional(), is_mpim: z.boolean().optional(), is_channel: z.boolean().optional(), is_group: z.boolean().optional() });
type Binding = { platform: 'discord' | 'slack'; workspace: string };
type Lifetime = Binding & { channels: Map<string, DiscordChannel | SlackChannel> };

export class BridgeChannels implements BridgeChannelCache {
  private readonly connections = new Map<string, Lifetime>();

  /** Bind a new authenticated lifetime. Fetches may finish asynchronously; keep
   * this writer with the fetch so late results cannot cross a rebind/close.
   * Slack channel objects have no team field: the authenticated API client must
   * already be bound to this workspace, just like the receiver transport.
   */
  bind(connection: string, binding: Binding) {
    id.parse(connection);
    const source = z.object({ platform: z.enum(['discord', 'slack']), workspace: id }).parse(binding);
    const life: Lifetime = { ...source, channels: new Map() };
    this.connections.set(connection, life);
    const current = () => this.connections.get(connection) === life;
    return {
      /** Expected channel is the requested API channel or authenticated event's
       * channel. Invalidate before validation so bad updates leave no stale row.
       * Unsupported kinds return false; malformed/mismatched evidence throws.
       */
      put: (channel: string, evidence: unknown): boolean => {
        if (!current()) return false;
        id.parse(channel);
        life.channels.delete(channel);
        if (life.platform === 'discord') {
          const raw = discordEvidence.parse(evidence);
          if (raw.id !== channel) throw Error('Discord channel id mismatch');
          let value: DiscordChannel;
          if ([1, 3].includes(raw.type)) {
            if (raw.guild_id != null) throw Error('Discord DM has a guild');
            value = { id: channel, kind: 'dm' };
          } else {
            if (raw.guild_id !== life.workspace) throw Error('Discord channel workspace mismatch');
            if ([0, 5].includes(raw.type)) value = { id: channel, guild: life.workspace, kind: 'channel' };
            else if ([10, 11, 12].includes(raw.type)) {
              if (!raw.parent_id || raw.parent_id === channel) throw Error('Discord thread needs a parent');
              value = { id: channel, guild: life.workspace, kind: 'thread', parent: raw.parent_id };
            } else return false;
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
  slack(connection: string, channel: string): SlackChannel | undefined {
    const life = this.connections.get(connection);
    if (life?.platform !== 'slack') return;
    const value = life.channels.get(channel) as SlackChannel | undefined;
    return value && { ...value };
  }
  close(): void { this.connections.clear(); }
}
