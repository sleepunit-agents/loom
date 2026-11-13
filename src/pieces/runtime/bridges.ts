/** Trusted venue handoff. Public bodies only read/reply through their bound job. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, mayUseThread, type Sharing, type Viewer, type Context } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import type { BridgeRuntime, BridgesRole, Incoming } from '../bridges/role.js';
import { runtimeStore } from './store.js';
import { runtimeRole } from './role.js';
import { currentExecution } from './control.js';
import { centralRuntimeCredentials } from './central-credentials.js';
import { provenanceStore } from './provenance-store.js';
export const BRIDGE_BRIEF='Read the bound venue conversation through runtime.readConversation. Reply through runtime.reply.';
const hash=(parts:unknown[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const id=z.string().min(1).max(200);
const input=z.object({id,key:z.object({agent:id,who:id,venue:z.string().min(1).max(1000)}).strict(),person:id,text:z.string().max(100_000),at:z.iso.datetime(),label:z.string().max(200).optional(),address:z.object({channel:id,thread:id.optional(),dm:z.boolean(),group:z.boolean().optional()}).strict(),route:z.object({guest:z.boolean().optional(),pair:id.optional(),peer:z.boolean().optional(),readers:z.array(id).optional()}).passthrough().optional()}).strict();
const receiptContent=(m:z.infer<typeof input>)=>{const {route:_,...receipt}=m;return JSON.stringify(receipt);};
const supportedRoute=(route?:{guest?:boolean;pair?:string;peer?:boolean;readers?:string[]})=>!route?.guest&&route?.pair===undefined&&!route?.peer&&!route?.readers?.length;
const active=new Set(['queued','starting','running','waiting','uncertain','lost']);
interface JobProof {agent:string;job?:string;valid():boolean}
interface Turn {id:string;conversation:string;record:string;seq:number;direction:string}
export function bridgeRuntime(app:Foundation,sharing:()=>Sharing,proof:(v:Viewer)=>JobProof|undefined) {
 const {db,operations}=app,store=runtimeStore(db);
 let sink:BridgesRole|undefined,accepting=false,closed=false;
 const permitted=(agent:string,member:string)=>mayUseThread({kind:'member',id:member},{agent,member},sharing());
 const conversation=(m:Pick<Incoming,'key'>)=>`bridge:${hash([m.key.agent,m.key.who,m.key.venue])}`;
 const dm=(m:Pick<Incoming,'address'|'key'|'person'>)=>m.address.dm&&!m.address.group&&m.key.who===m.person
  && /^(discord|slack):[^:]+:dm:/.test(m.key.venue)&&m.key.venue.endsWith(`:dm:${m.person}`);
 const valid=(jobId:string)=>{
  const job=store.read('job',jobId),b=job?.conversation?store.read('binding',job.conversation):undefined;
  const incoming=job?.conversation?db.prepare("SELECT id FROM runtime_bridge_turns WHERE conversation=? AND direction='in' ORDER BY seq DESC LIMIT 1").get(job.conversation) as {id:string}|undefined:undefined;
  return !!incoming&&!!job?.member&&!!sink?.currentIncoming(incoming.id,job.member)&&!closed&&!!sink&&!!job&&!!b&&b.venue.startsWith('bridge:')&&b.id===job.conversation&&b.job===job.id
   &&b.agent===job.agent&&!!job.member&&b.member===job.member&&permitted(job.agent,job.member)&&currentExecution(store,job,sharing());
 };
 const bound=(v:Viewer)=>{
  const p=proof(v);if(v.kind!=='agent'||!p||!p.valid()||p.agent!==v.id||!p.job||!valid(p.job))return;
  const job=store.read('job',p.job)!;if(job.agent!==v.id||!['running','waiting'].includes(job.state))return;
  return job;
 };
 // This internal handoff owns its permanent receipt below, like runtime.reply.
 // Registry still owns the outer transaction; no registry receipt cache hashes
 // mutable route metadata or retains a fingerprint of private words.
 operations.register(operation({name:'runtime.acceptBridge',doors:['direct'],input,output:z.object({job:id}),
  may:(v,m)=>accepting&&v.kind==='member'&&v.id===m.person&&dm(m)&&supportedRoute(m.route)&&permitted(m.key.agent,m.person),
  run(ctx,m){
   const cv=conversation(m),old=db.prepare('SELECT * FROM runtime_bridge_turns WHERE id=?').get(m.id) as Turn|undefined;
   if(old){if(old.conversation!==cv||receiptContent(JSON.parse(old.record) as z.infer<typeof input>)!==receiptContent(m))throw new OperationError('conflict','Bridge receipt already has different work');return {job:store.read('binding',cv)!.job!};}
   const before=store.read('binding',cv);
   if(before&&(before.agent!==m.key.agent||before.member!==m.person||before.venue!==`bridge:${m.key.venue}`))throw new OperationError('conflict','Bridge binding changed');
   const previous=before?.job?store.read('job',before.job):undefined;
   let job=previous&&active.has(previous.state)?previous.id:undefined;
   store.put('binding',{id:cv,agent:m.key.agent,member:m.person,venue:`bridge:${m.key.venue}`,place:m.key.venue,...(job?{job}:{})},ctx.now);
   if(!job){
    const r=runtimeRole(operations).startBody(ctx.viewer,{agent:m.key.agent,member:m.person,conversation:cv,title:'Venue conversation',brief:BRIDGE_BRIEF,source:{kind:'conversation',id:`bridge:${m.id}`}},`bridge-start:${m.id}`);
    if(!r.ok)throw new OperationError(r.code,r.message);
    job=(r.value as {job:string}).job;
   }
   store.put('binding',{id:cv,agent:m.key.agent,member:m.person,venue:`bridge:${m.key.venue}`,place:m.key.venue,job},ctx.now);
   db.prepare("INSERT INTO runtime_bridge_turns (id,conversation,direction,record) VALUES (?,?,'in',?)").run(m.id,cv,JSON.stringify(m));
   provenanceStore(db).note(cv,m.key.agent,{key:`bridge:${m.id}`,sender:{kind:'person',person:m.person},at:Date.parse(m.at)},Object.entries(sharing().members).filter(([,m])=>m.owner).map(([id])=>id));
   if(['running','waiting'].includes(store.read('job',job)!.state))provenanceStore(db).consumed(cv,[`bridge:${m.id}`]);
   ctx.changed('runtime.binding',cv);return {job};
  },
 }));
 const runtime:BridgeRuntime={
  async admit(m){
   if(closed||!sink)return 'wait';
   // Other venue forms require their own runtime admission contract; no fallback
   // from an unresolved peer/group/guest to a private household conversation.
   if(!m.dm||m.group||m.peer||m.guest||m.pair!==undefined||m.readers.length)return 'wait';
   return permitted(m.agent,m.person)?'allow':'drop';
  },
  async deliver(raw){
   if(closed||!sink)return 'retry';
   const parsed=input.safeParse(raw);if(!parsed.success)return 'held';const m=parsed.data;
   if(!dm(m)||!supportedRoute(m.route))return 'held';if(!permitted(m.key.agent,m.person))return 'refused';
   accepting=true;
   try{const result=operations.call('direct',{kind:'member',id:m.person},'runtime.acceptBridge',m,`bridge-accept:${m.id}`);
    return result.ok?'delivered':result.code==='denied'?'refused':'retry';
   }finally{accepting=false;}
  },
  async stop(m){
   if(closed||!sink||!permitted(m.agent,m.person))throw new Error('Bridge stop unavailable');
   let stopped:string|undefined;
   db.transaction(()=>{
    if(db.prepare('SELECT id FROM runtime_bridge_stops WHERE id=?').get(m.id))return;
    const cv=`bridge:${hash([m.agent,m.person,m.venue])}`,b=store.read('binding',cv),job=b?.job?store.read('job',b.job):undefined;
    if(job&&job.member===m.person&&job.agent===m.agent&&active.has(job.state)){
     stopped=job.id;
     centralRuntimeCredentials.revokeJob(db,{job:job.id,now:operations.clock.now()});
     const {changedAt:_,...before}=job;store.put('job',{...before,state:'stopped',endedAt:operations.clock.now()},operations.clock.now());
    }
    db.prepare('INSERT INTO runtime_bridge_stops VALUES (?)').run(m.id);
   })();
   if(stopped)app.live.changed([{type:'runtime.job',id:stopped},{type:'core.access',id:'credentials'}]);
  },
 };
 return {runtime,connect(role:BridgesRole){sink=role;},valid,bound,
  privateStart(m:{agent:string;member?:string;conversation?:string;brief:string}){
   const b=m.conversation?store.read('binding',m.conversation):undefined;
   return accepting&&m.brief===BRIDGE_BRIEF&&!!m.member&&!!b&&b.agent===m.agent&&b.member===m.member&&b.venue.startsWith('bridge:')&&permitted(m.agent,m.member);
  },
  read(v:Viewer,before?:number){
   const job=bound(v);if(!job)throw new OperationError('denied','Body binding ended');
   const rows=db.prepare('SELECT * FROM runtime_bridge_turns WHERE conversation=? AND seq<? ORDER BY seq DESC LIMIT 100').all(job.conversation,before??Number.MAX_SAFE_INTEGER) as Turn[];
   return {conversation:job.conversation,messages:rows.reverse().map(r=>({seq:r.seq,kind:r.direction==='in'?'message':'reply',...JSON.parse(r.record) as object}))};
  },
  reply(v:Viewer,i:{id:string;text:string},ctx:Pick<Context,'changed'>){
   const job=bound(v);if(!job||!sink)throw new OperationError('denied','Body binding ended');
   const replyId=`bridge-reply:${hash([job.conversation,i.id])}`;
   const previous=db.prepare('SELECT * FROM runtime_bridge_turns WHERE id=?').get(replyId) as Turn|undefined;
   if(previous){const record=JSON.parse(previous.record) as {text:string;job:string};if(record.text!==i.text||record.job!==job.id)throw new OperationError('conflict','Reply id already has different work');return {seq:previous.seq};}
   const incoming=db.prepare("SELECT id FROM runtime_bridge_turns WHERE conversation=? AND direction='in' ORDER BY seq DESC LIMIT 1").get(job.conversation) as {id:string}|undefined;
   if(!incoming)throw new OperationError('conflict','No bridge message');
   sink.reply({id:replyId,incomingId:incoming.id,text:i.text,person:job.member},ctx);
   const row=db.prepare("INSERT INTO runtime_bridge_turns(id,conversation,direction,record) VALUES (?,?,'out',?) RETURNING seq").get(replyId,job.conversation,JSON.stringify({text:i.text,job:job.id})) as {seq:number};
   return {seq:row.seq};
  },close(){closed=true;},
 };
}
export type BridgeBodies=ReturnType<typeof bridgeRuntime>;
