/** Generated argument binding and transport only. Feed/list rendering belongs to the daemon. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { changesCommands } from '../pieces/changes/commands.js';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './api-client.js';
const item=z.object({title:z.string(),status:z.string(),ref:z.string(),when:z.string().optional(),page:z.string().optional(),href:z.string().optional(),tone:z.enum(['bad','warn','ok']).optional(),made:z.boolean().optional(),who:z.array(z.string()).optional()});
const responses={
 list:z.object({stdout:z.string()}), refresh:z.object({message:z.literal('asked for a read')}),
 'cited-by':z.array(z.object({id:z.string(),title:z.string(),short:z.string(),page:z.string(),words:z.string()})),
 'project-feed':z.object({groups:z.array(z.object({title:z.string(),waiting:z.boolean().optional(),items:z.array(item)}))}),
 'thread-feed':z.object({items:z.array(item)}),
};
const defaults:ClientRuntime={request:(...args)=>fetch(...args),retry:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
export async function runChangesClient(argv:string[],io:IOStreams,runtime:ClientRuntime=defaults):Promise<number> {
 const help=`usage: loom-changes <${changesCommands.map(c=>c.name).join('|')}> ...\n`;
 if(!argv.length||['--help','-h'].includes(argv[0])) {io.stdout(help);return 0;}
 const command=changesCommands.find(c=>c.name===argv[0]);
 if(!command){io.stderr(help);return 2;}
 const input:Record<string,unknown>={cli:true};let position=0;
 const invalid=()=>{io.stderr(help);return 2;};
 for(let i=1;i<argv.length;i++) {
  const arg=argv[i];
  if(arg.startsWith('--')) {
   const flag=arg.slice(2),path=command.flags?.[flag];if(!path) return invalid();
   if(command.booleanFlags?.includes(flag)){input[path]=true;continue;}
   const value=argv[++i];if(value===undefined||value.startsWith('--')) return invalid();
   if(command.repeatedFlags?.includes(flag)) ((input[path]??=[]) as string[]).push(value);
   else input[path]=value;
  } else {const path=command.positional?.[position++];if(!path) return invalid();input[path]=arg;}
 }
 const fail=(message:string)=>{io.stderr(`loom-changes: ${message}\n`);return 1;};
 let base:URL,token:string;
 try {if(!io.env.LOOM_URL) return fail('LOOM_URL is required');base=new URL(io.env.LOOM_URL);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash) return fail('Invalid LOOM_URL');if(!io.env.LOOM_TOKEN_FILE) return fail('LOOM_TOKEN_FILE is required');token=(await readFile(io.env.LOOM_TOKEN_FILE,'utf8')).trim();if(!token) return fail('Token file is empty');}
 catch {return fail('Cannot configure loom connection');}
 const body=JSON.stringify({input,...(command.write?{id:randomUUID()}:{})});
 for(let attempt=0;attempt<4;attempt++) {
  try {
   const response=await runtime.request(new URL(`/api/changes/${command.name}`,base),{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body,signal:AbortSignal.timeout(1500)});
   if(response.status===503&&attempt<3){await response.body?.cancel().catch(()=>{});await runtime.retry(100*(attempt+1));continue;}
   const answer=await response.json() as unknown;
   if(!response.ok) return fail('Request refused');
   const envelope=z.object({ok:z.literal(true),value:z.unknown()}).safeParse(answer);
   if(!envelope.success) return fail('Invalid daemon response');
   const parsed=responses[command.name as keyof typeof responses].safeParse(envelope.data.value);
   if(!parsed.success) return fail('Invalid daemon response');
   const value=parsed.data;
   const output=command.name==='list'?(value as {stdout:string}).stdout:command.name==='refresh'?(value as {message:string}).message+'\n':JSON.stringify(value)+'\n';
   io.stdout(output.replaceAll(token,'[redacted]').replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g,'[redacted]'));
   return 0;
  } catch {if(attempt===3) return fail('loom daemon is unavailable');}
  await runtime.retry(100*(attempt+1));
 }
 return fail('loom daemon is unavailable');
}
