/** Platform payloads from authenticated transports only. These functions do not
 * authenticate a webhook, resolve household members or decide who may speak.
 * Non-message notifications return null; malformed messages fail closed.
 */
import { z } from 'zod';
import type { IncomingMessage } from './incoming.js';
import { slackThread } from './place.js';
import { discordFileLink } from './discord-link.js';

const id = z.string().min(1).max(256);
const timestamp = z.string().regex(/^\d{1,12}\.\d{6}$/);
const slackChannelType = z.enum(['channel', 'group', 'im', 'mpim']);
const discordMessage = z.object({
  id, type: z.number().int(), channel_id: id, guild_id: id.optional(),
  author: z.object({ id, bot: z.boolean().optional() }),
  content: z.string(), timestamp: z.iso.datetime({ offset: true }),
  mentions: z.array(z.object({ id, bot: z.boolean().optional() })), webhook_id: id.optional(),
  // The roles the message pinged, as Discord resolved them.
  mention_roles: z.array(id).optional(),
  attachments: z.array(z.object({ filename: z.string(), size: z.number().int().nonnegative(), content_type: z.string().nullish(), url: z.string() }).passthrough()).optional(),
  // Present on a reply (type 19); null when the message replied to has been deleted.
  referenced_message: z.object({ author: z.object({ id }) }).nullish(),
});
const discordDispatch = z.object({ op: z.literal(0), t: z.string(), d: z.unknown() });
const slackEnvelope = z.object({ type: z.literal('event_callback'), team_id: id,
  event: z.object({ type: z.string(), subtype: z.string().optional() }).passthrough(),
});
const slackMessage = z.object({
  channel: id, channel_type: slackChannelType.optional(),
  ts: timestamp, thread_ts: timestamp.optional(), text: z.string(),
  // On a reply in a thread: who wrote the thread's root message.
  parent_user_id: id.optional(),
  user: id.optional(), bot_id: id.optional(), subtype: z.string().optional(),
});

export interface PlatformConnection { id: string; workspace: string }
/** Discord MESSAGE_CREATE does not contain the channel's type or parent.
 * The authenticated adapter must resolve this from its channel cache/API.
 * Group DMs, like one-to-one DMs, have no guild and are direct conversations.
 * `other` is a kind of channel loom carries no conversation in (the text chat of
 * a voice or stage channel, for one): what is posted there is for nobody here.
 */
export interface DiscordChannel {
  id: string;
  guild?: string;
  kind: 'channel' | 'thread' | 'dm' | 'other';
  group?: boolean;
  parent?: string;
  name?: string;
  parentName?: string;
  /** A thread only: who wrote the message it was started from, when that is known. */
  starter?: string;
}

/** Who the author mentioned by writing their mention. Discord's `mentions` list
 * also names the author of a message being replied to, but only when the
 * sender left the reply ping on, so it is not how a reply is recognised: an
 * explicit reply addresses the author of the message it answers whether or not
 * it pings, and that is carried separately as `repliesTo`. The list stays the
 * authority on who a written mention resolved to; the text only says which of
 * them were written. */
function discordSummons(content: string, resolved: string[], roles: string[], botRoles: ReadonlyMap<string, string>): string[] {
  const written = new Set([...content.matchAll(/<@!?([^<>\s&]+)>/g)].map(match => match[1]));
  // A bot that joined through an integration owns a role of its own name, and Discord's autocomplete
  // offers that role for the bot's name. A written ping of a bot's own role is a mention of that bot.
  // Any other role, `@everyone` and `@here` mention nobody.
  const writtenRoles = new Set([...content.matchAll(/<@&([^<>\s]+)>/g)].map(match => match[1]));
  const bots = roles.filter(role => writtenRoles.has(role)).flatMap(role => botRoles.get(role) ?? []);
  return [...new Set([...resolved.filter(id => written.has(id)), ...bots])];
}

/** The most attachments one Discord message carries, which is all that are listed. */
export const DISCORD_ATTACHMENTS = 10;
const ATTACHMENT_NAME = 200, ATTACHMENT_TYPE = 100;
/** A message's words with its attachments listed after them, one line each, so that a message that is only
 * a picture has words and a body can open what was sent. loom fetches nothing: the link is Discord's own
 * signed one, and it is given only when it is on Discord's file hosts. */
function discordWords(content: string, attachments: readonly { filename: string; size: number; content_type?: string | null; url: string }[]): string {
  const plain = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f[\]]+/g, '_').slice(0, max);
  const lines = attachments.slice(0, DISCORD_ATTACHMENTS).map(file => {
    const link = discordFileLink(file.url) ? ` ${file.url}` : '';
    return `[attachment: ${plain(file.filename, ATTACHMENT_NAME) || 'file'} (${plain(file.content_type ?? '', ATTACHMENT_TYPE) || 'unknown type'}, ${file.size} bytes)${link}]`;
  });
  return [...(content ? [content] : []), ...lines].join('\n');
}

