/** Made-here work is read through the owning pieces, with the original viewer. */
import { z } from 'zod';
import { operation, type Operations, type Live, type Viewer, type Clock, type Sharing } from '../../core/index.js';
import { tasksRole } from '../tasks/role.js';
const task = z.object({id:z.string(),title:z.string(),status:z.enum(['open','in_progress','closed']),source:z.string().optional(),assignee:z.string().optional(),createdAt:z.string(),startedAt:z.string().optional(),closedAt:z.string().optional(),closeReason:z.string().optional()});
const exported = z.object({result:z.object({ok:z.literal(true),tasks:z.array(task),links:z.array(z.object({id:z.string(),dependsOn:z.string(),type:z.string()}))})});
const feed = z.object({items:z.array(z.object({title:z.string().max(200),ref:z.string().max(200),status:z.string().max(24),when:z.string().optional(),tone:z.enum(['bad','warn','ok']).optional(),made:z.literal(true).optional()}))});
export interface WorkItem { title:string;ref:string;status:string;from:'tasks'|'changes';made:true;when?:string;tone?:'bad'|'warn'|'ok';url:string }
interface Options {operations:Operations;live:Live;clock:Clock;sharing():Sharing;thread(viewer:Viewer,id:string):{conversation:string}|undefined}
export function installCommsWork(o:Options) {
 const read=(viewer:Viewer,id:string)=>{
  const thread=o.thread(viewer,id);if(!thread)return;
  const items:WorkItem[]=[],failed:string[]=[];let expiresAt:number|undefined;
  try {
   const answer=tasksRole(o.operations).call(viewer,'export',{});
   if(!answer.ok)throw new Error();
   const {tasks,links}=exported.parse(answer.value).result;
   const unfinished=new Set(tasks.filter(t=>t.status!=='closed').map(t=>t.id));
   const blockers=new Set(links.filter(l=>l.type==='blocks'&&unfinished.has(l.dependsOn)).map(l=>l.id));
   for(const t of tasks.filter(t=>t.id.length<=200&&t.source===`conversation:${thread.conversation}`)) {
    // Hidden blockers still suppress ready work in Tasks. Do not infer or expose
    // hidden endpoints here: this panel reports stored status, not readiness.
    const blocked=t.status!=='closed'&&blockers.has(t.id);
    const waiting=t.status!=='closed'&&t.assignee!==undefined&&Object.hasOwn(o.sharing().members,t.assignee)&&o.sharing().members[t.assignee].owner;
    items.push({ref:t.id,title:t.title.slice(0,200),from:'tasks',made:true,status:blocked?'Blocked':waiting?(t.assignee===viewer.id?'Waiting on you':`Waiting on ${t.assignee}`):t.status==='open'?'Open':t.status==='in_progress'?'In progress':t.closeReason==='cancelled'?'Cancelled':'Done',
     ...(blocked?{tone:'bad' as const}:waiting?{tone:'warn' as const}:t.status==='closed'?{tone:'ok' as const}:{}),when:t.closedAt??t.startedAt??t.createdAt,url:`/p/tasks-preview/task/~${encodeURIComponent(t.id)}`});
   }
  } catch {failed.push('Tasks');}
  try {
   const answer=o.operations.call('direct',viewer,'changes.thread-feed',{conversation:thread.conversation,references:[]});
   if(!answer.ok)throw new Error();
   const changes=feed.parse(answer.value).items.filter(item=>item.made);
   // The owning piece applies its seven-day closed-change window. Schedule the
   // same boundary for this derived record even when no other write happens.
   const listed=o.operations.call('direct',viewer,'changes.list',{});
   if(!listed.ok)throw new Error();
   const rows=z.array(z.object({id:z.string(),state:z.string(),closed:z.string().nullable()})).parse(listed.value);
   for(const item of changes) {
    const row=rows.find(c=>c.id===item.ref);
    if(!row)continue;
    if(row.state!=='open'&&row.closed){const until=Date.parse(row.closed)+7*86400_000;if(until>o.clock.now())expiresAt=Math.min(expiresAt??Infinity,until);}
    items.push({...item,made:true,from:'changes',url:`/p/changes-preview/change/${encodeURIComponent(item.ref)}`});
   }
  } catch {failed.push('Changes');}
  const rank=(tone:WorkItem['tone'])=>tone==='bad'?0:tone==='warn'?1:2;
  // All these items are made here. Match the original piece-name precedence
  // without mixing fields from a task and a Change sharing an imported id.
  const unique=new Map<string,WorkItem>();
  for(const item of [...items].sort((a,b)=>a.from.localeCompare(b.from)))if(!unique.has(item.ref))unique.set(item.ref,item);
  const ordered=[...unique.values()];
  ordered.sort((a,b)=>rank(a.tone)-rank(b.tone)||(Date.parse(b.when??'')||0)-(Date.parse(a.when??'')||0)||a.ref.localeCompare(b.ref));
  return {id,items:ordered.slice(0,100),failed,...(expiresAt===undefined?{}:{expiresAt})};
 };
 o.operations.register(operation({name:'comms.work',doors:['socket'],windowOnly:true,
  input:z.object({thread:z.string().min(1).max(200)}).strict(),output:z.unknown(),
  may:(viewer,input)=>!!o.thread(viewer,input.thread),run:(ctx,input)=>read(ctx.viewer,input.thread),
 }));
 o.live.register({name:'threadWork',windowOnly:true,ids:scope=>scope?[scope]:[],
  read:(id,viewer)=>read(viewer,id),inScope:(record,scope)=>record.id===scope,
  refreshOn:change=>['task','change','thread','core.access'].includes(change.type),
  expires:record=>typeof record.expiresAt==='number'?record.expiresAt:undefined,
 });
}
