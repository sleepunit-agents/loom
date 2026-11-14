/** Trusted history transport data. Runtime owns caller/reader and author policy. */
import { z } from 'zod';
import { isDiscordId } from './discord-id.js';
const snowflake = z.string().refine(isDiscordId);
export const discordHistoryQuery = z.object({channel:snowflake,kind:z.enum(['channel','thread']),after:snowflake.optional(),limit:z.number().int().min(1).max(100).optional()}).strict();
/** A trusted owning role must issue a current, exact-place permit. This is not a
 * stored grant, a public input or an admission decision made by Bridges. */
export interface DiscordHistoryPermit {
  readonly agent: string;
  readonly workspace: string;
  readonly channel: string;
  readonly kind: 'channel' | 'thread';
  current(): boolean;
}
const message = z.object({id:snowflake,channel_id:snowflake,guild_id:snowflake.optional(),type:z.number().int(),
  author:z.object({id:snowflake,bot:z.boolean().optional()}),webhook_id:snowflake.optional(),
  content:z.string().max(100_000),timestamp:z.unknown().optional(),
  attachments:z.array(z.object({filename:z.string(),url:z.string().url()})).optional(),
});
export interface DiscordHistoryMessage {id:string;at:string;user:string;bot:boolean;type:number;webhook?:string;text:string}
/** Preserve all source classes, including own/bot/system messages. Runtime must
 * resolve sender identity and may_wake; history never routes or starts a body. */
export function discordHistoryMessages(raw:unknown,channel:string,workspace:string,after?:string):DiscordHistoryMessage[] {
  const messages=z.array(message).max(100).parse(raw);
  if(new Set(messages.map(m=>m.id)).size!==messages.length)throw Error('Invalid history');
  return messages.map(m=>{
    if(m.channel_id!==channel||m.guild_id!==undefined&&m.guild_id!==workspace||after!==undefined&&BigInt(m.id)<=BigInt(after))throw Error('Invalid history');
    const timestamp=typeof m.timestamp==='string'&&z.iso.datetime({offset:true}).safeParse(m.timestamp).success?Date.parse(m.timestamp):NaN;
    const at=new Date(Number.isFinite(timestamp)?timestamp:Number((BigInt(m.id)>>22n)+1420070400000n)).toISOString();
    return {id:m.id,at,user:m.author.id,bot:m.author.bot??false,type:m.type,...(m.webhook_id?{webhook:m.webhook_id}:{}),
      text:m.content+(m.attachments??[]).map(a=>` [attachment: ${a.filename} ${a.url}]`).join('')};
  }).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
}
