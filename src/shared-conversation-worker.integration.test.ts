/** Production worker/Root protocol with in-process receiving programs only. */
import {afterEach,expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {bodyProgram} from './runtime/body-program.js';
import {claudeBody} from './runtime/claude-body.js';
import {bodyConversationClient} from './runtime/conversation-client.js';
import {getRequestListener} from '@hono/node-server';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import {httpWorkerControl} from './runtime/worker-http.js';
import {commandWorkerExecutor,type ProcessRuntime} from './runtime/worker-process.js';
import {workOnce} from './runtime/worker.js';
import * as s from './core/data/schema.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.mocked(spawn).mockReset();vi.restoreAllMocks();});
function nativeReply(child:ChildProcessWithoutNullStreams,args:readonly string[],actions:readonly {name:string;input:Record<string,unknown>}[]=[]){
 const session=args[args.indexOf('--session-id')+1];
 const assistant=(content:unknown[])=>({type:'assistant',parent_tool_use_id:null,session_id:session,message:{model:'fixture-actual-model',content}});
 const rows=[...actions.map(action=>assistant([{type:'tool_use',id:randomUUID(),name:'mcp__loom_secrets__'+action.name,input:action.input}])),assistant([{type:'text',text:'PRIVATE WORKER REPLY'}]),{type:'result',subtype:'success',is_error:false,session_id:session,result:'PRIVATE WORKER REPLY'}];
 child.stdout.emit('data',Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')));child.emit('close',0,null);
}
it.each(['fixture','claude','tempo'] as const)('builds and runs an in-process %s private Comms recipient through production worker enrollment, running ACK and stdin bootstrap',async variant=>{
 const harness=variant==='tempo'?'claude':variant;
 const f=await bodyFixture(clean,{initialTime:Date.now(),modelRoles:()=>[{model:'requested-model',provider:'provider',harness,series:'series'}]});
 f.root.writes.run(()=>{
  if(variant==='tempo'){f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();f.db.insert(s.tempoSettings).values({whoKind:'person',who:'alice',settleSeconds:5,dimDays:3,muteDays:9}).run();}
  f.db.delete(s.tokens).where(eq(s.tokens.job,'job')).run();f.db.update(s.conversations).set({job:null}).run();f.db.delete(s.jobs).run();
  f.db.insert(s.boxAgents).values({box:'box',agent:'art',lent:false}).run();f.db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();f.db.insert(s.agentModels).values({agent:'art',model:'requested-model',position:0}).run();
  f.db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
  f.db.insert(s.modelAccounts).values({id:'account',owner:'alice',provider:'provider',label:'Fixture account',hasRoom:true}).run();
  f.db.insert(s.modelAccountBoxes).values({account:'account',box:'box'}).run();f.db.insert(s.modelAccountWindows).values({account:'account',window:'week',usage:0.1,usageReadAt:new Date(f.clock.now()).toISOString(),resetsAt:new Date(f.clock.now()+7*86400000).toISOString(),durationMs:7*86400000}).run();
  f.db.insert(s.tempoSettings).values({whoKind:'agent',who:'art',settleSeconds:1}).run();
 });
 const server=createServer(getRequestListener(f.root.http.fetch));await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));clean.push(async()=>{server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));});
 const address=server.address();if(!address||typeof address==='string')throw Error('No worker listener');const url='http://127.0.0.1:'+address.port;
 const sent=await fetch(url+'/api/comms/send',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{thread:f.thread.id,words:'PRIVATE WORKER INPUT',clientId:'worker-input'},id:'worker-send'})});expect(sent.status).toBe(200);f.clock.advance(1000);
 const abort=new AbortController();clean.push(()=>abort.abort());
 const control=httpWorkerControl({url,token:raw.runner,signal:abort.signal});
 const enroll=control.enrollBody!;let owned:Uint8Array|undefined,tokenCopy:Buffer|undefined;
 clean.push(()=>{tokenCopy?.fill(0);});
 control.enrollBody=async(...args)=>{const result=await enroll(...args);owned=result.token;tokenCopy=Buffer.from(result.token);expect(f.db.select().from(s.jobs).get()?.state).toBe('starting');return result;};
 let acknowledged=false;const started=control.started.bind(control);control.started=async(...args)=>{expect(f.db.select().from(s.jobs).get()?.state).toBe('starting');await started(...args);expect(f.db.select().from(s.jobs).get()?.state).toBe('running');acknowledged=true;};
 const finish=vi.spyOn(control,'finish');
 const ended=new WeakSet<ChildProcessWithoutNullStreams>(),aborts=new WeakMap<ChildProcessWithoutNullStreams,AbortController>();
 const native=claudeBody({command:'/fake/claude',cwd:'/work',env:{},spawn:(_command,args)=>{
  const events=new EventEmitter();let words='';const child=Object.assign(events,{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(()=>true),stdin:new Writable({write(chunk,_encoding,done){words+=chunk.toString();done();},final(done){done();queueMicrotask(()=>{
   expect(words).toBe('PRIVATE WORKER INPUT');expect(args[args.indexOf('--model')+1]).toBe('requested-model');child.stderr.emit('data',Buffer.from('PRIVATE NATIVE DIAGNOSTIC'));nativeReply(child,args);
  });}})})as unknown as ChildProcessWithoutNullStreams;return child;
 }});
 // Keep the scenario assertions separate from provider stream plumbing.
 const exerciseTempo=async(command:(operation:string,input:unknown,id:string)=>Promise<unknown>,query:(input:Record<string,unknown>)=>Promise<unknown>)=>{
  const who={kind:'person' as const,id:'alice'},timing=()=>f.root.services.tempo.volume.timings(who);
  const answer=async(id:string,allow:boolean)=>{
   const result=await fetch(url+'/api/approvals/answer',{method:'POST',redirect:'error',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{id,answer:allow?'allow':'deny'}})});
   expect(result.status).toBe(200);expect(await result.json()).toEqual({ok:true,value:{id}});
  };
  const cardSelection='query Card($id:String!){approvals(where:{id:{eq:$id}},limit:1){id state details changeSummary}}';
  const readCard=async(id:string)=>{const response=await fetch(url+'/graphql',{method:'POST',redirect:'error',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:cardSelection,variables:{id}})});expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data.approvals;};
  expect(timing()).toEqual({settleSeconds:5,dimDays:3,muteDays:9});
  for(const [seconds,allow]of [[60,true],[120,false]]as const){
   const before=timing(),after={...before,settleSeconds:seconds},result=await command('household.propose',{change:'tempoTimings',input:{who,settleSeconds:seconds},why:'Requested in this conversation'},randomUUID());
   expect(result).toEqual({ok:true,value:{id:expect.any(String),state:'pending'}});
   const id=(result as {value:{id:string}}).value.id,card=f.db.select().from(s.approvals).where(eq(s.approvals.id,id)).get()!;
   expect(card).toMatchObject({kind:'setting',operation:'household.change',state:'pending',conversation:f.thread.conversation,actingFor:'alice',member:'alice',ask:'Change Tempo timings for person alice?'});
   expect(JSON.parse(card.details!)).toEqual({change:'tempoTimings',before:{settleSeconds:before.settleSeconds,who},after:{settleSeconds:after.settleSeconds,who}});
   expect(card.changeSummary).toContain('Tempo timings for person alice');
   expect(timing()).toEqual(before);
   expect(await readCard(id)).toEqual([{id,state:'pending',details:card.details,changeSummary:card.changeSummary}]);
   // Filing a private card gives the body no generic read of a person's records.
   expect(await query({query:cardSelection,variables:{id}})).toMatchObject({data:{approvals:[]}});
   const question=f.db.select().from(s.inbox).all().find(item=>item.toKind==='person'&&item.to==='alice'&&item.source==='approval'&&item.waitsOnId===id)!;
   expect(question).toMatchObject({conversation:f.thread.conversation});
   await answer(id,allow);expect(timing()).toEqual({settleSeconds:60,dimDays:3,muteDays:9});
   expect(await readCard(id)).toEqual([{id,state:allow?'used':'denied',details:card.details,changeSummary:card.changeSummary}]);
   const returned=f.db.select().from(s.inbox).all().filter(item=>item.source==='answer'&&item.sourceId===question.id);
   expect(returned).toEqual([expect.objectContaining({toKind:'agent',to:'art',conversation:f.thread.conversation,fromKind:'person',fromId:'alice',words:expect.stringContaining(allow?'Allow':'Deny')})]);
  }
  expect(f.db.select().from(s.approvals).all()).toHaveLength(2);
  const id='native-'+randomUUID();
  expect(await command('tempo.set',{id,ownerKind:'agent',owner:'art',sourceKind:'time',times:new Date(f.clock.now()+3600000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Ordinary native Tempo work',note:'Native read variant'},randomUUID())).toMatchObject({ok:true,value:{id}});
  const selection={query:'query NativeTrigger($id:String!){tempoTimezone triggers(where:{id:{eq:$id}},limit:1){id ownerKind owner state enabled}}',variables:{id}};
  expect(await query(selection)).toMatchObject({data:{tempoTimezone:expect.any(String),triggers:[{id,ownerKind:'agent',owner:'art',state:'standing',enabled:true}]}});
  expect(await command('tempo.stop',{id},randomUUID())).toMatchObject({ok:true});
  expect(await query(selection)).toMatchObject({data:{triggers:[{id,ownerKind:'agent',owner:'art',state:'stopped',enabled:false}]}});
 };
 // The Tempo variant retains bodyProgram's default factory and Claude adapter.
 // Only its provider process is mocked; MCP and Root remain real loopback HTTP.
 let nativeFailure:unknown,nativeActions=0,nativeEndpoint:string|undefined;
 if(variant==='tempo')vi.mocked(spawn).mockImplementation((command,args,options)=>{
  let allowed:readonly string[];
  try{
   expect(command).toBe('/bin/bash');expect(args[args.indexOf('--model')+1]).toBe('requested-model');expect(args).toContain('--strict-mcp-config');expect(args[args.indexOf('--setting-sources')+1]).toBe('');expect(args[args.indexOf('--mcp-config')+1]).toBe('/dev/fd/3');expect(args[args.indexOf('--permission-mode')+1]).toBe('dontAsk');expect(options.stdio).toEqual(['pipe','pipe','pipe','pipe']);
   const start=args.indexOf('--allowedTools');expect(start).toBeGreaterThan(-1);const end=args.findIndex((value,index)=>index>start&&value.startsWith('--'));allowed=args.slice(start+1,end<0?undefined:end);
   expect(allowed).toEqual(expect.arrayContaining(['mcp__loom_secrets__loom_commands','mcp__loom_secrets__loom_command','mcp__loom_secrets__loom_query']));
  }catch(error){nativeFailure=error;throw error;}
  const actions:{name:string;input:Record<string,unknown>}[]=[];
  let words='',connection:{url:string;headers:Record<string,string>}|undefined,started=false,inputEnded=false;
  const execute=()=>{if(started||!inputEnded||!connection)return;started=true;void(async()=>{
   const protocol=new Client({name:'tempo-native-fixture',version:'1'},{capabilities:{}});
   try{
    expect(words).toBe('PRIVATE WORKER INPUT');expect(acknowledged).toBe(true);
    expect(f.db.select().from(s.inbox).where(eq(s.inbox.source,'thread')).get()?.state).toBe('done');
    await protocol.connect(new StreamableHTTPClientTransport(new URL(connection!.url),{requestInit:{headers:connection!.headers}}));
    const tools=(await protocol.listTools()).tools;
    expect(tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['request_secret','use_secret']));
    expect(tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['loom_commands','loom_command','loom_query']));
    const decoded=(value:unknown)=>JSON.parse((value as {content:{text:string}[]}).content[0].text);
    const call=async(name:string,input:Record<string,unknown>)=>{expect(allowed).toContain('mcp__loom_secrets__'+name);actions.push({name,input});const result=decoded(await protocol.callTool({name,arguments:input}));if(name==='loom_query')expect(result.errors).toBeUndefined();return result;};
    const catalogue=await call('loom_commands',{});
    expect(catalogue.ok).toBe(true);
    expect(catalogue.value.commands.map((entry:{name:string})=>entry.name)).toEqual(expect.arrayContaining(['tempo.set','tempo.stop','tempo.runNow','tempo.pause','tempo.resume','household.propose','inbox.volume']));
    await exerciseTempo((operation,input,id)=>call('loom_command',{operation,input,id}),input=>call('loom_query',input));
   }finally{await protocol.close();}
  })().then(()=>{nativeActions=actions.length;nativeReply(child,args,actions);
  },error=>{nativeFailure=error;child.emit('close',1,null);});};
  const controlPipe=new Writable({write(bytes,_encoding,done){const servers=JSON.parse(bytes.toString()).mcpServers;expect(Object.keys(servers)).toEqual(['loom_secrets']);connection=servers.loom_secrets as NonNullable<typeof connection>;nativeEndpoint=connection.url;done();},final(done){done();execute();}});
  const stdin=new Writable({write(bytes,_encoding,done){words+=bytes.toString();done();},final(done){done();inputEnded=true;execute();}});
  const child=Object.assign(new EventEmitter(),{stdin,stdout:new PassThrough(),stderr:new PassThrough(),stdio:[stdin,null,null,controlPipe],kill:vi.fn(()=>{child.emit('close',null);return true;})}) as unknown as ChildProcessWithoutNullStreams;
  return child;
 });
 const runtime:ProcessRuntime={spawn(plan){
  const events=new EventEmitter(),parts:Buffer[]=[],bodyAbort=new AbortController();let child:ChildProcessWithoutNullStreams;
  const execute=async()=>{const bytes=Buffer.concat(parts);for(const part of parts)part.fill(0);
   try{
    if(plan.command==='/fake/build'){const value=JSON.parse(bytes.toString());expect(value).toEqual({job:expect.any(String),house:{repository:'fixture',file:'Housefile',branch:'next'}});child.stdout.emit('data',Buffer.from('{"build":"fixture-image"}'));return 0;}
    expect(acknowledged).toBe(true);expect(plan.command).toBe('/fake/recipient');
    if(harness==='claude')return await bodyProgram({args:['body.json'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/work'}),stdin:async()=>bytes,env:{},signal:bodyAbort.signal,clock:f.clock,schedule:{every:()=>()=>{}},...(variant==='tempo'?{}:{native}),error:()=>{}});
    const input=JSON.parse(bytes.toString());expect(input.job.brief).toBe('');expect(input.bootstrap.job).toBe(input.job.id);const client=bodyConversationClient({url:input.bootstrap.origin,token:input.bootstrap.token,job:input.job.id,conversation:input.job.conversation,signal:bodyAbort.signal,clock:f.clock});
    try{await client.status({state:'working',work:'Reading fictitious input'});const batch=await client.takeAndAccept(async(item,signal)=>{expect(signal.aborted).toBe(false);expect(item.words).toBe('PRIVATE WORKER INPUT');});expect(batch.accepted).toBe(1);
     const reply=await client.reply({clientId:'reply',words:'PRIVATE WORKER REPLY',model:'fixture-actual-model',outcome:'answered',latencyMs:23});await client.finding({turnSeq:reply.seq,measure:'useful',score:4,text:'Fictitious comparison was useful'});await client.digest({summary:'Completed fictitious worker input',items:[]});await client.status({state:'idle',work:'Fictitious work complete'});child.stdout.emit('data',Buffer.from(input.bootstrap.token+'PRIVATE WORKER INPUT'));child.stderr.emit('data',Buffer.from(input.bootstrap.token+'PRIVATE WORKER INPUT'));return 0;
    }finally{client.close();}
   }finally{bytes.fill(0);}
  };
  child=Object.assign(events,{pid:123,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new Writable({write(chunk,_encoding,done){parts.push(Buffer.from(chunk));done();},final(done){done();queueMicrotask(()=>{void execute().then(code=>{ended.add(child);child.emit('close',code,null);},error=>{ended.add(child);child.emit('error',error);child.emit('close',1,null);});});}})})as unknown as ChildProcessWithoutNullStreams;
  aborts.set(child,bodyAbort);queueMicrotask(()=>child.emit('spawn'));return child;
 },kill(child){aborts.get(child)?.abort();if(!ended.has(child)){ended.add(child);child.emit('close',null,'SIGKILL');}}};
 const plan={command:'/fake/build',args:[],cwd:'/work',env:{}};
 const executor=commandWorkerExecutor({build:plan,runners:{[harness]:{...plan,command:'/fake/recipient',bodyBootstrap:true}}},runtime);
 // Retain the production executor; observe its exact release boundary against the real ACK.
 const start=executor.start.bind(executor);executor.start=(...args)=>{const body=start(...args),release=body.release.bind(body);body.release=(...input)=>{expect(acknowledged).toBe(true);return release(...input);};return body;};
 const running=workOnce({box:'box',control,executor,signal:abort.signal,schedule:{every:()=>()=>{}}});clean.push(async()=>{abort.abort();await running.catch(()=>{});});
 const outcome=await running;if(nativeFailure)throw nativeFailure;expect(outcome).toBe('finished');
 if(variant==='tempo'){
  expect(spawn).toHaveBeenCalledOnce();expect(nativeActions).toBeGreaterThan(0);
  expect(f.root.services.tempo.volume.timings({kind:'person',id:'alice'})).toEqual({settleSeconds:60,dimDays:3,muteDays:9});
  expect(f.db.select().from(s.approvals).all().map(row=>row.state)).toEqual(['used','denied']);
  expect(nativeEndpoint).toBeDefined();await expect(fetch(nativeEndpoint!)).rejects.toThrow();
 }
 const job=f.db.select().from(s.jobs).get()!;
 expect(job).toMatchObject({state:'done',brief:'',logTail:null,exitCode:0,build:'fixture-image'});expect(finish).toHaveBeenCalledExactlyOnceWith(job.id,0,'');expect(owned?.every(byte=>byte===0)).toBe(true);
 // The callback pause before confirmation is independently asserted by the receiving-program proof.
 expect(f.db.select().from(s.inbox).get()).toMatchObject({state:'done',toKind:'agent',to:'art',job:job.id});expect(f.db.select().from(s.messages).all().map(row=>row.delivery)).toEqual(['delivered',null]);
expect(f.db.select().from(s.turns).all()).toMatchObject([{kind:'message',fromKind:'person'},...Array.from({length:nativeActions},()=>({kind:'action',run:job.id,model:'fixture-actual-model',outcome:'progressed'})),{kind:'reply',run:job.id,model:'fixture-actual-model',outcome:harness==='fixture'?'answered':'progressed',...(harness==='fixture'?{latencyMs:23}:{})}]);expect(f.db.select().from(s.conversations).get()).toMatchObject({job:null,turnCount:2+nativeActions});
 if(harness==='fixture')expect(f.db.select().from(s.digests).get()).toMatchObject({run:job.id,revision:1,summary:'Completed fictitious worker input'});
 else expect(f.db.select().from(s.digests).all()).toMatchObject([{conversation:f.thread.conversation,run:job.id,revision:1,summary:'Completed this stretch of work.',inboxItem:null}]);
 expect(f.db.select().from(s.agentStatus).get()).toMatchObject({state:'idle',work:''});
 if(harness==='fixture')expect(f.db.select().from(s.findings).get()).toMatchObject({conversation:f.thread.conversation,turnSeq:2,day:new Date(f.clock.now()).toISOString().slice(0,10),measure:'useful',score:4,text:'Fictitious comparison was useful'});else expect(f.db.select().from(s.findings).all()).toEqual([]);
 const messages=f.db.select().from(s.messages).all();expect(await Promise.all(messages.map(row=>f.key.open(row.words!)))).toEqual(['PRIVATE WORKER INPUT','PRIVATE WORKER REPLY']);
 expect(tokenCopy).toBeDefined();const token=tokenCopy!.toString();expect(f.db.select().from(s.tokens).where(eq(s.tokens.fingerprint,hash(token))).get()).toMatchObject({job:job.id,madeFrom:hash(raw.runner)});
 const denied=await fetch(url+'/api/conversation/status',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:{state:'working',work:''},id:'ended'})});expect(denied.status).toBe(401);
 const durable=f.db.$client.serialize();for(const value of [token,'PRIVATE WORKER INPUT','PRIVATE WORKER REPLY','PRIVATE NATIVE DIAGNOSTIC'])expect(durable.includes(Buffer.from(value))).toBe(false);
},20000);
