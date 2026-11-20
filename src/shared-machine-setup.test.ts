/** Complete configuration-to-worker proof using public metadata operations and
 * canonical Sign-in issuance. Every body/provider remains in-process and fake. */
import {afterEach,expect,it,vi} from 'vitest';
import { setupCall } from '../test/fixtures/setup-call.js';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {httpWorkerControl,readWorkerAccountBasis,reportWorkerAccountUsage} from './runtime/worker-http.js';
import {workOnce,type WorkerExecutor} from './runtime/worker.js';
import {bodyInput,type BodyBootstrap} from './runtime/body-bootstrap.js';
import {bodyProgram} from './runtime/body-program.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it('sets up a new machine, account and model and completes its first receiving-body job',async()=>{
 const f=await bodyFixture(clean,{modelRoles:()=>[{model:'requested-fixture',provider:'fake-provider',harness:'claude',series:'fixture-series'}]});
 // Begin with the fixture household/conversation, removing its pre-bound job.
 // Every new machine/account/model/run setting below uses the public operations.
 f.root.writes.run(()=>{f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();f.db.delete(s.tokens).where(eq(s.tokens.job,'job')).run();f.db.delete(s.jobs).run();});
 const fetcher:typeof fetch=async(url,init)=>f.root.http.fetch(new Request(url,init)),signal=new AbortController().signal;
 let receipt=0;const call=async(name:string,input:unknown,token=raw.member)=>{const [piece,...rest]=name.split('.');// Machine and agent settings have no outside command: installed code sets them, anyone else proposes.
  const response=setupCall(f.root,name,input,'alice')??await fetcher('https://loom.example/api/'+piece+'/'+rest.join('.'),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id:'setup-'+ ++receipt})});expect(response.status,name).toBe(200);const result=await response.json();expect(result.ok,name).toBe(true);return result.value;};
 const box=(await call('runtime.boxCreate',{name:'New worker',sameMachineAsLoom:false})).id as string;
 await call('runtime.boxSettingsSet',{box,name:'New worker',hostsAny:true,reportOnly:false,alwaysOn:false,agents:[],facts:['cpu:fixture']});
 const tokenResponse=await fetcher('https://loom.example/api/signin/token',{method:'POST',headers:{authorization:'Bearer '+raw.member,'content-type':'application/json'},body:JSON.stringify({kind:'runner',box,label:'New worker credential'})});expect(tokenResponse.status).toBe(200);const issued=(await tokenResponse.json()).value as {token:string;fingerprint:string};expect(issued.fingerprint).toBe(credentialHash(issued.token));
 const account=(await call('runtime.accountCreate',{provider:'fake-provider',label:'Private subscription'})).id as string;
 await call('runtime.accountSignedIn',{account,box});
 await call('runtime.agentModelsSet',{agent:'art',models:['requested-fixture']});
 await call('runtime.agentRunSettingsSet',{agent:'art',houseRepository:'https://example.com/house.git',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false,boxes:[box],ports:[]});
 const remote={url:'https://loom.example',token:issued.token,signal,fetch:fetcher};const control=httpWorkerControl(remote);
 const {basis}=await readWorkerAccountBasis(remote,{account,owner:'alice',provider:'fake-provider'});await reportWorkerAccountUsage(remote,{account,owner:'alice',provider:'fake-provider',basis,windows:[{name:'week',usage:0.1,readAt:new Date(f.clock.now()).toISOString(),resetsAt:new Date(f.clock.now()+7*86400000).toISOString(),durationMs:7*86400000}]});
 const document='{modelAccounts{__typename ...on RuntimeAccountDetail{id label owner provider usage usageReadAt resetsAt hasRoom signedInOn{id name}} ...on RuntimeAccountSummary{label level}}}';
 const query=async(token:string)=>{const response=await fetcher('https://loom.example/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:document})});expect(response.status).toBe(200);return response.json();};
 expect((await query(raw.member)).data.modelAccounts).toEqual([{__typename:'RuntimeAccountDetail',id:account,label:'Private subscription',owner:'alice',provider:'fake-provider',usage:0.1,usageReadAt:new Date(f.clock.now()).toISOString(),resetsAt:new Date(f.clock.now()+7*86400000).toISOString(),hasRoom:true,signedInOn:[{id:box,name:'New worker'}]}]);
 const otherResponse=await fetcher('https://loom.example/api/signin/token',{method:'POST',headers:{authorization:'Bearer '+raw.member,'content-type':'application/json'},body:JSON.stringify({kind:'owner',member:'bob',label:'Other member credential'})});expect(otherResponse.status).toBe(200);const other=(await otherResponse.json()).value as {token:string};expect((await query(other.token)).data.modelAccounts).toEqual([{__typename:'RuntimeAccountSummary',label:'Private subscription',level:'plenty'}]);
 expect((await f.send('PRIVATE_SETUP_MAIL','configured-mail')).status).toBe(200);f.clock.advance(1000);
 // Default settlement is deliberately not altered by fixture SQL: this member
 // and agent use their real configured defaults, driven by the fake clock.
 f.clock.advance(60000);
 const native=vi.fn(async(_job:unknown,_words:string,_signal:AbortSignal)=>({text:'PRIVATE_SETUP_REPLY',model:'observed-fixture',actions:[]}));let owned:Uint8Array|undefined;
 const enroll=control.enrollBody!;control.enrollBody=async(...args)=>{const result=await enroll(...args);owned=result.token;return result;};
 const executor:WorkerExecutor={build:vi.fn(async(job)=>{expect(job).toMatchObject({box,account,model:'requested-fixture',harness:'claude',house:{repository:'https://example.com/house.git',file:'Housefile',branch:'next'}});return'fixture-image';}),start(job,build){
  const abort=new AbortController();let release!: (value:{exitCode:number;logTail:string})=>void;const exited=new Promise<{exitCode:number;logTail:string}>(resolve=>{release=resolve;});
  return{acceptsBootstrap:true,spawned:Promise.resolve(),exited,async release(bootstrap?:BodyBootstrap){expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,job.id)).get()?.state).toBe('running');const bytes=Buffer.from(JSON.stringify(bodyInput(job,build,bootstrap,true)));void bodyProgram({args:['body.json'],read:async()=>JSON.stringify({command:'/fake/native',cwd:'/work'}),stdin:async()=>bytes,env:{},signal:abort.signal,fetch:fetcher,clock:f.clock,schedule:{every:()=>()=>{}},native,error:()=>{}}).then(exitCode=>release({exitCode,logTail:''}));},async stop(){abort.abort();await exited;}};
 }};
 expect(await workOnce({box,control,executor,signal,schedule:{every:()=>()=>{}}})).toBe('finished');expect(native).toHaveBeenCalledOnce();expect(native.mock.calls[0][1]).toMatch(/approvals\.answer[\s\S]*\n\nPRIVATE_SETUP_MAIL$/);
 const job=f.db.select().from(s.jobs).get()!;expect(job).toMatchObject({box,account,model:'requested-fixture',state:'done',brief:'',logTail:null});expect(f.db.select().from(s.turns).all().map(turn=>turn.model)).toEqual([null,'observed-fixture']);expect(owned?.every(byte=>byte===0)).toBe(true);
 const body=f.db.select().from(s.tokens).where(eq(s.tokens.job,job.id)).get()!;expect(body.madeFrom).toBe(issued.fingerprint);for(const secret of[issued.token,other.token,'PRIVATE_SETUP_MAIL','PRIVATE_SETUP_REPLY'])expect(f.db.$client.serialize().includes(Buffer.from(secret))).toBe(false);
 await call('runtime.boxRevoke',{box});expect(f.root.credentials.authenticate(new Request('https://loom.example',{headers:{authorization:'Bearer '+issued.token}}))).toBeUndefined();
});
