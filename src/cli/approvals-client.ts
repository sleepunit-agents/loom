/** Metadata generated command surface; transport only, with no store, parser or approval decisions. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './api-client.js';
import { approvalCommands } from '../pieces/approvals/commands.js';
import type { CommandAnswer } from '../pieces/approvals/binding.js';
export async function runApprovalsClient(argv:string[],io:IOStreams,runtime:ClientRuntime={request:fetch,retry:ms=>new Promise(r=>setTimeout(r,ms))}):Promise<number>{
  if(argv[0]==='--help'||argv[0]==='-h'){io.stdout(`usage: approvals <${approvalCommands.map(c=>c.name).join('|')}> ...\n`);return 0;}
  const fail=(message:string)=>{io.stderr(`approvals: ${message}\n`);return 1;};
  let token:string,base:URL;
  try{base=new URL(io.env.LOOM_URL??'http://127.0.0.1:8787');if(!io.env.LOOM_TOKEN_FILE)throw Error('LOOM_TOKEN_FILE is required');token=(await readFile(io.env.LOOM_TOKEN_FILE,'utf8')).trim();if(!token)throw Error('Token file is empty');}catch(e){return fail((e as Error).message);}
  const body=JSON.stringify({id:randomUUID(),input:{argv}});
  for(let attempt=0;attempt<4;attempt++){
    try{
      const response=await runtime.request(new URL('/api/approvals/command',base),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body,signal:AbortSignal.timeout(1500)});
      const answer=await response.json() as {ok:boolean;value?:CommandAnswer;message?:string};
      if(response.status===503&&attempt<3){await runtime.retry(100*(attempt+1));continue;}
      if(!answer.ok||!answer.value)return fail(answer.message??'Invalid daemon response');
      io.stdout(answer.value.stdout);io.stderr(answer.value.stderr);return answer.value.exit;
    }catch{if(attempt===3)return fail('loom daemon is unavailable');}
    await runtime.retry(100*(attempt+1));
  }
  return fail('loom daemon is unavailable');
}
