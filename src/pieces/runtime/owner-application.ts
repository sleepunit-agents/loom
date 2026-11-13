/** Owning requests and owner answers share the foundation transaction. The
 * application-only operation is guarded by a closure, never body-supplied card
 * fields. No host IO or dispatch occurs before commit.
 */
import { z } from 'zod';
import { operation, OperationError, mayAct, type Db, type Operations, type Sharing } from '../../core/index.js';
import { approvalsRole, owningApprovalCards, type Approval, type ApprovalApplication } from '../approvals/role.js';
import { runtimeStore } from './store.js';
import { provenanceStore } from './provenance-store.js';
import { principalFromHistory, resetEligible, resetProvenance } from './provenance.js';
import type { RuntimeCredentials } from './credentials.js';
const id=z.string().min(1).max(200);
const live=new Set(['queued','starting','running','waiting','lost','uncertain']);
const silence=10*60_000;
interface WriteoffRequest {kind:'box-write-off';target:string;agent:string;box:string;seen:number;jobs:{id:string;heard?:number}[];card:Approval;applied?:{by:string;at:number}}
const installed=new WeakMap<Operations,ApprovalApplication>();
export function runtimeOwnerApplication(operations:Operations):ApprovalApplication {return {apply(a,by){return installed.get(operations)?.apply(a,by)??{ok:false,code:'unavailable',message:'Runtime owning applications are not installed'};}};}
interface ResetRequest {kind:'principal-reset';target:string;agent:string;conversation:string;shown:{key:string;words:string}[];card:Approval;applied?:{by:string;at:number}}
type OwnerRequest=WriteoffRequest|ResetRequest;
export function installRuntimeOwnerApplication(db:Db, operations:Operations, sharing:()=>Sharing, credentials?:RuntimeCredentials):ApprovalApplication {
 const store=runtimeStore(db),approvals=approvalsRole(operations,'approvals');
 let applying:Readonly<Approval>|undefined;
 const read=(target:string):OwnerRequest|undefined=>{
  const row=db.prepare('SELECT record FROM runtime_owner_requests WHERE target=?').get(target) as {record:string}|undefined;
  return row?JSON.parse(row.record) as OwnerRequest:undefined;
 };
 const put=(request:OwnerRequest)=>db.prepare('INSERT INTO runtime_owner_requests VALUES (?,?) ON CONFLICT(target) DO UPDATE SET record=excluded.record').run(request.target,JSON.stringify(request));
 const heard=(job:string)=>(db.prepare('SELECT heard_at FROM runtime_job_heartbeats WHERE job=?').get(job) as {heard_at:number}|undefined)?.heard_at;
 const owner=(v:Parameters<typeof mayAct>[0])=>mayAct(v,{type:'runtime.box'},sharing(),'household');
 const revoke=(job:string,now:number)=>{
  if(!credentials)throw new OperationError('unavailable','Central credential revocation is not installed');
  const result=credentials.revokeJob(db,{job,now});
  if((result as unknown) instanceof Promise){(result as unknown as Promise<unknown>).catch(()=>{});throw new OperationError('unavailable','Credential revocation must be synchronous');}
 };
 const boxReady=(box:string,now:number)=>{
  const b=store.read('box',box);
  if(!b||b.local||b.revokedAt!==undefined||b.reportOnly||b.lastSeen===undefined||now-b.lastSeen<silence)throw new OperationError('conflict','This remote box has not been silent for ten minutes');
  return b;
 };
 const owners=()=>Object.entries(sharing().members).filter(([,v])=>v.owner).map(([id])=>id);
 const resetReady=(agent:string,conversation:string)=>{
  const b=store.read('binding',conversation),p=provenanceStore(db).read(conversation),access=sharing();
  const assigned=Object.entries(access.members).filter(([,m])=>m.agents.includes(agent)).map(([id])=>id),household=owners();
  if(!b||b.agent!==agent||b.member!==undefined||!p||p.agent!==agent||!household.length||(assigned.length>0&&(assigned.length!==household.length||assigned.some(id=>!household.includes(id))))||principalFromHistory(p.history,owners()).people.length)
   throw new OperationError('conflict','This conversation is not solely household-owned work');
  return {binding:b,provenance:p};
 };
 operations.register(operation({name:'runtime.askPrincipalReset',write:true,input:z.object({agent:id,conversation:z.string().regex(/^cv-[0-9a-f]{12}$/)}).strict(),output:z.object({approval:id}),
  may:owner,run(ctx,input){
   const ready=resetReady(input.agent,input.conversation),target=`${input.agent}:${input.conversation}`;
   const prior=read(target);if(prior&&!prior.applied)return {approval:prior.card.id};
   if(principalFromHistory(ready.provenance.history,owners()).for==='owner')throw new OperationError('conflict','The conversation already counts as owner work');
   if(owningApprovalCards(db,'principal-reset',target,input.agent).some(c=>c.state!=='used'))throw new OperationError('conflict','An existing card has no matching runtime snapshot');
   const shown:{key:string;words:string}[]=[];let used=0;
   for(const row of ready.provenance.queue){
    if(!resetEligible(row))continue;
    const words=`${row.sender.kind==='schedule'?'An unassigned wake':row.sender.kind==='agent'?'A relay':'An unnamed sender'} (received ${new Date(row.at).toISOString()})`;
    if(shown.length>=12||used+words.length+2>650)break;
    shown.push({key:row.key,words});used+=words.length+2;
   }
   const details=`Conversation ${input.conversation}. No other person is named in it. Waiting and counted as yours if allowed: ${shown.length?shown.map(r=>r.words).join('; '):'nothing'}. Later arrivals are noted normally.`;
   const r=approvals.call('request',{who:{agent:input.agent,where:"loom's runtime (runtime)"},for:'owner'},{kind:'principal-reset',target,ask:'Count this conversation as your work from now on?',why:'Loom cannot say that the conversation is yours.',if_yes:'The listed waiting work counts as yours and the previous body and session end.',if_no:'Nothing changes.',details},`runtime-reset:${target}:${ctx.receipt!.id}`);
   if(!r.ok)throw new OperationError(r.code,r.message);
   const card=r.value as Approval;
   if(card.kind!=='principal-reset'||card.target!==target||card.details!==details||card.state!=='pending'||card.for!=='owner'||card.who.agent!==input.agent)throw new OperationError('conflict','The original card does not match this request');
   put({kind:'principal-reset',target,agent:input.agent,conversation:input.conversation,shown,card});return {approval:card.id};
  },
 }));
 operations.register(operation({name:'runtime.askWriteOff',write:true,input:z.object({agent:id,box:id}).strict(),output:z.object({approval:id}),
  may:owner,run(ctx,input){
   const b=boxReady(input.box,ctx.now);
   const target=`${input.agent}:${input.box}@${Math.floor(b.lastSeen!/1000)}`;
   const prior=read(target);if(prior)return {approval:prior.card.id};
   const jobs=store.ids('job').flatMap(id=>{const j=store.read('job',id)!;return j.agent===input.agent&&j.box===b.id&&j.runner===b.id&&j.member===undefined&&j.service===undefined&&live.has(j.state)&&j.endedAt===undefined?[{id,heard:heard(id)}]:[];});
   if(!jobs.length)throw new OperationError('conflict','No live nonprivate work on this box');
   if(jobs.some(j=>j.heard!==undefined&&ctx.now-j.heard<silence))throw new OperationError('conflict','A covered body has spoken recently');
   // A request made through some other service is not this owning snapshot.
   // Check BEFORE request(), which may enrich a legacy pending card.
   if(owningApprovalCards(db,'box-write-off',target,input.agent).length)throw new OperationError('conflict','An existing card has no matching runtime snapshot');
   const heading=`Box ${b.id}, last heard ${new Date(b.lastSeen!).toISOString()}. Covered work: all ${jobs.length} live nonprivate, nonservice jobs for ${input.agent} on this box when this card was filed. Later jobs are excluded.`;
   const listing=` Job ids: ${jobs.map(j=>j.id).join(', ')}.`;
   const details=heading+(heading.length+listing.length<=1000?listing:'');
   const r=approvals.call('request',{who:{agent:input.agent,where:"loom's runtime (runtime)"},for:'owner'}, {kind:'box-write-off',target,ask:'Write off this silent box’s covered work?',why:'The box stopped reporting and its covered work cannot be confirmed.',if_yes:'The listed work ends without history and its body credentials stop working.',if_no:'Nothing changes.',details},`runtime-writeoff:${target}`);
   if(!r.ok)throw new OperationError(r.code,r.message);
   const card=r.value as Approval;
   if(card.kind!=='box-write-off'||card.target!==target||card.details!==details||card.state!=='pending'||card.for!=='owner'||card.who.agent!==input.agent)throw new OperationError('conflict','The original card does not match this request');
   put({kind:'box-write-off',target,agent:input.agent,box:b.id,seen:b.lastSeen!,jobs,card});return {approval:card.id};
  },
 }));
 operations.register(operation({name:'runtime.applyOwnerAnswer',doors:['direct'],write:true,recheckPolicy:true,input:z.object({target:id,approval:id}).strict(),output:z.object({applied:z.literal(true)}),
  may:(v,i)=>owner(v)&&applying?.id===i.approval&&applying.target===i.target&&applying.by===v.id,
  run(ctx,i){
   const request=read(i.target),a=applying!;
   if(!request||request.applied||request.card.id!==a.id||request.card.kind!==a.kind||a.state!=='allowed')throw new OperationError('conflict','This card has no current owning request');
   const original=owningApprovalCards(db,a.kind,a.target,request.agent).find(c=>c.id===a.id);
   if(JSON.stringify(original)!==JSON.stringify(request.card))throw new OperationError('conflict','The original card changed');
   // Approvals changes exactly its answer fields in memory before invoking us.
   const {state:_state,by:_by,decided:_decided,expires:_expires,...answered}=a;
   const {state:_oldState,by:_oldBy,decided:_oldDecided,expires:_oldExpires,...asked}=request.card;
   if(JSON.stringify(answered)!==JSON.stringify(asked))throw new OperationError('conflict','Answer differs from the original owning card');
   if(request.kind==='principal-reset'){
    const {binding,provenance}=resetReady(request.agent,request.conversation);
    if(!credentials)throw new OperationError('unavailable','Central credential revocation is not installed');
    // Every job that could hold this conversation's prior transcript is fenced,
    // including a terminal job whose credential might still exist.
    for(const jobId of store.ids('job')){
     const job=store.read('job',jobId)!;
     if(job.agent!==request.agent||job.conversation!==request.conversation)continue;
     if(job.member!==undefined)throw new OperationError('conflict','Private membership cannot be reset');
     revoke(job.id,ctx.now);
     if(live.has(job.state)&&job.endedAt===undefined){const {changedAt:_,...prior}=job;store.put('job',{...prior,state:'stopped',endedAt:ctx.now,principalReset:{approval:a.id,by:ctx.viewer.id,at:ctx.now}},ctx.now);ctx.changed('runtime.job',job.id);}
    }
    const {changedAt:_,home:_home,job:_job,...clean}=binding;
    store.put('binding',clean,ctx.now);ctx.changed('runtime.binding',binding.id);ctx.changed('core.access','credentials');
    provenanceStore(db).put(request.conversation,{...provenance,history:resetProvenance(provenance.queue,request.shown.map(r=>r.key),owners()),reset:{by:ctx.viewer.id,at:ctx.now,approval:a.id}});
    put({...request,applied:{by:ctx.viewer.id,at:ctx.now}});return {applied:true as const};
   }
   const b=boxReady(request.box,ctx.now);
   if(b.lastSeen!==request.seen)throw new OperationError('conflict','The box spoke since this request');
   const jobs=request.jobs.map(snapshot=>{
    const j=store.read('job',snapshot.id);
    if(!j||j.agent!==request.agent||j.box!==request.box||j.runner!==request.box||j.member!==undefined||j.service!==undefined||!live.has(j.state)||j.endedAt!==undefined||heard(j.id)!==snapshot.heard)throw new OperationError('conflict','Covered work changed or a body spoke');
    return j;
   });
   if(!credentials)throw new OperationError('unavailable','Central credential revocation is not installed');
   for(const {changedAt:_,...j} of jobs){
    revoke(j.id,ctx.now);
    store.put('job',{...j,state:'lost',endedAt:ctx.now,writtenOff:{approval:a.id,by:ctx.viewer.id,at:ctx.now}},ctx.now);ctx.changed('runtime.job',j.id);
   }
   ctx.changed('core.access','credentials');put({...request,applied:{by:ctx.viewer.id,at:ctx.now}});return {applied:true as const};
  },
 }));
 const application:ApprovalApplication={apply(a,by){
  if(!db.inTransaction||applying||!['box-write-off','principal-reset'].includes(a.kind)||a.state!=='allowed'||a.by!==by)return {ok:false,code:'unavailable',message:'Expected an owning runtime answer in the approval transaction'};
  applying=a;
  try{return operations.call('direct',{kind:'member',id:by},'runtime.applyOwnerAnswer',{target:a.target,approval:a.id},`runtime-apply:${a.id}`);}finally{applying=undefined;}
 }};
 installed.set(operations,application);return application;
}
