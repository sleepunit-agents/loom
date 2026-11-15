/** Fictitious Runtime setup through the same authenticated APIs as a real worker.
 * It schedules mail, but never pretends a provider/body has executed. */
import {z} from 'zod';
import type {sharedRoot} from './shared-root.js';
import type {FakeClock} from './core/clock.js';
import {readWorkerAccountBasis,reportWorkerAccountUsage,reportWorkerHealth,type WorkerAccountIdentity} from './runtime/worker-http.js';
import {defaultTimings} from './core/tempo/volume.js';
const SETTLE_MARGIN_MS=1000;
export const exampleSettleMs=defaultTimings.settleSeconds*1000+SETTLE_MARGIN_MS;
export const exampleBackdateMs=exampleSettleMs+SETTLE_MARGIN_MS;
export const exampleModelRoles=[{model:'example-model',provider:'example-provider',harness:'example-harness',series:'example'}];
export async function exampleRuntime(root:ReturnType<typeof sharedRoot>,clock:FakeClock,ownerToken:string,identity:WorkerAccountIdentity){
 // Account creation keeps its existing entry-point failure/cleanup contract.
 let sequence=0;
 const call=async<T>(name:string,input:unknown,schema:z.ZodType<T>)=>{
  const [piece,...path]=name.split('.');const response=await root.http.request('http://example/api/'+piece+'/'+path.join('.'),{method:'POST',headers:{authorization:'Bearer '+ownerToken,'content-type':'application/json'},body:JSON.stringify({id:'example-runtime-'+ ++sequence,input})});
  const result=z.object({ok:z.literal(true),value:schema}).strict().safeParse(await response.json());
  if(!response.ok||!result.success)throw Error('Example Runtime setup failed at '+name);
  return result.data.value;
 };
 const box=(await call('runtime.boxCreate',{name:'Example workshop',sameMachineAsLoom:true},z.object({id:z.string()}).strict())).id;
 await call('runtime.boxSettingsSet',{box,name:'Example workshop',hostsAny:false,reportOnly:false,alwaysOn:false,agents:[{agent:'fern',lent:false},{agent:'moss',lent:false}],facts:['cpu:example']},z.object({saved:z.literal(true)}).strict());
 await call('runtime.accountSignedIn',{account:identity.account,box},z.object({saved:z.literal(true)}).strict());
 for(const agent of ['fern','moss']){
  await call('runtime.agentModelsSet',{agent,models:exampleModelRoles.map(role=>role.model)},z.object({saved:z.literal(true)}).strict());
  await call('runtime.agentRunSettingsSet',{agent,houseRepository:'https://example.invalid/house.git',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false,boxes:[box],ports:[]},z.object({saved:z.literal(true)}).strict());
 }
 const worker=root.writes.run(()=>root.services.signin.issue({kind:'runner',box,label:'Example worker setup',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
 try{
  const remote={url:'https://example.invalid',token:worker.token,signal:new AbortController().signal,fetch:async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>root.http.fetch(new Request(url,init))};
  await reportWorkerHealth({...remote,facts:['arch:example']});
  const {basis}=await readWorkerAccountBasis(remote,identity);
  await reportWorkerAccountUsage(remote,{...identity,basis,windows:[{name:'week',usage:0.25,readAt:new Date(clock.now()).toISOString(),resetsAt:new Date(clock.now()+7*86400000).toISOString(),durationMs:7*86400000}]});
  const thread=root.writes.run(()=>root.services.comms!.threads.open({member:'alex',agent:'moss',title:'Inspect the example shed'})).value;
  const prepared=await root.services.comms!.prepareSend({thread:thread.id,sender:'alex',kind:'message',clientId:'example-runtime-mail',words:'Check the shed hinges before the example rain.'});
  root.writes.run(prepared);
  const publicConversation=root.writes.run(()=>{
   const conversation=root.services.conversations.open({agent:'moss',venue:'wake',place:'example-public-notice',label:'Inspect the shared garden path'});
   root.services.conversations.send({toKind:'agent',to:'moss',source:'notice',sourceId:'example-public-notice',fromKind:'person',fromId:'alex',conversation:conversation.id,words:'Inspect the shared garden path.'});
   return conversation;
  }).value;
  // Advance normal settlement, never sleep or manufacture a job row/state.
  clock.advance(exampleSettleMs);
  const response=await root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+ownerToken,'content-type':'application/json'},body:JSON.stringify({query:'{currentJobs(agent:"moss"){id title state box}}'})});
  const result=z.object({data:z.object({currentJobs:z.array(z.object({id:z.string(),title:z.string(),state:z.string(),box:z.string().nullable()}))})}).safeParse(await response.json());
  const expectedJob=root.services.conversations.conversation(thread.conversation).job;
  const expectedPublicJob=root.services.conversations.conversation(publicConversation.id).job;
  const job=result.success?result.data.data.currentJobs.find(job=>job.id===expectedJob&&job.state==='queued'&&job.box===null):undefined;
  const publicJob=result.success?result.data.data.currentJobs.find(job=>job.id===expectedPublicJob&&job.state==='queued'&&job.box===null):undefined;
  if(!response.ok||!job||!publicJob)throw Error('Example Runtime did not schedule its inbox through Tempo: HTTP '+response.status+'; '+(result.success?JSON.stringify(result.data.data.currentJobs):'invalid query response'));
  const summary=(job:{id:string;title:string;state:string;box:string|null})=>({id:job.id,title:job.title,state:job.state,box:job.box});
  return{box,account:identity.account,conversation:thread.conversation,thread:thread.id,job:summary(job),publicJob:summary(publicJob)};
 }finally{root.writes.run(()=>root.services.signin.revoke(worker.fingerprint));}
}
