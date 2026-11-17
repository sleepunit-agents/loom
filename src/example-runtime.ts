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
export const exampleModelRoles=[{model:'example-model',provider:'example-provider',harness:'claude',series:'example'}];
export async function exampleRuntime(root:ReturnType<typeof sharedRoot>,clock:FakeClock,ownerToken:string,identity:WorkerAccountIdentity){
 let sequence=0;
 // Runtime commands share this envelope; account creation keeps its entry-point cleanup contract.
 const ownerCommand=async<T>(name:string,input:unknown,schema:z.ZodType<T>)=>{
  const [piece,...path]=name.split('.');const response=await root.http.request('http://example/api/'+piece+'/'+path.join('.'),{method:'POST',headers:{authorization:'Bearer '+ownerToken,'content-type':'application/json'},body:JSON.stringify({id:'example-runtime-'+ ++sequence,input})});
  const result=z.object({ok:z.literal(true),value:schema}).strict().safeParse(await response.json());
  if(!response.ok||!result.success)throw Error('Example Runtime setup failed at '+name);
  return result.data.value;
 };
 const box=(await ownerCommand('runtime.boxCreate',{name:'Example workshop',sameMachineAsLoom:true},z.object({id:z.string()}).strict())).id;
 // Setting a machine and an agent up is installed code's own business here; from outside it is a proposal an owner allows.
 root.writes.run(()=>root.services.setup.machine({box,name:'Example workshop',hostsAny:false,reportOnly:false,alwaysOn:false,agents:[{agent:'fern',lent:false},{agent:'moss',lent:false}],facts:['cpu:example']}));
 await ownerCommand('runtime.accountSignedIn',{account:identity.account,box},z.object({saved:z.literal(true)}).strict());
 for(const agent of ['fern','moss']){
  root.writes.run(()=>{
   root.services.setup.models({agent,models:exampleModelRoles.map(role=>role.model)});
   root.services.setup.run('alex',{agent,houseRepository:'https://example.invalid/house.git',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false,boxes:[box],ports:[]});
  });
 }
 const worker=root.writes.run(()=>root.services.signin.issue({kind:'runner',box,label:'Example worker setup',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
 try{
  const workerHttp={url:'https://example.invalid',token:worker.token,signal:new AbortController().signal,fetch:async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>root.http.fetch(new Request(url,init))};
  await reportWorkerHealth({...workerHttp,facts:['arch:example']});
  const {basis}=await readWorkerAccountBasis(workerHttp,identity);
  await reportWorkerAccountUsage(workerHttp,{...identity,basis,windows:[{name:'week',usage:0.25,readAt:new Date(clock.now()).toISOString(),resetsAt:new Date(clock.now()+7*86400000).toISOString(),durationMs:7*86400000}]});
  const thread=root.writes.run(()=>root.services.comms!.threads.open({member:'alex',agent:'moss',title:'Inspect the example shed'})).value;
  const prepared=await root.services.comms!.prepareSend({thread:thread.id,sender:'alex',kind:'message',clientId:'example-runtime-mail',words:'Check the shed hinges before the example rain.'});
  root.writes.run(prepared);
  const publicTrigger=await ownerCommand('tempo.set',{ownerKind:'agent',owner:'moss',sourceKind:'time',times:new Date(clock.now()).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'moss',instructions:'Inspect the shared garden path.',note:'Inspect the shared garden path'},z.object({id:z.string()}).strict());
  // Advance normal settlement, never sleep or manufacture a job row/state.
  clock.advance(exampleSettleMs);
  const response=await root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+ownerToken,'content-type':'application/json'},body:JSON.stringify({query:'{currentJobs(agent:"moss"){id title state box conversation}}'})});
  const result=z.object({data:z.object({currentJobs:z.array(z.object({id:z.string(),title:z.string(),state:z.string(),box:z.string().nullable(),conversation:z.string().nullable()}))})}).safeParse(await response.json());
  const publicConversation=root.services.conversations.open({agent:'moss',venue:'wake',place:publicTrigger.id,label:'Inspect the shared garden path'});
  const job=result.success?result.data.data.currentJobs.find(job=>job.conversation===thread.conversation&&job.state==='queued'&&job.box===null):undefined;
  const publicJob=result.success?result.data.data.currentJobs.find(job=>job.conversation===publicConversation.id&&job.state==='queued'&&job.box===null):undefined;
  if(!response.ok||!job||!publicJob)throw Error('Example Runtime did not schedule its inbox through Tempo: HTTP '+response.status+'; '+(result.success?JSON.stringify(result.data.data.currentJobs):'invalid query response'));
  return{box,account:identity.account,conversation:thread.conversation,thread:thread.id,job,publicJob,publicTrigger:publicTrigger.id};
 }finally{root.writes.run(()=>root.services.signin.revoke(worker.fingerprint));}
}
