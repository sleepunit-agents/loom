import {createHash} from 'node:crypto';
/** Runtime-owned generations; identifiers and snapshots are never capabilities. */
import {OperationError,type Context,type Sharing,type Db} from '../../core/index.js';
import {runtimeStore} from './store.js';
import {runtimeDestination} from './destination.js';
import {enqueueBody} from './queue.js';
import {provenanceStore} from './provenance-store.js';
import type {RuntimeRecords} from './records.js';
export interface PublicContinuation {job:string;original_job:string;question:string;original_destination:string;destination:string}
export const PUBLIC_GENERATIONS=100;
/** Includes the current job and root; malformed or exhausted chains are held. */
export function publicAncestors(db:Db,job:string):string[]|undefined {
 const ids:string[]=[];
 while(ids.length<PUBLIC_GENERATIONS&&!ids.includes(job)){
  ids.push(job);
  const link=db.prepare('SELECT original_job FROM runtime_public_continuations WHERE job=?').get(job) as {original_job:string}|undefined;
  if(!link)return ids;
  job=link.original_job;
 }
}
export function continuePublic(ctx:Context,sharing:Sharing,original:RuntimeRecords['job'],question:string,brief:string){
 const store=runtimeStore(ctx.db),key=createHash('sha256').update(question).digest('hex').slice(0,40),job=`public-job-${key}`,conversation=`public-${key}`;
 if(!original.conversation||!['done','failed'].includes(original.state)||original.endedAt===undefined)
  throw new OperationError('denied','Original public body has no terminal continuation');
 if(store.read('job',job)||store.read('binding',conversation))throw new OperationError('conflict','Public continuation already exists');
 const ancestors=publicAncestors(ctx.db,original.id);
 if(!ancestors||ancestors.length>=PUBLIC_GENERATIONS)throw new OperationError('conflict','Public continuation generation limit reached');
 const provenance=provenanceStore(ctx.db),before=provenance.read(original.conversation);
 if(!before||before.agent!==original.agent)throw new OperationError('denied','Original public provenance ended');
 store.put('binding',{id:conversation,agent:original.agent,project:original.project,venue:'wake',place:`inbox:${question}`,job},ctx.now);
 enqueueBody(ctx,sharing,{id:job,agent:original.agent,project:original.project,title:'Inbox answer',conversation,model:original.model,account:original.account},{brief});
 provenance.put(conversation,{agent:before.agent,history:before.history,queue:[]});
 const successor=store.read('job',job)!;
 ctx.db.prepare('INSERT INTO runtime_public_continuations VALUES (?,?,?,?,?)').run(job,original.id,question,runtimeDestination(ctx.db,original),runtimeDestination(ctx.db,successor));
 ctx.changed('runtime.binding',conversation);
 return successor;
}
/** The caller owns the claim transaction. Refuse drift before installing it. */
export function pinPublicClaim(ctx:Context,before:RuntimeRecords['job'],after:RuntimeRecords['job']){
 const row=ctx.db.prepare('SELECT * FROM runtime_public_continuations WHERE job=?').get(before.id) as PublicContinuation|undefined;
 if(!row)return;
 if(before.state!=='queued'||before.claimedAt!==undefined||row.destination!==runtimeDestination(ctx.db,before))
  throw new OperationError('denied','Original public continuation destination ended');
 const destination=runtimeDestination(ctx.db,after);
 ctx.db.prepare('UPDATE runtime_public_continuations SET destination=? WHERE job=?').run(destination,before.id);
 ctx.db.prepare('UPDATE runtime_public_inputs SET destination=? WHERE job=? AND destination=? AND released IS NULL AND consumed IS NULL').run(destination,before.id,row.destination);
}
