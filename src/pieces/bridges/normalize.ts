/** Platform payloads from authenticated transports only. These functions do not
 * authenticate a webhook, resolve household members or decide who may speak.
 * Non-message notifications return null; malformed messages fail closed.
 */
import { z } from 'zod';
import type { IncomingMessage } from './incoming.js';

const id = z.string().min(1).max(256);
const timestamp = z.string().regex(/^\d{1,12}\.\d{6}$/);
const slackChannelType = z.enum(['channel', 'group', 'im', 'mpim']);
const discordMessage = z.object({
  id, type: z.number().int(), channel_id: id, guild_id: id.optional(),
  author: z.object({ id, bot: z.boolean().optional() }),
  content: z.string(), timestamp: z.iso.datetime({ offset: true }),
  mentions: z.array(z.object({ id })), webhook_id: id.optional(),
});
const discordDispatch = z.object({ op: z.literal(0), t: z.string(), d: z.unknown() });
const slackEnvelope = z.object({ type: z.literal('event_callback'), team_id: id,
  event: z.object({ type: z.string(), subtype: z.string().optional() }).passthrough(),
});
const slackMessage = z.object({
  channel: id, channel_type: slackChannelType.optional(),
  ts: timestamp, thread_ts: timestamp.optional(), text: z.string(),
  user: id.optional(), bot_id: id.optional(), subtype: z.string().optional(),
});

export interface PlatformConnection { id: string; workspace: string }
/** Discord MESSAGE_CREATE does not contain the channel's type or parent.
 * The authenticated adapter must resolve this from its channel cache/API.
 * Group DMs, like one-to-one DMs, have no guild and are direct conversations.
 */
export interface DiscordChannel {
  id: string;
  guild?: string;
  kind: 'channel' | 'thread' | 'dm';
  parent?: string;
}

export function normalizeDiscord(connection: PlatformConnection, payload: unknown, channel: DiscordChannel): IncomingMessage | null {
  const dispatch = discordDispatch.parse(payload);
  if (dispatch.t !== 'MESSAGE_CREATE') return null;
  const message = discordMessage.parse(dispatch.d);
  if (![0, 19, 20, 23].includes(message.type)) return null;
  if (message.channel_id !== channel.id || message.guild_id !== channel.guild
    || (channel.kind === 'dm' ? !!channel.guild : channel.guild !== connection.workspace)
    || (channel.kind === 'thread' && !channel.parent)) throw Error('Discord message does not match connection channel');
  return {
    id: message.id, connection: connection.id, channel: message.channel_id,
    ...(channel.kind === 'thread' ? { parent: channel.parent, thread: channel.id } : {}),
    isDm: channel.kind === 'dm', user: message.author.id, text: message.content,
    postedAt: new Date(message.timestamp).toISOString(),
    mentions: [...new Set(message.mentions.map(mention => mention.id))],
    bot: message.author.bot ?? false, webhook: !!message.webhook_id,
  };
}

/** Some Slack message subtypes omit channel_type. The authenticated adapter
 * resolves channel metadata before draining those messages; never infer DM
 * privacy from a channel id prefix or from a missing field.
 */
export interface SlackChannel { id: string; kind: z.infer<typeof slackChannelType> }
export function normalizeSlack(connection: PlatformConnection, payload: unknown, channel?: SlackChannel): IncomingMessage | null {
  const envelope = slackEnvelope.parse(payload);
  if (envelope.team_id !== connection.workspace) throw Error('Slack event does not match connection workspace');
  if (envelope.event.type !== 'message' && envelope.event.type !== 'app_mention') return null;
  // Edits, deletes, join notices and reply summaries are not new messages.
  if (envelope.event.subtype && !['bot_message', 'file_share', 'thread_broadcast', 'me_message'].includes(envelope.event.subtype)) return null;
  const message = slackMessage.parse(envelope.event);
  const kind = message.channel_type ?? channel?.kind;
  if (!kind || (channel && (channel.id !== message.channel || (message.channel_type && channel.kind !== message.channel_type)))) {
    throw Error('Slack message needs matching channel metadata');
  }
  if (!message.user && !message.bot_id) throw Error('Slack message has no sender');
  const millis = Number(message.ts.split('.')[0]) * 1000 + Number(message.ts.split('.')[1].slice(0, 3));
  return {
    // Slack timestamps are unique per channel, not across a workspace.
    id: JSON.stringify([message.channel, message.ts]), connection: connection.id,
    channel: message.channel, thread: message.thread_ts,
    isDm: kind === 'im' || kind === 'mpim',
    // Legacy integrations have only a bot id. Never confuse it with a user id.
    user: message.user ?? `bot:${message.bot_id}`, text: message.text,
    postedAt: new Date(millis).toISOString(),
    mentions: [...new Set([...message.text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/g, '').matchAll(/<@([A-Za-z0-9]+)(?:\|[^>]+)?>/g)].map(match => match[1]))],
    bot: !!message.bot_id || message.subtype === 'bot_message',
  };
}
