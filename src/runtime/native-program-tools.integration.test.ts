/** Default body -> native private FD -> actual MCP -> current Root. No child. */
import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {bodyFixture} from '../../test/fixtures/conversation-body.js';
import * as schema from '../core/data/schema.js';
import * as projection from './body-program-tools.js';
import * as listener from './body-secret-tools.js';
import {bodyProgram} from './body-program.js';
import type {WorkerAssignment} from './worker.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();vi.clearAllMocks();});
function decoded(result:unknown){return JSON.parse((result as {content:{text:string}[]}).content[0].text);}
async function prepare(){
 const value='PRIVATE_CANONICAL_CREDENTIAL',sourceBuffers:Buffer[]=[];
 const source=vi.fn(async()=>{const bytes=Buffer.from(value);sourceBuffers.push(bytes);return bytes;});
 const fixture=await bodyFixture(clean,{secretInputs:{source:{read:source}}}),token='body_'+'e'.repeat(64);
 fixture.root.writes.run(()=>{
  fixture.db.delete(schema.tokens).where(eq(schema.tokens.job,'job')).run();
  fixture.db.insert(schema.tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Fictional native',kind:'agent',agent:'art',job:'job',createdAt:new Date(fixture.clock.now()).toISOString()}).run();
  fixture.db.update(schema.jobs).set({model:'requested',harness:'claude'}).where(eq(schema.jobs.id,'job')).run();
  fixture.db.update(schema.members).set({role:'owner'}).where(eq(schema.members.id,'bob')).run();
  fixture.db.insert(schema.secrets).values({name:'TOKEN',description:'Fictional credential',changedAt:new Date(fixture.clock.now()).toISOString(),changedBy:'alice'}).run();
  fixture.db.insert(schema.secretChanges).values({id:'baseline',secret:'TOKEN',action:'add',by:'alice',at:new Date(fixture.clock.now()).toISOString()}).run();
  fixture.root.services.secrets.requests.setRule({secret:'TOKEN',answer:'auto',minutes:5,agents:[{agent:'art',when:'on_request'}]});
 });
 expect((await fixture.send('Use canonical tools privately','canonical')).status).toBe(200);
 const job:WorkerAssignment={id:'job',agent:'art',box:'box',conversation:fixture.thread.conversation,thread:fixture.thread.id,venue:'loom',model:'requested',account:'account',harness:'claude',brief:'',house:{repository:'fixture',file:'HOUSE.md',branch:'next'}};
 const bytes=Buffer.from(JSON.stringify({job,build:'image',bootstrap:{origin:'https://loom.invalid',job:'job',token}}));
 return{...fixture,token,bytes,source,sourceBuffers,value};
}
function runDefault(fixture:Awaited<ReturnType<typeof prepare>>,io:Pick<Parameters<typeof bodyProgram>[0],'fetch'|'schedule'|'error'|'env'>){
 return bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/house'}),stdin:async()=>fixture.bytes,signal:new AbortController().signal,clock:fixture.clock,...io});
}
// The outcomes share one real credential/command protocol; flags select lifetime events.
it.each(['finish','stop','finish-held','error-held','stop-held','overlapping-waits'] as const)('runs canonical tools in the actual default body: %s',async mode=>{
 const held=mode.endsWith('-held'),stop=mode==='stop'||mode==='stop-held',failed=mode==='error-held';
 const fixture=await prepare(),errors=vi.fn(),cancel=vi.fn(),pipeBuffers:Buffer[]=[],statusInputs:unknown[]=[];
 let heartbeat!:()=>void,actorEnded!:()=>void,failure:unknown,killed=false;
 let endpoint:{url:string;headers:Record<string,string>}|undefined;
 const actorFinished=new Promise<void>(resolve=>{actorEnded=resolve;});
 let holdHeartbeat=false,holdQuery=false,releaseHeartbeat=()=>{},notifyBeat!:()=>void,notifyQuery!:()=>void,notifyAbort!:()=>void;
 const beatEntered=new Promise<void>(resolve=>{notifyBeat=resolve;}),queryEntered=new Promise<void>(resolve=>{notifyQuery=resolve;}),queryAborted=new Promise<void>(resolve=>{notifyAbort=resolve;});
 let notifySecretWait!:()=>void,waitingReported=false,pollDeadline:number|undefined;
 const secretWaiting=new Promise<void>(resolve=>{notifySecretWait=resolve;}),at=fixture.clock.at.bind(fixture.clock),createListener=listener.bodySecretTools;
 vi.spyOn(listener,'bodySecretTools').mockImplementation(input=>createListener({...input,waiting:value=>{input.waiting?.(value);if(value){waitingReported=true;notifySecretWait();}}}));
 vi.spyOn(fixture.clock,'at').mockImplementation((time,work)=>{if(waitingReported&&pollDeadline===undefined)pollDeadline=time;return at(time,work);});
 vi.mocked(spawn).mockImplementation((_command,args,options)=>{
  const names=args.slice(args.indexOf('--allowedTools')+1),nextFlag=names.findIndex(name=>name.startsWith('--'));
  expect(names.slice(0,nextFlag<0?undefined:nextFlag)).toEqual(['request_secret','use_secret','loom_commands','loom_command','loom_query'].map(name=>'mcp__loom_secrets__'+name));
  expect(JSON.stringify({args,options})).not.toContain(fixture.token);
  let words='',ended=false,started=false;
  const control=new Writable({write(bytes,_encoding,next){pipeBuffers.push(bytes);endpoint=JSON.parse(bytes.toString()).mcpServers.loom_secrets;expect(bytes.includes(Buffer.from(fixture.token))).toBe(false);next();}});
  const stdin=new Writable({write(bytes,_encoding,next){words+=bytes.toString();next();}});
  const child=Object.assign(new EventEmitter(),{stdin,stdout:new PassThrough(),stderr:new PassThrough(),stdio:[stdin,null,null,control],kill:vi.fn(()=>{killed=true;child.emit('close',null);return true;})}) as unknown as ChildProcessWithoutNullStreams;
  const start=()=>{
   if(started||!ended||!endpoint)return;started=true;
   void(async()=>{
    const model=new Client({name:'fictional-native-model',version:'1'},{capabilities:{}});
    try{
     expect(words).toBe('Use canonical tools privately');
     await model.connect(new StreamableHTTPClientTransport(new URL(endpoint!.url),{requestInit:{headers:endpoint!.headers}}));
     expect((await model.listTools()).tools.map(tool=>tool.name)).toEqual(['request_secret','use_secret','loom_commands','loom_command','loom_query']);
     expect(decoded(await model.callTool({name:'loom_commands',arguments:{name:'secrets.request'}})).value.commands[0].name).toBe('secrets.request');
     expect(decoded(await model.callTool({name:'loom_query',arguments:{query:'{agents{id} members{id}}'}}))).toMatchObject({data:{agents:[{id:'art'}],members:[]}});
     const before=fixture.db.select().from(schema.household).get();
     expect(await model.callTool({name:'loom_command',arguments:{operation:'secrets.command',input:{action:'default',answer:'never'},id:randomUUID()}})).toMatchObject({isError:true});
     expect(fixture.db.select().from(schema.household).get()).toEqual(before);
     const request=randomUUID();
     expect(decoded(await model.callTool({name:'loom_command',arguments:{operation:'secrets.request',input:{id:request,secret:'TOKEN',why:'Fictional private use',minutes:5,scope:'job'},id:request}}))).toEqual({ok:true,value:{id:request,state:'allowed'}});
     expect(decoded(await model.callTool({name:'use_secret',arguments:{id:randomUUID(),secret:'TOKEN',request}}))).toEqual({encoding:'base64',value:Buffer.from(fixture.value).toString('base64')});
     expect(fixture.db.select().from(schema.secretUses).get()?.state).toBe('released');
     let pendingSecret:Promise<unknown>|undefined,pendingRequest:string|undefined;
     if(mode==='overlapping-waits'){
      fixture.root.writes.run(()=>fixture.root.services.secrets.requests.setRule({secret:'TOKEN',answer:'ask',minutes:5,agents:[{agent:'art',when:'on_request'}]}));
      pendingRequest=randomUUID();
      expect(decoded(await model.callTool({name:'request_secret',arguments:{id:pendingRequest,secret:'TOKEN',why:'Second private use',minutes:5}})).state).toBe('pending');
      pendingSecret=model.callTool({name:'use_secret',arguments:{id:randomUUID(),secret:'TOKEN',request:pendingRequest}});void pendingSecret.catch(()=>{});await secretWaiting;
      heartbeat();expect(statusInputs.at(-1)).toEqual({state:'waiting',work:'Waiting for a Secret decision'});
     }
     expect(decoded(await model.callTool({name:'loom_command',arguments:{operation:'conversation.status',input:{state:'waiting',work:'Canonical waiting'},id:randomUUID()}}))).toMatchObject({ok:true});
     if(pendingSecret){fixture.root.writes.run(()=>fixture.root.services.secrets.requests.answer(pendingRequest!,'bob',true));expect(pollDeadline).toBeDefined();fixture.clock.advance(pollDeadline!-fixture.clock.now());expect(decoded(await pendingSecret).encoding).toBe('base64');}
     let pendingQuery:Promise<unknown>|undefined;
     if(held){
      holdHeartbeat=true;heartbeat();await beatEntered;holdQuery=true;
      pendingQuery=model.callTool({name:'loom_query',arguments:{query:'{agents{id}}'}}).catch(()=>undefined);await queryEntered;
     }else if(!stop)heartbeat();
     if(stop){
      fixture.root.writes.run(()=>fixture.root.services.comms!.threads.requestStop(fixture.thread.id));
      await model.callTool({name:'loom_command',arguments:{operation:'conversation.status',input:{state:'working',work:'Checking Stop'},id:randomUUID()}}).catch(()=>undefined);expect(killed).toBe(true);await pendingQuery;return;
     }
     const session=args[args.indexOf('--session-id')+1];
     if(!failed)child.stdout.emit('data',Buffer.from([{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed',content:[{type:'text',text:'Used canonical tools privately'}]}},{type:'result',session_id:session,is_error:false,subtype:'success',result:'Used canonical tools privately'}].map(row=>JSON.stringify(row)).join('\n')));child.emit('close',failed?1:0);
     await pendingQuery;
    }finally{await model.close();}
   })().catch(error=>{if(!killed){failure=error;child.emit('close',1);}}).finally(actorEnded);
  };
  control.once('finish',start);stdin.once('finish',()=>{ended=true;start();});return child;
 });
 const fetcher:typeof fetch=async(url,init)=>{
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+fixture.token);
  if(String(url).endsWith('/conversation/status')){
   statusInputs.push(JSON.parse(String(init?.body)).input);
   if(holdHeartbeat){holdHeartbeat=false;notifyBeat();await new Promise<void>(resolve=>{releaseHeartbeat=resolve;});}
  }
  if(holdQuery&&String(url).endsWith('/graphql')){
   if(init?.signal?.aborted)notifyAbort();else init?.signal?.addEventListener('abort',notifyAbort,{once:true});notifyQuery();return new Promise<Response>(()=>{});
  }
  return fixture.root.http.request(new Request(url,init));
 };
 const running=runDefault(fixture,{env:{ACCOUNT_PROFILE:'/account'},fetch:fetcher,schedule:{every:(_ms,callback)=>{heartbeat=callback;return cancel;}},error:errors});
 if(held){
  try{
   expect(await Promise.race([queryAborted.then(()=>true),running.then(()=>false)])).toBe(true);
   let ended=false;void running.then(()=>{ended=true;});await Promise.resolve();expect(ended).toBe(false);
   await expect(fetch(endpoint!.url,{method:'POST',headers:endpoint!.headers,body:'{}'})).rejects.toThrow();
  }finally{releaseHeartbeat();}
 }
 expect(await running).toBe(failed?14:0);await actorFinished;if(failure)throw failure;
 expect(errors).toHaveBeenCalledTimes(failed?1:0);expect(cancel).toHaveBeenCalledOnce();
 expect(fixture.bytes.every(byte=>byte===0)).toBe(true);expect(pipeBuffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(fixture.sourceBuffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
 expect(fixture.source).toHaveBeenCalledTimes(mode==='overlapping-waits'?2:1);
 expect(statusInputs.filter(value=>JSON.stringify(value)===JSON.stringify({state:'waiting',work:'Canonical waiting'}))).toHaveLength(mode==='stop'?1:2);
 const replies=fixture.db.select().from(schema.turns).all().filter(row=>row.kind==='reply');expect(replies).toHaveLength(stop||failed?0:1);
 if(stop){expect(killed).toBe(true);expect(statusInputs.at(-1)).toEqual({state:'idle',work:''});
  // The body leaves the Stop for loom to take when the worker reports this job.
  expect(fixture.db.select().from(schema.threads).get()?.stopRequested).toBe(true);}
 else if(!failed)expect(replies[0]).toMatchObject({model:'observed',run:'job'});
 expect(fixture.db.$client.serialize().includes(Buffer.from(fixture.token))).toBe(false);expect(fixture.db.$client.serialize().includes(Buffer.from(fixture.value))).toBe(false);
 await expect(fetch(endpoint!.url,{method:'POST',headers:endpoint!.headers,body:'{}'})).rejects.toThrow();
});
it('retires the projection on listener setup failure before a held heartbeat settles',async()=>{
 const fixture=await prepare(),original=projection.bodyProgramTools;
 let captured:ReturnType<typeof original>|undefined,notifyAbort!:()=>void,heartbeat!:()=>void,release=()=>{},hold=false,requests=0;
 const aborted=new Promise<void>(resolve=>{notifyAbort=resolve;});
 vi.spyOn(projection,'bodyProgramTools').mockImplementation(options=>{
  options.signal.addEventListener('abort',notifyAbort,{once:true});captured=original(options);return captured;
 });
 vi.spyOn(listener,'bodySecretTools').mockImplementation(async()=>{hold=true;heartbeat();throw new Error('Private setup diagnostics');});
 const fetcher:typeof fetch=async(url,init)=>{
  requests++;if(hold&&String(url).endsWith('/conversation/status')){hold=false;await new Promise<void>(resolve=>{release=resolve;});}
  return fixture.root.http.request(new Request(url,init));
 };
 const errors=vi.fn(),running=runDefault(fixture,{env:{},fetch:fetcher,schedule:{every:(_ms,callback)=>{heartbeat=callback;return()=>{};}},error:errors});
 try{
  expect(await Promise.race([aborted.then(()=>true),running.then(()=>false)])).toBe(true);
  const before=requests;expect(await captured!.call('loom_query',{query:'{agents{id}}'})).toMatchObject({isError:true});expect(requests).toBe(before);
  let ended=false;void running.then(()=>{ended=true;});await Promise.resolve();expect(ended).toBe(false);expect(spawn).not.toHaveBeenCalled();
 }finally{release();}
 expect(await running).toBe(13);expect(errors).toHaveBeenCalledExactlyOnceWith('Body stopped: invalid input or unavailable execution\n');
});
