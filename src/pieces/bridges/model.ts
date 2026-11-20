import { z } from 'zod';
const id = z.string().min(1).max(200);
export const venueSchema = z.object({
  id, platform: z.enum(['discord', 'slack']), agent: id, workspace: id, bot: id,
  tokenSecret: id, appSecret: id.optional(), enabled: z.boolean().default(true),
  only: z.array(id).default([]), ignore: z.array(id).default([]),
  botRoles: z.array(id).default([]),
}).strict();
export const routeSchema = z.object({ id, platform: z.enum(['discord', 'slack']), workspace: id,
  channel: id, parent: id.optional(), primary: id.optional(), peer: z.boolean().default(false),
  pair: id.optional(), guest: z.boolean().default(false), readers: z.array(id).default([]), notes: z.array(id).default([]),
}).strict();
export const linkSchema = z.object({ id, platform: z.enum(['discord', 'slack']), workspace: id, user: id, person: id }).strict();
export type Venue = z.infer<typeof venueSchema>;
export type Route = z.infer<typeof routeSchema>;
export type PersonLink = z.infer<typeof linkSchema>;
export interface Message {
  id: string; channel: string; parent?: string; thread?: string; dm: boolean; group?: boolean;
  /** Original platform event time; never the receipt time. */
  at?: string; label?: string;
  /** Explicit summons after platform resolution, not the gateway's raw reply-ping list. */
  user: string; text: string; mentions: string[]; bot?: boolean; webhook?: string;
}
export interface Address { channel: string; thread?: string; dm: boolean; group?: boolean }
export interface ConversationKey { agent: string; who: string; venue: string }
/** Slack non-D conversations are always gated as groups, including old queues. */
export function conversationKind(venue: Pick<Venue,'platform'>, message: Pick<Message,'channel'|'dm'|'group'>): {dm:boolean;group?:boolean} {
  if(venue.platform !== 'slack') return {dm:message.dm,group:message.group};
  const group=!!message.group || !message.channel.startsWith('D');
  return {dm:!group,group};
}
export function keyFor(venue: Venue, message: Message, person: string): ConversationKey {
  const {dm,group}=conversationKind(venue,message);
  const place = dm ? `dm:${person}` : group ? `group:${message.channel}` : message.thread ? `thread:${message.channel}:${message.thread}` : `channel:${message.channel}`;
  return { agent: venue.agent, who: dm ? person : place, venue: `${venue.platform}:${venue.workspace}:${place}` };
}

/** Closed status summary shared by the operation and generated client. */
export const statusSchema = z.object({
  mode: z.enum(['live', 'staging']), agents: z.array(z.string()), held: z.number().int().nonnegative(),
}).strict();
