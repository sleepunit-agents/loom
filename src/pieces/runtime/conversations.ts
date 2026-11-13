import { attentionRole } from '../attention/role.js';
import { controlScope, currentExecution } from './control.js';
/** Private words remain in Comms. Runtime persists routing and acceptance only. */
import { z } from 'zod';
import { operation, OperationError, mayUseThread, mayAct, mayMove, type Sharing, type Viewer, type Context } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import type { Comms, RuntimeDelivery, DeliveryReceipt } from '../comms/role.js';
import { runtimeStore } from './store.js';
import { centralRuntimeCredentials } from './central-credentials.js';
export const PRIVATE_BRIEF='Read the bound private conversation through runtime.readConversation. Reply through runtime.reply.';
const id=z.string().min(1).max(200);
const routing=z.object({thread:id,agent:id,member:id,conversation:id,seq:z.number().int().positive(),generation:z.number().int().min(0).max(1000).optional(),project:id.optional()}).strict();
type Routing=z.infer<typeof routing>;
const key=(m:DeliveryReceipt)=>JSON.stringify([m.agent,m.member,m.thread,m.conversation,m.seq,m.generation??0]);
const active=new Set(['queued','starting','running','waiting','uncertain','lost']);
interface Proof {agent:string;job:string;valid():boolean}
export function conversationRuntime(app:Foundation, sharing:()=>Sharing, proof:(viewer:Viewer)=>Proof|undefined) {
 const {db,operations,live}=app,store=runtimeStore(db);
 let comms:Comms|undefined,closed=false,accepting=false;
 const available=(m:Routing)=>{
  if(closed||!comms||!mayUseThread({kind:'member',id:m.member},m,sharing()))return false;
  try {
   const trace=comms.trace(m.agent,m.thread),description=comms.describe(m.agent,m.thread);
   return trace.conversation===m.conversation&&trace.project===m.project&&trace.archived===null&&description.readers.length===1&&description.readers[0]===m.member;
  } catch{return false;}
 };
 const receipt=(m:DeliveryReceipt)=>db.prepare('SELECT job FROM runtime_deliveries WHERE id=?').get(key(m)) as {job:string}|undefined;
 const privateStart=(input:{agent:string;member?:string;conversation?:string;brief:string;project?:string})=>{
  if(!accepting||!input.member||!input.conversation||input.brief!==PRIVATE_BRIEF||!comms)return false;
  const binding=store.read('binding',input.conversation);
  // The direct accept operation installs the routing before calling startBody,
  // in its enclosing transaction; public arguments cannot manufacture it.
  return !!binding&&binding.agent===input.agent&&binding.member===input.member&&binding.project===input.project
   &&available({thread:binding.place,agent:input.agent,member:input.member,conversation:input.conversation,project:input.project,seq:1});
 };
 const bound=(viewer:Viewer)=>{
  const p=proof(viewer);if(!p||!p.valid()||p.agent!==viewer.id)return;
  const job=store.read('job',p.job),binding=job?.conversation?store.read('binding',job.conversation):undefined;
  const box=job?store.read('box',job.box):undefined;
  if(!job||!binding||!job.member||binding.job!==job.id||binding.member!==job.member||binding.agent!==p.agent
   ||!['running','waiting'].includes(job.state)||!box||box.revokedAt!==undefined||!currentExecution(store,job,sharing())
   ||!available({thread:binding.place,agent:p.agent,member:job.member,conversation:binding.id,project:binding.project,seq:1}))return;
  return {job,binding,proof:p};
 };
 const refile=(ctx:Context,m:{thread:string;agent:string;member:string;conversation:string;project?:string})=>{
  const binding=store.read('binding',m.conversation);if(!binding)return;
  if(binding.agent!==m.agent||binding.member!==m.member||binding.place!==m.thread)throw new OperationError('conflict','Conversation binding changed');
  const {changedAt:_,...before}=binding,next={...before,project:m.project};
  if(!mayMove(ctx.viewer,{...before,type:'runtime.binding'},{...next,type:'runtime.binding'},sharing(),'runtime.acceptConversation'))throw new OperationError('denied','Conversation filing unavailable');
  const job=binding.job?store.read('job',binding.job):undefined;
  if(job){
   if(job.agent!==m.agent||job.member!==m.member||job.conversation!==m.conversation)throw new OperationError('conflict','Job binding changed');
   const {changedAt:_,...prior}=job,after={...prior,project:m.project};
   if(!mayMove(ctx.viewer,{...prior,type:'runtime.job'},{...after,type:'runtime.job'},sharing(),'runtime.acceptConversation'))throw new OperationError('denied','Conversation filing unavailable');
   if(store.put('job',after,ctx.now))ctx.changed('runtime.job',job.id);
  }
  if(store.put('binding',next,ctx.now))ctx.changed('runtime.binding',binding.id);
 };
 operations.register(operation({name:'runtime.acceptConversation',doors:['direct'],write:true,input:routing,output:z.object({job:id}),
  may:(v,m)=>v.kind==='member'&&v.id===m.member&&available(m),
  run(ctx,m){
   const old=receipt(m);if(old)return old;
   const before=store.read('binding',m.conversation);
   if(before&&(before.agent!==m.agent||before.member!==m.member||before.place!==m.thread))throw new OperationError('conflict','Conversation binding changed');
   if(before)refile(ctx,m);
   store.put('binding',{id:m.conversation,agent:m.agent,member:m.member,project:m.project,venue:'loom',place:m.thread,...(before?.job?{job:before.job}:{})},ctx.now);
   const previous=before?.job?store.read('job',before.job):undefined;
   let job=previous&&active.has(previous.state)?previous.id:undefined;

   if(!job){
    accepting=true;
    let result:ReturnType<typeof operations.call>;
    try {result=operations.call('direct',ctx.viewer,'runtime.startBody',{agent:m.agent,member:m.member,project:m.project,conversation:m.conversation,
     title:'Private conversation',brief:PRIVATE_BRIEF,source:{kind:'conversation',id:key(m)}},`private-start:${key(m)}`);}finally{accepting=false;}
    if(!result.ok)throw new OperationError(result.code,result.message);
    job=(result.value as {job:string}).job;
   }
   store.put('binding',{id:m.conversation,agent:m.agent,member:m.member,project:m.project,venue:'loom',place:m.thread,job},ctx.now);
   db.prepare('INSERT INTO runtime_deliveries (id,job) VALUES (?,?)').run(key(m),job);
   ctx.changed('runtime.binding',m.conversation);return {job};
  },after(){confirmed();},
 }));
 operations.register(operation({name:'runtime.claimableJobs',doors:['http','direct'],input:z.object({}).strict(),output:z.object({jobs:z.array(id)}),
  may:v=>v.kind==='runner',run(ctx){return {jobs:store.ids('job').filter(id=>{const job=store.read('job',id)!,box=store.read('box',job.box);return box?.revokedAt===undefined&&!!box&&job.state==='queued'&&mayAct(ctx.viewer,controlScope(store,job,sharing()),sharing(),'report-job');})};},
 }));
 operations.register(operation({name:'runtime.readConversation',doors:['http','direct'],input:z.object({before:z.number().int().positive().optional()}).strict(),output:z.unknown(),
  may:v=>!!bound(v),async prepare(i,{viewer}){
   const b=bound(viewer)!;
   return comms!.reader({agent:b.job.agent,conversation:b.binding.id,valid:()=>bound(viewer)?.job.id===b.job.id}).read({thread:b.binding.place,...i});
  },run(ctx,_i,prepared){if(!bound(ctx.viewer))throw new OperationError('denied','Body binding ended');return prepared;},
 }));
 // Comms owns encrypted retry deduplication. This read-style async operation
 // returns only a sequence acknowledgement, never stores words or credentials.
 operations.register(operation({name:'runtime.reply',doors:['http','direct'],input:z.object({id,conversation:id.optional(),job:id.optional(),text:z.string().min(1).max(40_000)}).strict(),output:z.object({seq:z.number()}),
  may:(v,i)=>{const b=bound(v);return !!b&&(!i.job||i.job===b.job.id)&&(!i.conversation||i.conversation===b.binding.id);},async prepare(i,{viewer}){
   const b=bound(viewer)!;
   return comms!.bodyPost({agent:b.job.agent,conversation:b.binding.id,valid:()=>bound(viewer)?.job.id===b.job.id},b.binding.place,{id:i.id,text:i.text,kind:'reply',run:b.job.id});
  },run(ctx,_i,prepared){if(!bound(ctx.viewer))throw new OperationError('denied','Body binding ended');return prepared;},
 }));
 operations.register(operation({name:'runtime.conversationStatus',doors:['http','direct'],input:z.object({state:z.enum(['working','done']).optional()}).strict(),output:z.object({stop:z.boolean(),archived:z.boolean()}),
  may:v=>!!bound(v),run(ctx,i){const b=bound(ctx.viewer)!;const status=comms!.status(b.job.agent,b.binding.place,i.state);
   if(i.state){const report=attentionRole(operations).reportStatus(ctx.viewer,{id:b.job.agent,agent:b.job.agent,state:i.state==='working'?'working':'idle',work:'Private conversation',jobs:[],watched:[]},`body-status:${b.job.id}:${ctx.now}:${i.state}`);if(!report.ok)throw new OperationError(report.code,report.message);}
   return status;},
 }));
 const delivery:RuntimeDelivery={
  async receipt(raw){const m=routing.parse(raw);if(!available(m))return 'unknown';return receipt(m)?'accepted':'not-accepted';},
  async deliver(raw){const {text:_,...m}=raw; routing.parse(m);
   const r=operations.call('direct',{kind:'member',id:m.member},'runtime.acceptConversation',m,`accept:${key(m)}`);
   if(!r.ok)throw new OperationError(r.code,r.message);
  },
  async end(conversation){
   const b=store.read('binding',conversation);if(!b?.job)return;
   const job=store.read('job',b.job);if(!job||!active.has(job.state))return;
   db.transaction(()=>{centralRuntimeCredentials.revokeJob(db,{job:job.id,now:operations.clock.now()});const {changedAt:_,...before}=job;store.put('job',{...before,state:'stopped',endedAt:operations.clock.now()},operations.clock.now());})();
   live.changed([{type:'runtime.job',id:job.id},{type:'core.access',id:'credentials'}]);
  },
 };
 const confirmed=()=>{
  if(closed||!comms)return;
  const rows=db.prepare('SELECT id,job FROM runtime_deliveries').all() as {id:string;job:string}[];
  for(const row of rows){const job=store.read('job',row.job);if(!job||!['running','waiting'].includes(job.state)||!controlScope(store,job,sharing()).privateControl)continue;
   const [agent,member,thread,conversation,seq,generation]=JSON.parse(row.id) as [string,string,string,string,number,number];
   if(available({agent,member,thread,conversation,seq,generation,project:job.project}))comms.confirmStart(agent,thread,seq,generation);
  }
 };
 let reconciling=false;
 const unobserve=live.observe(changes=>{
  if(closed)return;
  if(changes.some(c=>c.type==='runtime.job'))confirmed();
  if(!reconciling&&changes.some(c=>c.type==='core.effect')){
   reconciling=true;void Promise.resolve().then(()=>Promise.all([comms?.reconcileDeliveries(),comms?.reconcileEnds()])).finally(()=>{reconciling=false;});
  }
 });
 return {delivery,privateStart,refile,connect(role:Comms){comms=role;confirmed();void comms.reconcileDeliveries();},
  validInput(jobId:string){const job=store.read('job',jobId),b=job?.conversation?store.read('binding',job.conversation):undefined;return !!job&&!!b&&b.job===job.id&&b.member===job.member&&!!job.member&&available({thread:b.place,agent:job.agent,member:job.member,conversation:b.id,project:b.project,seq:1});},
  close(){closed=true;unobserve();},
 };
}
