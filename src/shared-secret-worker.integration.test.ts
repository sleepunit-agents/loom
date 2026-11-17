/** Production listener/client/process-adapter join; child processes are mocked. */
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,memberAgents,boxes,agentBoxes,agentModels,agentRunSettings,modelAccounts,modelAccountWindows,modelAccountBoxes,tokens,secrets,secretChanges,agentHouseSecrets,jobs,secretUses,operationResults} from './core/data/schema.js';
import {serveShared} from './shared-serve.js';
import {httpWorkerControl} from './runtime/worker-http.js';
import {commandWorkerExecutor,type ProcessRuntime} from './runtime/worker-process.js';
import {workOnce} from './runtime/worker.js';
import {privateSecretClient} from './pieces/secrets/private-client.js';
import {bodyStartupSecrets} from './runtime/body-secrets.js';
const clean:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it.each([{expected:Buffer.from('PRIVATE_HOUSE_TOKEN'),environment:false},{expected:Buffer.from([80,82,73,86,65,84,69,0,255,128,13,10,69,78,68]),environment:false},{expected:Buffer.from('PRIVATE_NATIVE_ENVIRONMENT'),environment:true}])('carries an enrolled credential after running ACK and preserves private startup bytes $environment $expected',async ({expected,environment})=>{
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),runner='r'.repeat(64),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 db.insert(members).values({id:'owner',role:'owner',joinedAt:now()}).run();db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(memberAgents).values({member:'owner',agent:'art'}).run();
 db.insert(boxes).values({id:'worker',name:'Worker',owner:'owner',sameMachineAsLoom:false,hostsAny:true,reportOnly:false,alwaysOn:false,enrolledAt:now(),lastSeenAt:now()}).run();db.insert(tokens).values({fingerprint:hash(runner),label:'Worker',kind:'runner',box:'worker',createdAt:now()}).run();db.insert(agentBoxes).values({agent:'art',box:'worker',position:0}).run();db.insert(agentModels).values({agent:'art',model:'model',position:0}).run();db.insert(agentRunSettings).values({agent:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 db.insert(modelAccounts).values({id:'account',owner:'owner',provider:'provider',label:'Account',hasRoom:true}).run();db.insert(modelAccountWindows).values({account:'account',window:'week',usage:0,usageReadAt:now(),resetsAt:new Date(clock.now()+7*86400000).toISOString(),durationMs:7*86400000}).run();db.insert(modelAccountBoxes).values({account:'account',box:'worker'}).run();
 db.insert(secrets).values({name:'TOKEN',description:'Synthetic',changedAt:now(),changedBy:'owner'}).run();db.insert(secretChanges).values({id:'baseline',secret:'TOKEN',action:'add',by:'owner',at:now()}).run();db.insert(agentHouseSecrets).values({agent:'art',alias:'API_TOKEN',secret:'TOKEN'}).run();
 const buffers:Buffer[]=[],source=vi.fn(async(name:string)=>{expect(name).toBe('TOKEN');expect(client.inTransaction).toBe(false);expect(db.select().from(jobs).get()?.state).toBe('running');expect(db.select().from(secretUses).get()?.state).toBe('started');const bytes=Buffer.from(expected);buffers.push(bytes);return bytes;});
 const errors=vi.fn(),root=await serveShared({db,clock,host:'127.0.0.1',port:0,originAllowed:()=>true,reportError:errors,modelRoles:()=>[{model:'model',provider:'provider',harness:'codex',series:'test'}],secretInputs:{source:{read:source}}});clean.push(()=>root.close());root.writes.run(()=>root.services.secrets.requests.setRule({secret:'TOKEN',answer:'auto',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 const conversation=root.services.conversations.open({agent:'art',venue:'loom',place:'startup',label:'Startup'}),mail=root.services.conversations.send({toKind:'agent',to:'art',conversation:conversation.id,source:'thread',fromKind:'person',fromId:'owner',words:'Private task words'});expect(root.services.runtime.admit({kind:'agent',id:'art'},[mail])).toBe(true);const saved=db.select().from(jobs).get()!;
 const control=httpWorkerControl({url:root.url,token:runner,signal:new AbortController().signal}),enroll=control.enrollBody!;let owned:Uint8Array|undefined,receivedToken='';control.enrollBody=async(...args)=>{const value=await enroll(...args);owned=value.token;return value;};
 const finish=vi.spyOn(control,'finish');
 const closed=new WeakSet<object>(),children:ChildProcessWithoutNullStreams[]=[];let failure:unknown;const accepted=vi.fn();
 const runtime:ProcessRuntime={
  spawn:vi.fn(plan=>{
   const events=new EventEmitter();let input='';const stdin=new Writable({write(chunk,_encoding,done){input+=chunk.toString();done();}}),child=Object.assign(events,{pid:123,stdin,stdout:new PassThrough(),stderr:new PassThrough()}) as unknown as ChildProcessWithoutNullStreams;children.push(child);
   stdin.once('finish',()=>{void(async()=>{
    if(plan.command==='/fake/build'){expect(JSON.parse(input)).toEqual({job:saved.id,house:{repository:'repo',file:'Housefile',branch:'next'}});child.stdout.emit('data',Buffer.from('{"build":"artifact"}'));}
    else{
     const payload=JSON.parse(input);expect(payload.job.id).toBe(saved.id);expect(payload.job.brief).toBe('');expect(payload.bootstrap).toMatchObject({job:saved.id,origin:root.url});expect(db.select().from(jobs).get()?.state).toBe('running');expect(source).not.toHaveBeenCalled();receivedToken=payload.bootstrap.token;expect(receivedToken).toMatch(/^body_[a-f0-9]{64}$/);
     if(environment){
      const env:NodeJS.ProcessEnv={ACCOUNT_PROFILE:'/account'},recipient=bodyStartupSecrets(env,{clock});
      try{await recipient.startup(payload.job,{...payload.bootstrap,token:Buffer.from(receivedToken)},new AbortController().signal);expect(env).toEqual({ACCOUNT_PROFILE:'/account',API_TOKEN:expected.toString()});accepted();}finally{recipient.close();}
      expect(env).toEqual({ACCOUNT_PROFILE:'/account'});
     }else{
      const recipient=privateSecretClient({url:payload.bootstrap.origin,token:receivedToken,signal:new AbortController().signal,clock});try{const values=await recipient.startup();expect([...values.keys()]).toEqual(['API_TOKEN']);expect(values.get('API_TOKEN')).toEqual(expected);accepted();for(const bytes of values.values())bytes.fill(0);}finally{recipient.close();}
     }
     child.stdout.emit('data',Buffer.concat([Buffer.from(expected),Buffer.from(receivedToken)]));child.stderr.emit('data',Buffer.concat([Buffer.from(expected),Buffer.from(receivedToken)]));
    }
    closed.add(child);child.emit('close',0,null);
   })().catch(error=>{failure=error;closed.add(child);child.emit('close',1,null);});});
   queueMicrotask(()=>child.emit('spawn'));return child;
  }),
  kill:vi.fn(child=>{if(!closed.has(child)){closed.add(child);child.emit('close',null,'SIGKILL');}}),
 };
 const executor=commandWorkerExecutor({build:{command:'/fake/build',args:[],cwd:'/work',env:{}},runners:{codex:{command:'/fake/body',args:[],cwd:'/work',env:{},bodyBootstrap:true}}},runtime);
 expect(await workOnce({box:'worker',control,executor,signal:new AbortController().signal,schedule:{every:()=>()=>{}}})).toBe('finished');if(failure)throw failure;expect(accepted).toHaveBeenCalledOnce();expect(finish).toHaveBeenCalledExactlyOnceWith(saved.id,0,'','body');expect(children).toHaveLength(2);expect(source).toHaveBeenCalledOnce();expect(owned?.every(byte=>byte===0)).toBe(true);expect(buffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
 expect(db.select().from(jobs).get()).toMatchObject({id:saved.id,state:'done',brief:'',logTail:null});expect(db.select().from(secretUses).get()).toMatchObject({secret:'TOKEN',agent:'art',job:saved.id,state:'released'});expect(db.select().from(operationResults).all().some(row=>row.operation==='runtime.enrollBody')).toBe(true);expect(client.serialize().includes(Buffer.from(receivedToken))).toBe(false);expect(client.serialize().includes(expected)).toBe(false);expect(errors).not.toHaveBeenCalled();
},15000);
