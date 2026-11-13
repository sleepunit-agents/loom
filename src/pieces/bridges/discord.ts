/** Discord gateway payload → durable bridge message. No IO or gate decisions. */
import { z } from 'zod';
import type { Message, Venue } from './model.js';

// Canonical positive uint64 strings; never coerce through a lossy JS number.
const snowflake = z.string().regex(/^[1-9]\d{0,19}$/)
  .pipe(z.string().refine(id => BigInt(id) <= 18_446_744_073_709_551_615n));
const payload = z.object({
  id: snowflake, channel_id: snowflake, guild_id: snowflake.optional(),
  type: z.number().int(), content: z.string(), timestamp: z.string().optional(),
  author: z.object({ id: snowflake, bot: z.boolean().optional() }),
  mentions: z.array(z.object({ id: snowflake })),
  mention_roles: z.array(snowflake), webhook_id: snowflake.optional(),
  attachments: z.array(z.object({filename: z.string(), url: z.string().url()})).default([]),
});

export interface DiscordChannel {
  id: string;
  /** Explicitly obtained from channel metadata, never guessed from message text. */
  kind: 'channel' | 'thread' | 'dm';
  parent?: string;
  name?: string;
  parentName?: string;
}

/** Return null for unsupported/system events or a connection/workspace mismatch.
 * mentions contains only written AND resolved summons, with managed roles mapped
 * to bot ids. Automatic reply pings therefore cannot suppress the primary.
 * A thread's own name is never used: Discord may derive it from private text.
 */
export function discordMessage(raw: unknown, venue: Venue, channel: DiscordChannel, bots: Venue[]): Message | null {
  const parsed = payload.safeParse(raw);
  if (!parsed.success || venue.platform !== 'discord') return null;
  const m = parsed.data;
  if (m.channel_id !== channel.id || ![0, 19].includes(m.type) || m.author.id === venue.bot) return null;
  if (channel.kind === 'dm' ? m.guild_id !== undefined : m.guild_id !== venue.workspace) return null;
  if (channel.kind === 'thread' && !channel.parent) return null;
  const resolved = new Set(m.mentions.map(u => u.id));
  const mentions = new Set([...m.content.matchAll(/<@!?(\d+)>/g)].map(hit => hit[1]).filter(id => resolved.has(id)));
  const roles = new Set(m.mention_roles);
  for (const hit of m.content.matchAll(/<@&(\d+)>/g)) {
    if (!roles.has(hit[1])) continue;
    for (const bot of bots) if (bot.platform === 'discord' && bot.workspace === venue.workspace && bot.botRoles.includes(hit[1])) mentions.add(bot.bot);
  }
  return {
    id: m.id, channel: m.channel_id, user: m.author.id,
    text: m.content + m.attachments.map(a => ` [attachment: ${a.filename} ${a.url}]`).join(''),
    mentions: [...mentions], dm: channel.kind === 'dm', bot: m.author.bot,
    webhook: m.webhook_id, at: m.timestamp,
    ...(channel.kind === 'thread' ? {parent: channel.parent, thread: channel.id} : {}),
    label: channel.kind === 'thread' ? (channel.parentName ? `#${channel.parentName} thread` : 'thread')
      : channel.kind === 'dm' ? 'Direct message' : `#${channel.name || channel.id}`,
  };
}
