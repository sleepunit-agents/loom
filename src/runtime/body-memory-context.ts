/** Private starting context goes to the model, never into assignment/receipt metadata. */
import {z} from 'zod';
import type {bodyCommandClient} from './body-command-client.js';
const section=z.string().nullable();
const context=z.object({agent:z.string(),readAt:z.iso.datetime(),creed:section,preferences:section,selfModel:section,topOfMind:section,recent:section}).strict();
export const bodyMemoryQuery='query BodyMemory($agent:String!){memoryAgentContext(agent:$agent){agent readAt creed preferences selfModel topOfMind recent}}';
export async function bodyMemoryContext(client:Pick<ReturnType<typeof bodyCommandClient>,'query'>,agent:string):Promise<string|null>{
 const reply=await client.query({query:bodyMemoryQuery,variables:{agent}});
 if(reply.errors?.length)throw Error('Memory context unavailable');
 const parsed=z.object({memoryAgentContext:context.nullable()}).strict().parse(reply.data);
 const value=parsed.memoryAgentContext;if(!value)return null;
 if(value.agent!==agent)throw Error('Memory context unavailable');
 const sections=[['Identity',value.creed],['Preferences',value.preferences],['Self-Model',value.selfModel],['Top of Mind',value.topOfMind],['Last 24 hours',value.recent]];
 return sections.filter((part):part is [string,string]=>!!part[1]).map(([name,words])=>'# '+name+'\n\n'+words).join('\n\n')||null;
}
