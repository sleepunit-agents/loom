/** Outside Tasks client: generated reads and the canonical command door only. */
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {parseRedactedJSON} from '../pieces/changes/redact.js';
import {DOOR_REQUEST_BYTES} from '../core/data/door-limit.js';
import {doorConnection} from './connection.js';
import {readStdin,type IOStreams} from './io.js';
import type { ClientRuntime } from './io.js';

const query=`query Taskstore {
 tasks(orderBy:{priority:{direction:asc,priority:2},position:{direction:asc,priority:1},id:{direction:asc,priority:0}}){
  id title type status priority position ownerKind owner project assigneeKind assignee
  goal why doneWhen description ask ifYes ifNo closeReason sourceKind sourceId isReady isShelved
 }
}`;
const textField=z.string().nullable().optional();
const taskReply=z.object({data:z.object({tasks:z.array(z.object({
 id:z.string(),title:z.string(),isReady:z.boolean(),
 // Unfinished, in a retired project. A field of its own: the stored status is printed as it is.
 isShelved:z.boolean().optional(),
 type:textField,status:textField,priority:z.number().optional(),position:z.number().optional(),
 ownerKind:textField,owner:textField,project:textField,assigneeKind:textField,assignee:textField,
 goal:textField,why:textField,doneWhen:textField,description:textField,ask:textField,ifYes:textField,ifNo:textField,
 closeReason:textField,sourceKind:textField,sourceId:textField,
}))})});
// One task's id, or for a move to a project the tasks that moved.
const commandReply=z.object({ok:z.literal(true),value:z.object({id:z.string().optional(),moved:z.array(z.string()).optional()}).strict()});
const defaults:ClientRuntime={request:(...args)=>fetch(...args),retry:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
const help='usage: loom-taskstore ready|list|show <id>|search <words>|command <JSON>|command --file <path|->\nWrites use the same typed action/input object as POST /api/tasks/command.\n';
const searchFields=['id','title','description','goal','why','doneWhen','ask'] as const;

export async function runSharedTaskClient(argv:string[],io:IOStreams,runtime:ClientRuntime=defaults):Promise<number>{
 const [verb,...args]=argv;
 if(['--help','-h'].includes(verb)){io.stdout(help);return 0;}
 const invalid=()=>{io.stderr(help);return 2;};
 if(!['ready','list','show','search','command'].includes(verb)
  || ['ready','list'].includes(verb)&&args.length!==0
  || verb==='show'&&(args.length!==1||!args[0].trim())
  || verb==='search'&&(!args.length||!args.join(' ').trim())
  || verb==='command'&&!(args.length===1&&args[0]!=='--file'||args.length===2&&args[0]==='--file'&&!!args[1])
  || verb==='command'&&args[0]==='--file'&&args[1]==='-'&&io.stdinIsTTY)return invalid();
 const fail=(message:string)=>{io.stderr('loom-taskstore: '+message+'\n');io.stdout(JSON.stringify({ok:false,errors:[message]})+'\n');return 1;};
 let input:unknown;
 if(verb==='command'){
  try{
   const text=args[0]==='--file'?(args[1]==='-'?await readStdin(io.stdin):await readFile(args[1],'utf8')):args[0];
   if(Buffer.byteLength(text)>DOOR_REQUEST_BYTES)throw Error();input=JSON.parse(text);
   if(!input||typeof input!=='object'||Array.isArray(input)||typeof (input as {action?:unknown}).action!=='string')return invalid();
  }catch{return fail('Invalid command input');}
 }
 let base:URL,token:string;
 try{({base,token}=await doorConnection(io.env));}catch{return fail('Cannot configure loom connection');}
 const write=verb==='command';
 const selection=verb==='ready'?query.replace('tasks(orderBy:','tasks:readyTasks(orderBy:'):verb==='show'?query.replace('query Taskstore {','query Taskstore($id:String!){').replace('tasks(orderBy:','tasks(where:{id:{eq:$id}},orderBy:'):query;
 const body=JSON.stringify(write?{id:randomUUID(),input}:{query:selection,...(verb==='show'?{variables:{id:args[0]}}:{})});
 for(let attempt=0;attempt<4;attempt++){
  try{
   const response=await runtime.request(new URL(write?'/api/tasks/command':'/graphql',base),{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+token},body,signal:AbortSignal.timeout(1500)});
   if(response.status===503&&attempt<3){await response.body?.cancel().catch(()=>{});await runtime.retry(100*(attempt+1));continue;}
   if(!response.ok){await response.body?.cancel().catch(()=>{});return fail('Request refused');}
   const answer=parseRedactedJSON(await response.text(),token);
   if(write){const parsed=commandReply.safeParse(answer);if(!parsed.success)return fail('Invalid daemon response');io.stdout(JSON.stringify({ok:true,...parsed.data.value},null,2)+'\n');return 0;}
   const parsed=taskReply.safeParse(answer);if(!parsed.success||answer&&typeof answer==='object'&&'errors'in answer)return fail('Invalid daemon response');
   const tasks=parsed.data.data.tasks;
   const value=verb==='show'?tasks.find(row=>row.id===args[0]):verb==='ready'?tasks.filter(row=>row.isReady):verb==='search'?tasks.filter(row=>searchFields.some(field=>typeof row[field]==='string'&&(row[field] as string).toLowerCase().includes(args.join(' ').toLowerCase()))):tasks;
   if(value===undefined)return fail('Task not found');
   io.stdout(JSON.stringify({ok:true,[verb==='show'?'task':verb==='ready'?'entries':'tasks']:value},null,2)+'\n');return 0;
  }catch{if(attempt===3)return fail('Loom is unavailable');}
  await runtime.retry(100*(attempt+1));
 }
 return fail('Loom is unavailable');
}
