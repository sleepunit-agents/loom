/** Trusted one-attempt handoff engine. External doors bind a real body/worker;
 * installed code needs no service grant. Values are never receipts or records. */
import {secretUseId} from './use-id.js';
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {Clock} from '../../core/clock.js';
import type {DataDatabase} from '../../core/data/database.js';
import {jobs,secretUses,secretWriteJournal,agentHouseSecrets,secretRequests} from '../../core/data/schema.js';
import type {SecretValueSource} from './role.js';
import {SecretRequests,startupRequestId} from './requests.js';
import {secretName,isHouseSecretAlias} from './input.js';
export class PrivateInputError extends Error {
 constructor(readonly code:'denied'|'conflict'|'unavailable'){super('Private secret input unavailable');}
}
/** One hand-off. `standing` is asked each time the grant is checked: may a standing answer serve this
 * job's work now (policy.ts, standingSecretAnswerServes)? The door says. `request` is the request whose
 * grant this hand-off rests on, for the two that have their own (a startup alias, the repository);
 * without it any grant a body may use counts (SecretRequests.grantFor). */
export interface SecretHandOff {job:string;secret:string;attempt:string;request?:string;standing():boolean}
const failed=(code:'denied'|'conflict'|'unavailable'='unavailable')=>new PrivateInputError(code);
export class SecretPrivateInputs {
 private closed=false;
 private readonly active=new Set<Promise<unknown>>();
 private readonly bytes=new Set<Uint8Array>();
 private readonly delivered=new Map<string,number>();
 private closing?:Promise<void>;
 readonly requests:SecretRequests;
 constructor(private db:DataDatabase,private clock:Clock,private source:SecretValueSource|undefined,
  private commit:<T>(write:()=>T)=>T){this.requests=new SecretRequests(db,()=>new Date(clock.now()).toISOString());}
 /** The worker's grant to fetch the house's repository with this secret, asking for it when it has not been asked. */
 repositoryGrant(job:string,secret:string){if(this.closed)throw failed();return this.commit(()=>this.requests.grantAtStart(job,[secret],true,'repository'));}
 /** `standing`: may a standing answer serve this job's work (policy.ts, standingSecretAnswerServes)? The door says. */
 startup(job:string,standing:boolean):{aliases:{alias:string}[];pending?:true}{
  if(this.closed)throw failed();
  return this.commit(()=>{
   const target=this.db.select().from(jobs).where(eq(jobs.id,job)).get();if(!target)throw failed('denied');
   // An alias stored before the door held it to the one rule (input.ts, isHouseSecretAlias) is left out:
   // the body refuses its whole batch for one name it cannot take, and that would fail every job of the agent.
   const stored=this.db.select().from(agentHouseSecrets).where(eq(agentHouseSecrets.agent,target.agent)).all();
   if(stored.length>128)throw failed();
   const configured=stored.filter(row=>isHouseSecretAlias(row.alias));
   const allowed=new Set(this.requests.grantAtStart(job,configured.map(row=>row.secret),standing).map(grant=>grant.secret));
   const pending=configured.some(row=>this.db.select({state:secretRequests.state}).from(secretRequests).where(eq(secretRequests.id,startupRequestId(job,row.secret))).get()?.state==='pending');
   return {aliases:configured.filter(row=>allowed.has(row.secret)).map(({alias})=>({alias})),...(pending?{pending:true as const}:{})};
  });
 }
 dispatch<T>(input:SecretHandOff,current:()=>boolean,capture:(id:string,bytes:Uint8Array)=>T):Promise<T>{
  if(this.closed||this.active.size>=1024||this.db.$client.inTransaction)return Promise.reject(failed());
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const work=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});this.active.add(work);void work.finally(()=>this.active.delete(work)).catch(()=>{});
  void this.perform(input,current,capture).then(resolve,reject);return work;
 }
 private async perform<T>(input:SecretHandOff,current:()=>boolean,capture:(id:string,bytes:Uint8Array)=>T):Promise<T>{
  secretName.parse(input.secret);z.string().min(1).max(300).parse(input.attempt);
  if(!this.source||!this.available(current))throw failed();
  for(const [key,until] of this.delivered)if(until<=this.clock.now())this.delivered.delete(key);
  if(this.delivered.size>=4096)throw failed();
  const target=this.db.select().from(jobs).where(eq(jobs.id,input.job)).get();if(!target)throw failed('denied');
  const id=secretUseId(target.agent,target.id,input.attempt);
  const permitted=()=>this.available(current)&&this.db.select({agent:jobs.agent}).from(jobs).where(eq(jobs.id,target.id)).get()?.agent===target.agent&&!!this.requests.grantFor(input.secret,target.agent,target.id,input.request,input.standing())
   &&!this.db.select({id:secretWriteJournal.id}).from(secretWriteJournal).where(and(eq(secretWriteJournal.secret,input.secret),eq(secretWriteJournal.state,'prepared'))).get();
  this.commit(()=>{
   if(!permitted())throw failed('denied');
   if(this.db.select().from(secretUses).where(eq(secretUses.id,id)).get())throw failed('conflict');
   this.db.insert(secretUses).values({id,secret:input.secret,agent:target.agent,job:target.id,at:new Date(this.clock.now()).toISOString(),state:'started'}).run();
  });
  let owned:Uint8Array|undefined,expired=false,cancel!:()=>void;
  const deadlineAt=this.clock.now()+5000;
  const deadline=new Promise<never>((_resolve,reject)=>{cancel=this.clock.at(deadlineAt,()=>{expired=true;reject(failed());});});
  const read=Promise.resolve().then(()=>{if(!permitted())throw failed('denied');return this.source!.read(input.secret);}).then(value=>{
   if(!(value instanceof Uint8Array))throw failed();
   if(expired||this.closed){value.fill(0);throw failed();}owned=value;this.bytes.add(value);return value;
  });
  try{
   const value=await Promise.race([read,deadline]);
   if(this.clock.now()>=deadlineAt||!permitted()||value.byteLength<1||value.byteLength>65536)throw failed('denied');
   // capture is synchronous and private: Response copies bytes before this
   // borrowed buffer is erased. No common operation result carries a value.
   const result=capture(id,value);if(result&&typeof (result as {then?:unknown}).then==='function')throw failed();
   if(!this.available(current))throw failed('denied');
   for(const [key,until] of this.delivered)if(until<=this.clock.now())this.delivered.delete(key);
   this.delivered.set(id,this.clock.now()+300000);return result;
  }catch{
   // Failure means no completed recipient acknowledgement, never proof that
   // no bytes escaped. Started/failed/released IDs never dispatch again.
   this.commit(()=>this.db.update(secretUses).set({state:'failed'}).where(and(eq(secretUses.id,id),eq(secretUses.state,'started'))).run());
   throw failed();
  }finally{expired=true;cancel();if(owned){owned.fill(0);this.bytes.delete(owned);}}
 }
 confirm(job:string,id:string,current:()=>boolean){
  if(!this.available(current))throw failed('denied');
  return this.commit(()=>{
   const row=this.db.select().from(secretUses).where(and(eq(secretUses.id,id),eq(secretUses.job,job))).get();
   if(!row||this.db.select({agent:jobs.agent}).from(jobs).where(eq(jobs.id,job)).get()?.agent!==row.agent)throw failed('denied');if(row.state==='released')return;
   if(row.state!=='started'||(this.delivered.get(id)??0)<=this.clock.now())throw failed('conflict');
   this.db.update(secretUses).set({state:'released'}).where(eq(secretUses.id,id)).run();this.delivered.delete(id);
  });
 }
 private available(current:()=>boolean){if(this.closed)return false;try{return current()===true;}catch{return false;}}
 close(){if(this.closing)return this.closing;this.closed=true;this.delivered.clear();for(const bytes of this.bytes)bytes.fill(0);return this.closing=Promise.allSettled([...this.active]).then(()=>{});}
}
