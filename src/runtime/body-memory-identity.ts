/** Private Identity goes to the model, never into assignment/receipt metadata. */
import {BodyContactExpired} from './body-contact.js';
import {PAGE_NAME} from '../slug.js';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {bodyCommandClient} from './body-command-client.js';
const section=z.string().nullable();
const identity=z.object({agent:z.string(),readAt:z.iso.datetime(),creed:section,preferences:section,selfModel:section,topOfMind:section,recent:section,role:section.optional()}).strict();
const pageName=PAGE_NAME;
export const bodyIdentityQuery='query BodyMemory($agent:String!){memoryIdentity(agent:$agent){agent readAt creed preferences selfModel topOfMind recent}}';
/** The same, with the agent's authored page for where this body was started: roles/<venue>.md beside the creed.
 * A body started by a trigger is on the wake venue, so roles/wake.md is what every lane is told. */
export const bodyVenueIdentityQuery='query BodyMemory($agent:String!,$venue:String!){memoryIdentity(agent:$agent){agent readAt creed preferences selfModel topOfMind recent role:page(kind:"role",name:$venue)}}';
export async function bodyMemoryIdentity(client:Pick<ReturnType<typeof bodyCommandClient>,'query'>,agent:string,venue?:string|null):Promise<string|null>{
 try{
 const page=venue&&pageName.test(venue)?venue:undefined;
 const reply=await client.query(page?{query:bodyVenueIdentityQuery,variables:{agent,venue:page}}:{query:bodyIdentityQuery,variables:{agent}});
 if(reply.errors?.length)throw Error('Identity unavailable');
 const parsed=z.object({memoryIdentity:identity.nullable()}).strict().parse(reply.data);
 const value=parsed.memoryIdentity;if(!value)return null;
 if(value.agent!==agent)throw Error('Identity unavailable');
 const sections=[['Identity',value.creed],['Preferences',value.preferences],['Self-Model',value.selfModel],['Top of Mind',value.topOfMind],['Last 24 hours',value.recent],['Mode: '+page,value.role]];
 return sections.filter((part):part is [string,string]=>!!part[1]).map(([name,words])=>'# '+name+'\n\n'+words).join('\n\n')||null;
 }catch(error){if(error instanceof BodyContactExpired)throw error;throw Error('Identity unavailable');}
}
/** One more of the agent's role pages, by name: the brief a bridge channel's rule names for the conversations
 * in it (pieces/bridges/settings.ts). Null when the agent has no such page: the caller goes on without it. */
export const bodyRolePageQuery='query BodyRolePage($agent:String!,$name:String!){memoryIdentity(agent:$agent){agent role:page(kind:"role",name:$name)}}';
export async function bodyRolePage(client:Pick<ReturnType<typeof bodyCommandClient>,'query'>,agent:string,name:string):Promise<string|null>{
 try{
  if(!pageName.test(name))return null;
  const reply=await client.query({query:bodyRolePageQuery,variables:{agent,name}});
  if(reply.errors?.length)throw Error('Identity unavailable');
  const value=z.object({memoryIdentity:z.object({agent:z.string(),role:section.optional()}).strict().nullable()}).strict().parse(reply.data).memoryIdentity;
  if(value&&value.agent!==agent)throw Error('Identity unavailable');
  return value?.role?'# Brief for this channel: '+name+'\n\n'+value.role:null;
 }catch(error){if(error instanceof BodyContactExpired)throw error;throw Error('Identity unavailable');}
}
/** The brief of the channel this body's bridge conversation is in, or null: none named, none found, or
 * loom could not say. Asking and reporting are best effort; only the page read itself can fail the caller,
 * as the identity read does. */
export async function bodyChannelBrief(client:Pick<ReturnType<typeof bodyCommandClient>,'query'|'command'>,agent:string):Promise<string|null>{
 let name:string|null=null;
 try{const asked=await client.command('bridges.brief',{},randomUUID());if(asked.ok)name=z.object({brief:z.string().nullable()}).strict().parse(asked.value).brief;}catch{return null;}
 if(!name)return null;
 const page=await bodyRolePage(client,agent,name);
 if(page===null){try{await client.command('bridges.briefMissing',{},randomUUID());}catch{/* the work goes on without the notice too */}}
 return page;
}
