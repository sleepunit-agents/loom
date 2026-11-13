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
  user: string; text: string; mentions: string[]; bot?: boolean; webhook?: string;
}
export interface Address { channel: string; thread?: string; dm: boolean; group?: boolean }
export interface ConversationKey { agent: string; who: string; venue: string }
export function keyFor(venue: Venue, message: Message, person: string): ConversationKey {
  const place = message.dm ? `dm:${person}` : message.group ? `group:${message.channel}` : message.thread ? `thread:${message.channel}:${message.thread}` : `channel:${message.channel}`;
  return { agent: venue.agent, who: message.dm ? person : place, venue: `${venue.platform}:${venue.workspace}:${place}` };
}
