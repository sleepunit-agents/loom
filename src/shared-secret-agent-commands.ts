/** Agent-facing request and use-status metadata. Only the root's authenticated
 * body proof supplies agent/job; neither is accepted from command input.
 *
 * Who may: the agentItself rule in policy.ts, for all three. An agent in the household asks in its own
 * name, from a terminal session or a body; reads the state of a request that is its own; and reads the
 * state of a secret handed to its own current job. What this door adds is not a sharing rule but which
 * job a body's credential is bound to: a request for one job, and a hand-off's state, need that job.
 *
 * Asking for the agent and no one job is asking for a standing answer, and whether a rule or the household
 * default may answer a request is the same question: policy.ts, standingSecretAnswerServes. A body doing
 * the private work of a member who is not a household owner is refused the first and is always asked of
 * the household owners for the second. */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { holds, rules, standingSecretAnswerServes, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { jobs, secretRequests, secretUses } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { agentSecretRequest } from './pieces/secrets/input.js';
import type { SecretRequests } from './pieces/secrets/requests.js';
const requestState=z.object({id:z.string(),state:z.enum(secretRequests.state.enumValues)}).strict();
const handoff=z.object({id:z.string(),state:z.enum(['started','released','failed'])}).strict();
export function registerSharedSecretAgentCommands(operations:Operations,db:DataDatabase,requests:SecretRequests,
 body:(viewer:Viewer)=>Readonly<{agent:string;job:string}>|undefined){
 const itself=(viewer:Viewer,agent:string|undefined)=>agent!==undefined&&holds(rules.agentItself,viewer,{agent},sharedSharing(db));
 const target=(viewer:Viewer)=>{
  const bound=body(viewer);if(!bound||viewer.kind!=='agent'||bound.agent!==viewer.id)return;
  const job=db.select({id:jobs.id,agent:jobs.agent,conversation:jobs.conversation}).from(jobs).where(eq(jobs.id,bound.job)).get();
  return job?.agent===bound.agent?job:undefined;
 };
 operations.register({name:'secrets.request',input:agentSecretRequest,output:requestState,write:true,recheckPolicy:true,
  inputHash:(canonical,{actor})=>{const job=target(actor);return createHash('sha256').update('loom-shared-secret-request-receipt-v1\0').update(JSON.stringify([job?.id??null,job?.conversation??null,canonical])).digest('hex');},
  may:(viewer,input)=>itself(viewer,viewer.id)&&(input.scope==='agent'?standingSecretAnswerServes(viewer,sharedSharing(db)):!!target(viewer)),
  run(ctx,input){
   const job=target(ctx.viewer);if(ctx.viewer.kind!=='agent'||(input.scope==='job'&&!job))throw new OperationError('denied','A current agent or body is required');
   try{const row=requests.request({id:input.id,secret:input.secret,why:input.why,minutes:input.minutes,agent:ctx.viewer.id,
    job:input.scope==='job'?job!.id:undefined,conversation:job?.conversation??undefined},'on_request',standingSecretAnswerServes(ctx.viewer,sharedSharing(db)));
    ctx.changed('secret-request',row.id);return {id:row.id,state:row.state};
   }catch{throw new OperationError('invalid','Secret request could not complete');}
  },
 });
 operations.register({name:'secrets.requestStatus',input:z.object({id:z.string().min(1).max(200)}).strict(),output:requestState,
  may:(viewer,input)=>itself(viewer,db.select({agent:secretRequests.agent}).from(secretRequests).where(eq(secretRequests.id,input.id)).get()?.agent),
  run(_ctx,input){const row=db.select({id:secretRequests.id,state:secretRequests.state}).from(secretRequests).where(eq(secretRequests.id,input.id)).get();if(!row)throw new OperationError('not-found','Secret request not found');return row;},
 });
 operations.register({name:'secrets.useStatus',input:z.object({id:z.string().min(1).max(200)}).strict(),output:handoff,
  may:(viewer,input)=>{const job=target(viewer),row=db.select({agent:secretUses.agent,job:secretUses.job}).from(secretUses).where(eq(secretUses.id,input.id)).get();return !!job&&row?.job===job.id&&itself(viewer,row.agent);},
  run(_ctx,input){const row=db.select({id:secretUses.id,state:secretUses.state}).from(secretUses).where(eq(secretUses.id,input.id)).get();if(!row)throw new OperationError('not-found','Secret handoff not found');return row;},
 });
}
