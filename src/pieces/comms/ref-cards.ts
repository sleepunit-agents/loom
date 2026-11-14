/** Cards are projections of the owning pieces under the original window viewer. */
import {z} from 'zod';
import {operation,type Operations,type Live,type Viewer} from '../../core/index.js';
import {ownedConversation} from './from.js';
import type {Db, Sharing} from '../../core/index.js';
import {tasksRole} from '../tasks/role.js';
export interface RefCard {kind:'task'|'pr'|'conversation';title:string;status:string;tone?:'bad'|'warn'|'ok';url:string}
const request=z.object({thread:z.string().min(1).max(200),refs:z.array(z.string().min(1).max(200)).max(60)}).strict();
const task=z.object({result:z.object({ok:z.literal(true),task:z.object({id:z.string(),title:z.string(),status:z.enum(['open','in_progress','closed']),closeReason:z.string().optional()})})});
const change=z.object({id:z.string(),title:z.string(),status:z.string(),state:z.enum(['open','merged','closed']),page:z.string()});
const forge=/^github:([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/;
export function installRefCards(o:{db:Db;sharing():Sharing;operations:Operations;live:Live;thread(viewer:Viewer,id:string):{conversation:string}|undefined}) {
 const read=(viewer:Viewer,input:z.infer<typeof request>)=>{
  const thread=o.thread(viewer,input.thread);if(!thread)return;
  const cards:Record<string,RefCard|null>=Object.create(null);
  const wanted=[...new Set(input.refs)];
  for(const ref of wanted) {
   cards[ref]=null;
   if(/^t-[0-9]{1,9}$/.test(ref)) {
    const answer=tasksRole(o.operations).call(viewer,'show',{id:ref});
    if(!answer.ok)continue;
    const parsed=task.safeParse(answer.value);if(!parsed.success||parsed.data.result.task.id!==ref)continue;
    const t=parsed.data.result.task;
    cards[ref]={kind:'task',title:t.title.slice(0,200),status:t.status==='closed'?(t.closeReason==='cancelled'?'Cancelled':'Done'):t.status==='in_progress'?'In progress':'Open',...(t.status==='closed'?{tone:'ok' as const}:{}),url:`/p/tasks-preview/task/${ref}`};
   } else if(/^cv-[0-9a-f]{12}$/.test(ref)) {
    const t=ownedConversation(o.db,o.sharing(),viewer,ref);
    if(t)cards[ref]={kind:'conversation',title:(t.title??`New thread with ${t.agent}`).slice(0,200),status:t.archived!==null?'Archived':t.working?'Working':'Open',url:`/p/comms-preview/thread/${t.id.slice(3)}`};
   } else {
    const m=forge.exec(ref);if(!m||[m[1],m[2]].some(s=>s==='.'||s==='..'))continue;
    const canonical=ref.toLowerCase();
    const answer=o.operations.call('direct',viewer,'changes.show',{id:canonical});
    if(!answer.ok){
     // Only the owning piece's explicit not-found permits a public GitHub
     // fallback. Denied, unavailable and damaged records stay plain words.
     if(answer.code==='not-found'&&o.operations.has('changes.show'))cards[ref]={kind:'pr',title:ref.slice(7),status:'Not tracked',url:`https://github.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}/issues/${m[3]}`};
     continue;
    }
    const parsed=change.safeParse(answer.value);if(!parsed.success)continue;
    const c=parsed.data;
    if(c.id!==canonical||c.page!==`c/github/${m[1].toLowerCase()}/${m[2].toLowerCase()}/${m[3]}`)continue;
    cards[ref]={kind:'pr',title:c.title.slice(0,200),status:c.status.slice(0,200),...(c.state==='merged'?{tone:'ok' as const}:{}),url:`/p/changes-preview/change/${encodeURIComponent(canonical)}`};
   }
  }
  return {thread:input.thread,cards};
 };
 o.operations.register(operation({name:'comms.refCards',doors:['socket'],windowOnly:true,input:request,output:z.unknown(),may:(v,i)=>!!o.thread(v,i.thread),run:(ctx,i)=>read(ctx.viewer,i)}));
 // Exact, bounded scope: no global enumeration and no retained message reads.
 const scopeOf=(scope:string|undefined)=>{try{if(!scope||scope.length>14000)return;return request.parse(JSON.parse(scope));}catch{return undefined;}};
 o.live.register({name:'comms.refCards',windowOnly:true,ids:scope=>scopeOf(scope)?[scope!]:[],
  read:(id,viewer)=>{const input=scopeOf(id);if(!input)return;const value=read(viewer,input);return value?{id,...value}:undefined;},inScope:(r,scope)=>r.id===scope,
  refreshOn:c=>['task','change','thread','core.access','approval','approval-rule','household.project','household.sharing'].includes(c.type),
 });
}