export function normalizeDiscord(connection: PlatformConnection, payload: unknown, channel: DiscordChannel, botRoles: ReadonlyMap<string, string> = new Map()): IncomingMessage | null {
  const dispatch = discordDispatch.parse(payload);
  if (dispatch.t !== 'MESSAGE_CREATE') return null;
  const message = discordMessage.parse(dispatch.d);
  if (![0, 19, 20, 23].includes(message.type) || channel.kind === 'other') return null;
  if (message.channel_id !== channel.id || message.guild_id !== channel.guild
    || (channel.kind === 'dm' ? !!channel.guild : channel.guild !== connection.workspace)
    || (channel.kind === 'thread' && !channel.parent)) throw Error('Discord message does not match connection channel');
  const mentions = discordSummons(message.content, message.mentions.map(mention => mention.id), message.mention_roles ?? [], botRoles);
  const knownBots = new Set([...botRoles.values(), ...message.mentions.filter(mention => mention.bot).map(mention => mention.id)]);
  return {
    ...(mentions.some(id => knownBots.has(id)) && { mentionsBot: true }),
    ...(channel.name && { channelName: channel.name }), ...(channel.parentName && { parentName: channel.parentName }),
    id: message.id, connection: connection.id, channel: message.channel_id,
    ...(channel.kind === 'thread' ? { parent: channel.parent, thread: channel.id } : {}),
    ...(channel.kind === 'dm' && channel.group ? { groupDm: true } : {}),
    isDm: channel.kind === 'dm', user: message.author.id, text: discordWords(message.content, message.attachments ?? []),
    postedAt: new Date(message.timestamp).toISOString(),
    mentions,
    // An explicit reply answers the author it points at. Any other message in a thread answers whoever
    // wrote the message the thread was started from, as a Slack thread reply answers its root.
    ...(message.type === 19 && message.referenced_message ? { repliesTo: message.referenced_message.author.id }
      : message.type !== 19 && channel.kind === 'thread' && channel.starter ? { repliesTo: channel.starter } : {}),
    bot: message.author.bot ?? false, webhook: !!message.webhook_id,
  };
}

/** Some Slack message subtypes omit channel_type. The authenticated adapter
 * resolves channel metadata before draining those messages; never infer DM
 * privacy from a channel id prefix or from a missing field.
 */
export interface SlackChannel { id: string; kind: z.infer<typeof slackChannelType> }
/** Whether a channel is a direct message, and of which sort, is all that is read from its kind. Slack
 * itself does not name a private channel the same way twice: its events call one `group`, while the
 * channel's own details say `is_channel` for any made since private channels and public ones were unified.
 * So the two kinds of room are one kind here, and only a disagreement about being direct is a mismatch. */
const slackRoom = (kind: SlackChannel['kind']): 'room' | 'im' | 'mpim' => kind === 'channel' || kind === 'group' ? 'room' : kind;
export function normalizeSlack(connection: PlatformConnection, payload: unknown, channel?: SlackChannel): IncomingMessage | null {
  const envelope = slackEnvelope.parse(payload);
  if (envelope.team_id !== connection.workspace) throw Error('Slack event does not match connection workspace');
  if (envelope.event.type !== 'message' && envelope.event.type !== 'app_mention') return null;
  // Edits, deletes, join notices and reply summaries are not new messages.
  if (envelope.event.subtype && !['bot_message', 'file_share', 'thread_broadcast', 'me_message'].includes(envelope.event.subtype)) return null;
  const message = slackMessage.parse(envelope.event);
  const kind = message.channel_type ?? channel?.kind;
  if (!kind || (channel && (channel.id !== message.channel || (message.channel_type && slackRoom(channel.kind) !== slackRoom(message.channel_type))))) {
    throw Error('Slack message needs matching channel metadata');
  }
  if (!message.user && !message.bot_id) throw Error('Slack message has no sender');
  const millis = Number(message.ts.split('.')[0]) * 1000 + Number(message.ts.split('.')[1].slice(0, 3));
  return {
    // Slack timestamps are unique per channel, not across a workspace.
    id: JSON.stringify([message.channel, message.ts]), connection: connection.id,
    channel: message.channel, thread: slackThread(kind, message.ts, message.thread_ts),
    isDm: kind === 'im' || kind === 'mpim',
    ...(kind === 'mpim' ? { groupDm: true } : {}),
    // Legacy integrations have only a bot id. Never confuse it with a user id.
    user: message.user ?? `bot:${message.bot_id}`, text: message.text,
    postedAt: new Date(millis).toISOString(),
    // Slack's only reply is a reply in a thread; it answers the thread's root.
    ...(message.thread_ts && message.thread_ts !== message.ts && message.parent_user_id ? { repliesTo: message.parent_user_id } : {}),
    mentions: [...new Set([...message.text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/g, '').matchAll(/<@([A-Za-z0-9]+)(?:\|[^>]+)?>/g)].map(match => match[1]))],
    bot: !!message.bot_id || message.subtype === 'bot_message',
  };
}
