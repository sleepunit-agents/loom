/** Generated argument binding and transport only. Feed/list rendering belongs to the daemon. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { changesCommands } from '../pieces/changes/commands.js';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './api-client.js';
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
 try {base=new URL(io.env.LOOM_URL??'http://127.0.0.1:8787');if(!io.env.LOOM_TOKEN_FILE) return fail('LOOM_TOKEN_FILE is required');token=(await readFile(io.env.LOOM_TOKEN_FILE,'utf8')).trim();if(!token) return fail('Token file is empty');}
 catch {return fail('Cannot configure loom connection');}
 const body=JSON.stringify({input,...(command.write?{id:randomUUID()}:{})});
 for(let attempt=0;attempt<4;attempt++) {
  try {
   const response=await runtime.request(new URL(`/api/changes/${command.name}`,base),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body,signal:AbortSignal.timeout(1500)});
   if(response.status===503&&attempt<3){await runtime.retry(100*(attempt+1));continue;}
   const answer=await response.json() as {ok?:boolean;value?:unknown};
   if(answer.ok!==true) return fail('Request refused');
   const value=answer.value as {stdout?:unknown;message?:unknown}|null;
   if(command.name==='list') {if(typeof value?.stdout!=='string') return fail('Invalid daemon response');io.stdout(value.stdout);}
   else if(command.name==='refresh') {if(typeof value?.message!=='string') return fail('Invalid daemon response');io.stdout(value.message+'\n');}
   else io.stdout(JSON.stringify(answer.value)+'\n');
   return 0;
  } catch {if(attempt===3) return fail('loom daemon is unavailable');}
  await runtime.retry(100*(attempt+1));
 }
 return fail('loom daemon is unavailable');
}
