/** Private Identity goes to the model, never into assignment/receipt metadata. */
import {z} from 'zod';
import type {bodyCommandClient} from './body-command-client.js';
const section=z.string().nullable();
const identity=z.object({agent:z.string(),readAt:z.iso.datetime(),creed:section,preferences:section,selfModel:section,topOfMind:section,recent:section,role:section.optional()}).strict();
const pageName=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
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
 }catch{throw Error('Identity unavailable');}
}
