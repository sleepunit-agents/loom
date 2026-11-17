import {SECRET_USE_ID} from './pieces/secrets/use-id.js';
import {startupRequestId,repositoryRequestId} from './pieces/secrets/requests.js';
/** Private effect door, separate from common operation/result serialization.
 * Owners can write values in Settings; only the actual granted job receives
 * bytes here. Runtime parent access is limited to its configured repo input.
 *
 * These routes are not registered operations, on purpose: an operation's result is saved as a receipt and
 * replayed, and secret bytes must not be. Who may call is proof of assignment (a body's own job, a worker's
 * own machine), not a sharing rule, so it is checked here and not in policy.ts. The reasoning and the full
 * list of checks: docs/accepted-tradeoffs.md, "The private secret-input routes are not registered operations".
 *
 * Two things here are policy.ts's and are asked of it, each time a hand-off is checked: a body is still
 * its agent in the household, for the member its work is for (rules.agentItself); and whether a standing
 * answer serves that work (standingSecretAnswerServes). A worker's read of the repository secret is the
 * worker's, before any body runs, and is not narrowed by the member the job is for; its grant has its own
 * request (repositoryRequestId) and is counted for no body's read. */
import {Hono} from 'hono';
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {jobs,agentHouseSecrets,agentRunSettings,secretRequests} from './core/data/schema.js';
import type {sharedCredentials} from './shared-credentials.js';
import {SecretPrivateInputs,PrivateInputError} from './pieces/secrets/private-inputs.js';
import {secretName,houseSecretAlias} from './pieces/secrets/input.js';
import {holds,rules,standingSecretAnswerServes} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
type Credentials=ReturnType<typeof sharedCredentials>;
const readInput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('request'),id:z.uuid(),secret:secretName}).strict(),
 z.object({kind:z.literal('startup'),alias:houseSecretAlias}).strict(),
 z.object({kind:z.literal('repository'),job:z.string().min(1).max(200)}).strict(),
]);
const confirmInput=z.object({use:z.string().regex(SECRET_USE_ID),job:z.string().min(1).max(200).optional()}).strict();
const binding=(row:typeof jobs.$inferSelect)=>JSON.stringify([row.id,row.agent,row.box,row.conversation,row.member,row.project,row.houseRepository,row.houseFile,row.houseBranch]);
export function sharedSecretInputRoutes(options:{db:DataDatabase;inputs:SecretPrivateInputs;credentials:Credentials;
 readJson(request:Request,abort:AbortController):Promise<unknown>;available():boolean}){
 const {db,inputs,credentials}=options;
 const app=new Hono<{Variables:{shutdown:AbortController}}>();
 const actor=(request:Request)=>{
  const auth=credentials.authenticate(request);if(request.signal.aborted||!auth?.valid()||!options.available())throw new PrivateInputError('denied');
  const body=credentials.body(auth.viewer),runner=credentials.runner(auth.viewer);
  if(!body&&!runner)throw new PrivateInputError('denied');
  return {auth,body,runner,signal:request.signal};
 };
 const itself=(caller:ReturnType<typeof actor>)=>!caller.body||holds(rules.agentItself,caller.auth.viewer,{agent:caller.body.agent},sharedSharing(db));
 const standing=(caller:ReturnType<typeof actor>)=>!caller.body||standingSecretAnswerServes(caller.auth.viewer,sharedSharing(db));
 const target=(caller:ReturnType<typeof actor>,id?:string)=>{
  if(caller.body&&id!==undefined||!caller.body&&!id)throw new PrivateInputError('denied');
  const job=db.select().from(jobs).where(eq(jobs.id,caller.body?.job??id!)).get();
  const valid=()=>!!job&&!caller.signal.aborted&&caller.auth.valid()&&options.available()&&itself(caller)&&(caller.body?job.agent===caller.body.agent&&job.state==='running':job.box===caller.runner?.box&&job.state==='starting');
  if(!valid())throw new PrivateInputError('denied');
  const stamp=binding(job!);
  return {job:job!,current:()=>{
   if(caller.signal.aborted||!caller.auth.valid()||!options.available()||!itself(caller))return false;
   const now=db.select().from(jobs).where(eq(jobs.id,job!.id)).get();
   return !!now&&binding(now)===stamp&&(caller.body?now.state==='running':now.state==='starting'&&now.box===caller.runner?.box);
  }};
 };
 app.onError((error,c)=>{const code=error instanceof PrivateInputError?error.code:'unavailable';return c.json({ok:false,message:'Private secret input unavailable'},code==='denied'?403:code==='conflict'?409:503);});
 const json=async(request:Request,abort:AbortController)=>{
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new PrivateInputError('denied');
  return options.readJson(request,abort);
 };
 app.post('/startup',async c=>{
  const caller=actor(c.req.raw);if(!caller.body)throw new PrivateInputError('denied');
  if(!z.object({}).strict().safeParse(await json(c.req.raw,c.get('shutdown'))).success)return c.json({ok:false,message:'Private secret input unavailable'},400);
  const selected=target(caller),plan=inputs.startup(selected.job.id,standing(caller));if(!selected.current())throw new PrivateInputError('denied');return c.json(plan);
 });
 app.post('/read',async c=>{
  const caller=actor(c.req.raw),parsed=readInput.safeParse(await json(c.req.raw,c.get('shutdown')));
  if(!parsed.success)return c.json({ok:false,message:'Private secret input unavailable'},400);
  const input=parsed.data;
  if(input.kind==='repository'?!caller.runner:!caller.body)throw new PrivateInputError('denied');
  const selected=target(caller,input.kind==='repository'?input.job:undefined),job=selected.job;
  let secret:string,attempt:string,request:string|undefined,current=selected.current;
  if(input.kind==='request'){secret=input.secret;attempt='request:'+input.id;}
  else if(input.kind==='startup'){
   if(!inputs.startup(job.id,standing(caller)).aliases.some(row=>row.alias===input.alias))throw new PrivateInputError('denied');
   const row=db.select().from(agentHouseSecrets).where(and(eq(agentHouseSecrets.agent,job.agent),eq(agentHouseSecrets.alias,input.alias))).get();if(!row)throw new PrivateInputError('denied');
   secret=row.secret;attempt='startup:'+input.alias;request=startupRequestId(job.id,secret);
   current=()=>selected.current()&&!!inputs.requests.grantFor(secret,job.agent,job.id,startupRequestId(job.id,secret),standing(caller))&&db.select().from(agentHouseSecrets).where(and(eq(agentHouseSecrets.agent,job.agent),eq(agentHouseSecrets.alias,input.alias))).get()?.secret===secret;
  }else{
   const row=db.select().from(agentRunSettings).where(eq(agentRunSettings.agent,job.agent)).get();
   if(!row?.repositorySecret)return new Response(null,{status:204});
   const repositoryCurrent=()=>{
    const now=db.select().from(agentRunSettings).where(eq(agentRunSettings.agent,job.agent)).get();
    return !!now&&now.houseRepository===job.houseRepository&&now.houseFile===job.houseFile&&now.houseBranch===job.houseBranch&&now.repositorySecret===row.repositorySecret;
   };
   if(!repositoryCurrent())throw new PrivateInputError('denied');
   if(!job.houseRepository.trim())return new Response(null,{status:204});
   inputs.repositoryGrant(job.id,row.repositorySecret);secret=row.repositorySecret;attempt='repository';request=repositoryRequestId(job.id,secret);current=()=>selected.current()&&repositoryCurrent()&&!!inputs.requests.grantFor(secret,job.agent,job.id,repositoryRequestId(job.id,secret));
   if(selected.current()&&repositoryCurrent()&&!current()&&db.select().from(secretRequests).where(eq(secretRequests.id,repositoryRequestId(job.id,secret))).get()?.state==='pending')return c.json({pending:true},423);
  }
  if(!current())throw new PrivateInputError('denied');
  // Blob snapshots bytes before erasure; Node's fast Response retains views.
  return inputs.dispatch({job:job.id,secret,attempt,request,standing:()=>standing(caller)},current,(use,bytes)=>{const copy=Uint8Array.from(bytes);try{return new Response(new Blob([copy]),{
   headers:{'content-type':'application/octet-stream','cache-control':'no-store','content-length':String(copy.byteLength),'x-loom-secret-use':use},
  });}finally{copy.fill(0);}});
 });
 app.post('/confirm',async c=>{
  const caller=actor(c.req.raw),parsed=confirmInput.safeParse(await json(c.req.raw,c.get('shutdown')));
  if(!parsed.success)return c.json({ok:false,message:'Private secret input unavailable'},400);
  const selected=target(caller,parsed.data.job);inputs.confirm(selected.job.id,parsed.data.use,selected.current);return c.json({confirmed:true});
 });
 return app;
}
