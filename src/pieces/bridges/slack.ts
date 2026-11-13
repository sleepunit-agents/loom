/** Slack message event → bridge message. Pure formatting, never admission. */
import { z } from 'zod';
import type { Message, Venue } from './model.js';

const id = z.string().regex(/^[A-Z][A-Z0-9]+$/).max(200);
const ts = z.string().regex(/^\d{1,12}\.\d{1,20}$/);
const event = z.object({
  type: z.literal('message'), channel: id, user: id, ts,
  team: id.optional(), text: z.string().default(''),
  subtype: z.literal('file_share').nullish(), bot_id: z.string().optional(),
  thread_ts: ts.optional(),
  files: z.array(z.object({id, name: z.string()})).default([]),
});
const conversationSchema = z.object({
  id, workspace: id, kind: z.enum(['dm', 'group']),
  /** Names are resolved People display names, never Slack-provided mention labels. */
  members: z.array(z.object({user: id, name: z.string().optional()})).default([]),
});
export type SlackConversation = z.infer<typeof conversationSchema>;
export interface SlackPerson { user: string; name?: string }

const printable = (name: string) => name.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
function label(group: boolean, user: string, members: SlackPerson[], bot: string): string {
  const humans = [...new Map(members.filter(m => m.user !== bot).map(m => [m.user,m])).values()];
  if (!group) {
    const name = printable(humans.find(m => m.user === user)?.name ?? '');
    const value = name ? `DM with ${name}` : 'DM';
    return value.length <= 80 ? value : 'DM';
  }
  const names = humans.map(m => printable(m.name ?? '')).filter(Boolean).sort();
  for (let count = names.length; count > 0; count--) {
    const more = humans.length - count;
    const value = `group DM with ${names.slice(0,count).join(', ')}` + (more ? ` and ${more} more` : '');
    if (value.length <= 80) return value;
  }
  return humans.length ? `group DM with ${humans.length} people` : 'group DM';
}

/** Resolve written markup before decoding Slack's escapes ONCE. Encoded mentions
 * remain literal. Unknown users become @someone; an untrusted |label is ignored.
 */
export function slackText(text: string, people: SlackPerson[], venue: Venue): string {
  const names = new Map(people.map(p => [p.user,p.name]));
  return text.replace(/<@([A-Z][A-Z0-9]+)(?:\|[^>]*)?>/g, (_match, user: string) =>
    `@${user === venue.bot ? venue.agent : names.get(user) || 'someone'}`)
    .replace(/<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/g, (_match, url: string, title?: string) => title ? `${title} (${url})` : url)
    .replace(/&lt;|&gt;|&amp;/g, escape => ({'&lt;':'<','&gt;':'>','&amp;':'&'}[escape]!));
}

/** conversation comes from connection-bound metadata, not the event's channel_type.
 * This validates shape and provenance only: users.info, fresh group membership,
 * unambiguous links and runtime admission remain mandatory in the real adapter.
 */
export function slackMessage(raw: unknown, venue: Venue, metadata: SlackConversation): Message | null {
  const parsed = event.safeParse(raw), conversation = conversationSchema.safeParse(metadata);
  if (!parsed.success || !conversation.success || venue.platform !== 'slack') return null;
  const m = parsed.data, c = conversation.data;
  if (c.workspace !== venue.workspace || c.id !== m.channel || (m.team !== undefined && m.team !== venue.workspace)
    || m.user === venue.bot || m.bot_id !== undefined) return null;
  // A non-D conversation is always a room even if its DM flag was lost.
  const group = c.kind === 'group' || !c.id.startsWith('D');
  return {
    id: m.ts, channel: m.channel, user: m.user, dm: !group, group,
    ...(m.thread_ts && m.thread_ts !== m.ts ? {thread:m.thread_ts} : {}),
    text: slackText(m.text,c.members,venue) + m.files.map(f => ` [file: ${f.name}]`).join(''),
    mentions: [], label: label(group,m.user,c.members,venue.bot),
  };
}
