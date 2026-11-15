/** Private Identity goes to the model, never into assignment/receipt metadata. */
import {z} from 'zod';
import type {bodyCommandClient} from './body-command-client.js';
const section=z.string().nullable();
const identity=z.object({agent:z.string(),readAt:z.iso.datetime(),creed:section,preferences:section,selfModel:section,topOfMind:section,recent:section}).strict();
export const bodyIdentityQuery='query BodyMemory($agent:String!){memoryIdentity(agent:$agent){agent readAt creed preferences selfModel topOfMind recent}}';
export async function bodyMemoryIdentity(client:Pick<ReturnType<typeof bodyCommandClient>,'query'>,agent:string):Promise<string|null>{
 try{
 const reply=await client.query({query:bodyIdentityQuery,variables:{agent}});
 if(reply.errors?.length)throw Error('Identity unavailable');
 const parsed=z.object({memoryIdentity:identity.nullable()}).strict().parse(reply.data);
 const value=parsed.memoryIdentity;if(!value)return null;
 if(value.agent!==agent)throw Error('Identity unavailable');
 const sections=[['Identity',value.creed],['Preferences',value.preferences],['Self-Model',value.selfModel],['Top of Mind',value.topOfMind],['Last 24 hours',value.recent]];
 return sections.filter((part):part is [string,string]=>!!part[1]).map(([name,words])=>'# '+name+'\n\n'+words).join('\n\n')||null;
 }catch{throw Error('Identity unavailable');}
}
