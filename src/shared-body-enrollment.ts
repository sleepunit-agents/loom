/** Canonical metadata-only enrollment for the locally generated body credential.
 * Only the current assigned starting worker can bind a fingerprint to its job, and only while the job has no
 * live body token: the same fingerprint again is a repeat, another one is refused.
 * This decides who may enrol; the row itself is made by sharedTokens, like every token row. */
import {SHA256_HEX} from './core/sha256-hex.js';
import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {jobs,tokens} from './core/data/schema.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {sharedTokens} from './core/signin/shared-tokens.js';
import {tokenLive} from './core/data/authentication.js';
import type {Viewer} from './policy.js';
import {liveWorker} from './shared-worker.js';
const input=z.object({job:z.string().min(1).max(200),fingerprint:z.string().regex(SHA256_HEX)}).strict();
type EnrollmentProof=Readonly<{box:string;fingerprint:string}>;
export function registerSharedBodyEnrollment(operations:Operations,db:DataDatabase,options:{
 now():string;runnerEnrollment(viewer:Viewer):EnrollmentProof|undefined;
}){
 const issuer=sharedTokens(db,{now:()=>Date.parse(options.now())});
 const target=(viewer:Viewer,value:z.infer<typeof input>)=>{
  const proof=options.runnerEnrollment(viewer);if(!proof||!liveWorker(db,viewer,proof))return;
  const job=db.select().from(jobs).where(eq(jobs.id,value.job)).get();
  if(!job||job.machine!==null||job.state!=='starting'||job.box!==proof.box)return;
  const old=db.select().from(tokens).where(eq(tokens.fingerprint,value.fingerprint)).get();
  const at=Date.parse(options.now());
  if(old&&(old.kind!=='agent'||old.agent!==job.agent||old.job!==job.id||old.member!==null||old.box!==null
   ||!tokenLive(old,at)||!(Date.parse(old.createdAt)<=at)))return;
  // A job has one body. While it has a live body token, no other fingerprint is bound to it: a second
  // enrolment would be a second body in the first one's place, with everything the job is handed.
  if(!old&&db.select().from(tokens).where(and(eq(tokens.kind,'agent'),eq(tokens.job,job.id))).all().some(row=>tokenLive(row,at)))return;
  return {job,proof,old};
 };
 operations.register({name:'runtime.enrollBody',doors:['http'],write:true,recheckPolicy:true,input,
  output:z.object({registered:z.literal(true)}).strict(),may:(viewer,value)=>!!target(viewer,value),
  inputHash(canonical,{actor,input:value}){
   const found=target(actor,value);
   return createHash('sha256').update('loom-body-enrollment-v1\0').update(JSON.stringify([found?.proof.fingerprint??null,
    found?.job.agent??null,found?.job.box??null,found?.job.conversation??null,found?.job.member??null,found?.job.project??null,canonical])).digest('hex');
  },
  run(ctx,value){
   const found=target(ctx.viewer,value);if(!found)throw new OperationError('denied','Current assigned starting worker required');
   if(!found.old){
    issuer.enrolBody({fingerprint:value.fingerprint,agent:found.job.agent,job:found.job.id,madeFrom:found.proof.fingerprint});
    ctx.changed('token',value.fingerprint);
   }
   return {registered:true as const};
  },
 });
}
