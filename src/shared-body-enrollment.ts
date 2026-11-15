/** Canonical metadata-only enrollment for the locally generated body credential.
 * Only the current assigned starting worker can bind a fingerprint to its job. */
import {createHash,randomUUID} from 'node:crypto';
import {and,eq,ne,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {jobs,tokens} from './core/data/schema.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {Viewer} from './policy.js';
const input=z.object({job:z.string().min(1).max(200),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type EnrollmentProof=Readonly<{box:string;fingerprint:string}>;
export function registerSharedBodyEnrollment(operations:Operations,db:DataDatabase,options:{
 now():string;runnerEnrollment(viewer:Viewer):EnrollmentProof|undefined;
}){
 const target=(viewer:Viewer,value:z.infer<typeof input>)=>{
  const proof=options.runnerEnrollment(viewer);if(viewer.kind!=='runner'||!proof||proof.box!==viewer.id)return;
  const job=db.select().from(jobs).where(eq(jobs.id,value.job)).get();
  if(!job||job.state!=='starting'||job.box!==proof.box)return;
  const old=db.select().from(tokens).where(eq(tokens.fingerprint,value.fingerprint)).get();
  const at=Date.parse(options.now());
  if(old&&(old.kind!=='agent'||old.agent!==job.agent||old.job!==job.id||old.member!==null||old.box!==null
   ||old.revokedAt!==null||!(Date.parse(old.createdAt)<=at)||old.expiresAt!==null&&!(at<Date.parse(old.expiresAt))))return;
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
    db.update(tokens).set({revokedAt:options.now()}).where(and(eq(tokens.kind,'agent'),eq(tokens.job,found.job.id),ne(tokens.fingerprint,value.fingerprint),isNull(tokens.revokedAt))).run();
    // Labels are globally unique while live; independent jobs retain their own
    // credentials. The authoritative job link remains the typed job column.
    db.insert(tokens).values({fingerprint:value.fingerprint,label:`Job body [${randomUUID()}]`,kind:'agent',agent:found.job.agent,job:found.job.id,
     madeFrom:found.proof.fingerprint,createdAt:options.now()}).run();
    ctx.changed('token',value.fingerprint);
   }
   return {registered:true as const};
  },
 });
}
