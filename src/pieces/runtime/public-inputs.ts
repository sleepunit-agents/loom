import {continuePublic} from './public-continuation.js';
/** Public words stay in Runtime's owning inbox, outside live records/receipts. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {operation,OperationError,mayAct,mayCreate,type Context,type Sharing,type Viewer} from '../../core/index.js';
import type {Foundation} from '../../core/app.js';
import type {OutsideEffects} from '../../core/effects.js';
import {registerConversationAnswers,attentionConversationId,type Ask} from '../attention/role.js';
import type {RuntimeRecords} from './records.js';
import {runtimeDestination} from './destination.js';
import {provenanceStore} from './provenance-store.js';
import {hearJob} from './heartbeat.js';
import {recordPublicIncoming} from './public-incoming.js';
type Job=RuntimeRecords['job'];
interface Input {seq:number;id:string;conversation:string;job:string;record:string;destination:string;released:number|null;consumed:number|null}
interface Question {id:string;conversation:string;job:string;destination:string;question:string}
function fail(message:string):never {throw new OperationError('denied',message);}
const questionShape=(ask:Ask)=>{
 const {state:_,changedAt:__,answer:___,resolution:____,...question}=ask;
 return JSON.stringify(question);
};
export function installPublicInputs(app:Foundation,sharing:()=>Sharing,effects:OutsideEffects,
 bound:(v:Viewer)=>Job|undefined,current:(job:string,terminal?:boolean)=>Job|undefined,brief:string){
 const {db,operations}=app;
 const destination=(job:Job)=>runtimeDestination(db,job);
 const canonical=(job:Job)=>attentionConversationId(job.agent,'runtime-clock',job.conversation!);
 const checkTransaction=(ctx:Context)=>{if(ctx.db!==db||!db.inTransaction)fail('Public input requires its owning transaction');};
 const conversation=(ctx:Context,job:Job)=>{
  checkTransaction(ctx);
  const id=canonical(job),old=db.prepare('SELECT conversation,job FROM runtime_public_conversations WHERE id=?').get(id) as {conversation:string;job:string}|undefined;
  if(old&&(old.conversation!==job.conversation||old.job!==job.id))fail('Public conversation owner changed');
  db.prepare('INSERT OR IGNORE INTO runtime_public_conversations VALUES (?,?,?)').run(id,job.conversation,job.id);
 };
 const question=(ctx:Context,job:Job,value:unknown)=>{
  checkTransaction(ctx);conversation(ctx,job);
  const digest=value as {ask:string|null;needs_owner:Record<string,unknown>|null};
  if(!digest.ask)return;
  // The actual Attention result owns normalized wording and scope. Do not read
  // another piece's tables or accept a caller's source/permission declaration.
  const result=operations.call('direct',ctx.viewer,'attention.get',{id:digest.ask});
  if(!result.ok)throw new OperationError(result.code,result.message);
  const ask=result.value as Ask;
  if(ask.source.kind!=='conversation'||ask.source.id!==canonical(job)||ask.agent!==job.agent
   ||ask.project!==job.project||ask.member!==undefined||ask.privateQuestion||ask.sourceManaged||ask.waits_on)fail('Public question owner unavailable');
  db.prepare('INSERT INTO runtime_public_questions VALUES (?,?,?,?,?)').run(ask.id,job.conversation,job.id,destination(job),questionShape(ask));
 };
 registerConversationAnswers(operations,(ctx,ask)=>{
  const owner=db.prepare('SELECT conversation,job FROM runtime_public_conversations WHERE id=?').get(ask.source.id) as {conversation:string;job:string}|undefined;
  if(!owner)return false; // Other conversation owners retain their own answer paths.
  checkTransaction(ctx);
  const q=db.prepare('SELECT * FROM runtime_public_questions WHERE id=?').get(ask.id) as Question|undefined;
  if(!q||q.conversation!==owner.conversation||q.job!==owner.job||q.question!==questionShape(ask))fail('Public question has no owning destination');
  let job=current(q.job,true);
  if(!job||destination(job)!==q.destination||job.agent!==ask.agent||job.project!==ask.project)fail('Original public answer destination ended');
  if(ctx.viewer.kind!=='member'||ask.answer?.by.kind!=='member'||ask.answer.by.id!==ctx.viewer.id)fail('Public answer sender unavailable');
  const answer=ask.answer!;
  // Done/dismiss acknowledge the ask without assigning work or sending words.
  if(answer.kind==='done'||answer.kind==='dismiss')return true;
  if(!mayAct(ctx.viewer,{type:'runtime.job',agent:job.agent,project:job.project},sharing(),'give-work'))fail('Public answer sender cannot give this work');
  let text:string;
  if(answer.kind==='words')text=answer.text;
  else if(answer.kind==='yes'||answer.kind==='no')text=`${answer.kind==='yes'?'Yes':'No'}, to: ${ask.ask}${(answer.kind==='yes'?ask.if_yes:ask.if_no)?`\n${answer.kind==='yes'?ask.if_yes:ask.if_no}`:''}`;
  else fail('Unsupported public answer');
  if(text!.length>40_000)throw new OperationError('invalid','Public answer exceeds 40000 characters');
  if(job.endedAt!==undefined){
   if(!mayCreate(ctx.viewer,{type:'runtime.job',agent:job.agent,project:job.project},sharing(),'runtime.queueBody'))fail('Public continuation creation denied');
   job=continuePublic(ctx,sharing(),job,ask.id,brief);
  }else if(!current(job.id))fail('Original public answer destination ended');
  const id=`public-answer:${ask.id}`;
  const record={id,kind:'message',text:text!,from:{kind:'person',slug:ctx.viewer.id},agent:job.agent,
   ...(job.project?{project:job.project}:{}),at:new Date(ctx.now).toISOString(),question:ask.id,
   ...(job.id!==q.job?{origin:{job:q.job,conversation:q.conversation,question:JSON.parse(q.question)}}:{})};
  db.prepare('INSERT INTO runtime_public_inputs(id,conversation,job,record,destination) VALUES (?,?,?,?,?)').run(id,job.conversation,job.id,JSON.stringify(record),destination(job));
  provenanceStore(db).note(job.conversation!,job.agent,{key:id,sender:{kind:'person',person:ctx.viewer.id},at:ctx.now},Object.entries(sharing().members).filter(([,m])=>m.owner).map(([id])=>id));
  ctx.changed('runtime.job',job.id);return true;
 });
 const prepared=new WeakMap<object,{job:string;destination:string;rows:Input[]}>();
 operations.register(operation({name:'runtime.readPublicInputs',doors:['http','direct'],input:z.object({}).strict(),output:z.unknown(),
  may:v=>!!bound(v),async prepare(_i,{viewer}){
   const job=bound(viewer);if(!job)fail('Public body binding ended');
   const original=destination(job!),rows=db.prepare('SELECT * FROM runtime_public_inputs WHERE job=? AND consumed IS NULL ORDER BY seq LIMIT 100').all(job!.id) as Input[];
   if(rows.some(row=>row.destination!==original||row.conversation!==job!.conversation))fail('Original public input destination ended');
   const effect=`runtime:public-read:${job!.id}:${rows.at(-1)?.seq}`;
   if(rows.some(r=>r.released===null)&&!effects.beforeOutside({id:effect,kind:'body-start',title:'Release public conversation input'}))throw new OperationError('conflict','Public input is held');
   const now=bound(viewer);if(!now||destination(now)!==original)fail('Original public body binding ended');
   db.transaction(()=>{for(const row of rows)db.prepare('UPDATE runtime_public_inputs SET released=COALESCE(released,?) WHERE id=?').run(operations.clock.now(),row.id);})();
   if(rows.some(r=>r.released===null))effects.finish(effect);
   const marker={};prepared.set(marker,{job:job!.id,destination:original,rows});return marker;
  },run(ctx,_i,value){
   const snapshot=value&&typeof value==='object'?prepared.get(value):undefined,job=bound(ctx.viewer);
   if(!snapshot||!job||job.id!==snapshot.job||destination(job)!==snapshot.destination)fail('Original public body binding ended');
   const rows=snapshot!.rows;
   if(rows.some(row=>{const now=db.prepare('SELECT * FROM runtime_public_inputs WHERE id=?').get(row.id) as Input|undefined;return !now||now.record!==row.record||now.destination!==row.destination||now.job!==row.job||now.conversation!==row.conversation||now.consumed!==null;}))fail('Public input changed');
   hearJob(db,job!.id,ctx.now);
   return {conversation:job!.conversation,messages:rows.map(row=>({seq:row.seq,...JSON.parse(row.record)}))};
  },
 }));
 const inputHash=(input:string,{actor}:{actor:Viewer})=>createHash('sha256').update(JSON.stringify([input,bound(actor)&&destination(bound(actor)!)])).digest('hex');
 operations.register(operation({name:'runtime.acknowledgePublicInputs',doors:['http','direct'],write:true,recheckPolicy:true,inputHash,
  input:z.object({through:z.number().int().positive()}).strict(),output:z.object({job:z.string(),acknowledged:z.literal(true)}),may:v=>!!bound(v),
  run(ctx,i){const job=bound(ctx.viewer)!;
   const rows=db.prepare('SELECT * FROM runtime_public_inputs WHERE job=? AND seq<=?').all(job.id,i.through) as Input[];
   if(!rows.some(r=>r.seq===i.through)||rows.some(r=>r.released===null||r.destination!==destination(job)||r.conversation!==job.conversation))throw new OperationError('conflict','Public input has not been released to this destination');
   for(const row of rows){
    if(row.consumed===null){
     const record=JSON.parse(row.record) as {from:{kind:'person';slug:string}};
     recordPublicIncoming(app,ctx,job,{id:row.id,kind:'message',from:record.from});
    }
    db.prepare('UPDATE runtime_public_inputs SET consumed=COALESCE(consumed,?) WHERE id=?').run(ctx.now,row.id);
   }
   provenanceStore(db).consumed(job.conversation!,rows.map(row=>row.id));
   hearJob(db,job.id,ctx.now);ctx.changed('runtime.job',job.id);return {job:job.id,acknowledged:true as const};
  },
 }));
 return {conversation,question};
}
export type PublicInputs=ReturnType<typeof installPublicInputs>;
