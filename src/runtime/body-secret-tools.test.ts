import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {eq} from 'drizzle-orm';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {bodyFixture,bodyCredentials as raw} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
import {request as httpRequest} from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {bodyProgram} from './body-program.js';
import type {WorkerAssignment} from './worker.js';
import {bodySecretTools} from './body-secret-tools.js';
vi.mock('node:crypto',async()=>{const actual=await vi.importActual<typeof import('node:crypto')>('node:crypto');return{...actual,randomBytes:vi.fn(actual.randomBytes)};});
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();vi.clearAllMocks();});
const privateValue='PRIVATE_TOOL_CREDENTIAL';
async function rootFixture(answer:'auto'|'ask'|'never'='auto',expected=Buffer.from(privateValue)){
 const buffers:Buffer[]=[],source=vi.fn(async():Promise<Buffer>=>{expect(f.db.$client.inTransaction).toBe(false);expect(f.db.select().from(s.secretUses).get()?.state).toBe('started');const value=Buffer.from(expected);buffers.push(value);return value;});
 const f=await bodyFixture(clean,{secretInputs:{source:{read:source}}});
 f.root.writes.run(()=>{
  f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
  f.db.insert(s.secrets).values({name:'TOKEN',description:'Synthetic',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();f.db.insert(s.secretChanges).values({id:'baseline',secret:'TOKEN',action:'add',by:'alice',at:new Date(f.clock.now()).toISOString()}).run();
  f.root.services.secrets.requests.setRule({secret:'TOKEN',answer,minutes:5,agents:[{agent:'art',when:'on_request'}]});
 });
 const abort=new AbortController(),waiting=vi.fn(),fetcher=vi.fn<typeof fetch>(async(url,init)=>f.root.http.request(new Request(url,init)));
 return{...f,buffers,source,abort,waiting,fetcher};
}
async function fixture(answer:'auto'|'ask'|'never'='auto',expected=Buffer.from(privateValue)){
 const f=await rootFixture(answer,expected),{buffers,source,abort,waiting,fetcher}=f;
 const tools=await bodySecretTools({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:abort.signal,clock:f.clock,fetch:fetcher,waiting});clean.push(()=>tools.close());
 const config=JSON.parse(tools.config.toString()).mcpServers.loom as {url:string;headers:Record<string,string>};
 const client=new Client({name:'fictitious-native',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));clean.push(()=>client.close());
 const request=(id=randomUUID())=>client.callTool({name:'request_secret',arguments:{id,secret:'TOKEN',why:'Synthetic credential use',minutes:5}});
 const use=(request?:string,id=randomUUID())=>client.callTool({name:'use_secret',arguments:{id,secret:'TOKEN',...(request?{request}:{})}});
 return{...f,buffers,source,abort,waiting,fetcher,tools,config,client,request,use};
}
function text(result:Awaited<ReturnType<Client['callTool']>>){return z.object({content:z.array(z.object({type:z.literal('text'),text:z.string()})).min(1)}).passthrough().parse(result).content[0].text;}
it.each([Buffer.from(privateValue),Buffer.from('PRIVATE_BINARY_\0ÿé')])('exposes only two private tools and preserves granted bytes %j, confirming before return',async expected=>{
 const f=await fixture('auto',expected),copies:Buffer[]=[],concat=Buffer.concat;vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const bytes=concat(list,total);if(bytes.equals(expected))copies.push(bytes);return bytes;});expect((await f.client.listTools()).tools.map(tool=>tool.name)).toEqual(['request_secret','use_secret']);expect(f.tools.config.includes(Buffer.from(raw.body))).toBe(false);expect(f.source).not.toHaveBeenCalled();
 const id=randomUUID(),request=await f.request(id);expect(JSON.parse(text(request))).toEqual({id,state:'allowed'});
 const value=await f.use(id);expect(JSON.parse(text(value))).toEqual({encoding:'base64',value:expected.toString('base64')});expect(copies.length).toBeGreaterThan(0);expect(copies.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(f.source).toHaveBeenCalledOnce();expect(f.buffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(f.db.select().from(s.secretUses).get()).toMatchObject({agent:'art',job:'job',state:'released'});
 expect(f.db.$client.serialize().includes(expected)).toBe(false);expect(f.db.$client.serialize().includes(Buffer.from(raw.body))).toBe(false);
});
it('waits on owner consent using metadata, then returns only after the existing private confirmation',async()=>{
 const f=await fixture('ask'),id=randomUUID();expect(JSON.parse(text(await f.request(id))).state).toBe('pending');let armed!:()=>void;const scheduled=new Promise<void>(resolve=>{armed=resolve;}),at=f.clock.at.bind(f.clock);
 vi.spyOn(f.clock,'at').mockImplementation((time,work)=>{if(time===f.clock.now()+1000)armed();return at(time,work);});
 const pending=f.use(id);await scheduled;expect(f.source).not.toHaveBeenCalled();expect(f.waiting).toHaveBeenLastCalledWith(true);
 f.root.writes.run(()=>f.root.services.secrets.requests.answer(id,'alice',true));f.clock.advance(1000);expect(JSON.parse(text(await pending)).encoding).toBe('base64');expect(f.waiting).toHaveBeenLastCalledWith(false);expect(f.db.select().from(s.secretUses).get()?.state).toBe('released');
});
it('does not acquire a value after a Never decision and sanitizes tool errors',async()=>{
 const f=await fixture('never'),id=randomUUID();expect(JSON.parse(text(await f.request(id))).state).toBe('denied');const result=await f.use(id);expect(result.isError).toBe(true);expect(text(result)).not.toContain(privateValue);expect(text(result)).not.toContain(raw.body);expect(f.source).not.toHaveBeenCalled();expect(f.db.select().from(s.secretUses).all()).toEqual([]);
});
it('refuses unauthenticated local calls and does not accept the Root bearer as its local capability',async()=>{
 const f=await fixture();for(const token of ['',raw.body]){const response=await fetch(f.config.url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/list'})});expect(response.status).toBe(403);}expect(f.fetcher).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();
});
it('does not redispatch a value when the same handoff attempt is repeated',async()=>{
 const f=await fixture(),request=randomUUID(),attempt=randomUUID();await f.request(request);expect((await f.use(request,attempt)).isError).not.toBe(true);expect((await f.use(request,attempt)).isError).toBe(true);expect(f.source).toHaveBeenCalledOnce();expect(f.db.select().from(s.secretUses).all()).toHaveLength(1);
});
it('cancels a pending decision at body shutdown without a value read or a live local capability',async()=>{
 const f=await fixture('ask'),id=randomUUID();await f.request(id);let armed!:()=>void;const scheduled=new Promise<void>(resolve=>{armed=resolve;}),at=f.clock.at.bind(f.clock);vi.spyOn(f.clock,'at').mockImplementation((time,work)=>{if(time===f.clock.now()+1000)armed();return at(time,work);});
 const pending=f.use(id),ended=pending.catch(()=>undefined);await scheduled;f.abort.abort();await f.tools.close();await ended;expect(f.source).not.toHaveBeenCalled();expect(f.tools.config.every(byte=>byte===0)).toBe(true);expect(f.waiting).toHaveBeenLastCalledWith(false);
});
it.each(['allow','stop','leak-text','leak-base64'] as const)('uses the default native private pipe and real model tools while the owner decides: %s',async decision=>{
 const f=await rootFixture('ask'),token='body_'+'f'.repeat(64),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 f.root.writes.run(()=>{f.db.delete(s.tokens).where(eq(s.tokens.job,'job')).run();f.db.insert(s.tokens).values({fingerprint:hash(token),label:'Native fixture',kind:'agent',agent:'art',job:'job',createdAt:new Date(f.clock.now()).toISOString()}).run();f.db.update(s.jobs).set({model:'requested',harness:'claude'}).where(eq(s.jobs.id,'job')).run();});
 expect((await f.send('Use the requested credential without repeating it','native-tools')).status).toBe(200);
 const job:WorkerAssignment={id:'job',agent:'art',box:'box',conversation:f.thread.conversation,thread:f.thread.id,venue:'loom',model:'requested',account:'account',harness:'claude',brief:'',house:{repository:'fixture',file:'HOUSE.md',branch:'next'},
  // The room loom's dispatcher hands with a job on its owners' word. With none, the body is held to loom's tools and is served no secret tool.
  run:{nestedContainers:false,gpu:false,ports:[],policy:{people:[{kind:'person',person:'alice',tier:null}],deniedTools:[],word:'owners'}}};
 let tick!:()=>void,armed!:()=>void,actorEnded!:()=>void,failure:unknown,killed=false;const waiting=new Promise<void>(resolve=>{armed=resolve;}),actorDone=new Promise<void>(resolve=>{actorEnded=resolve;}),cancel=vi.fn(),at=f.clock.at.bind(f.clock);
 vi.spyOn(f.clock,'at').mockImplementation((time,work)=>{if(time===f.clock.now()+1000)armed();return at(time,work);});
 const pipeBuffers:Buffer[]=[];
 vi.mocked(spawn).mockImplementation((_command,args,options)=>{
  expect(args[args.indexOf('--mcp-config')+1]).toBe('/dev/fd/3');expect(JSON.stringify({args,options})).not.toContain(token);if(decision!=='allow')expect(args).toContain('mcp__loom__use_secret');expect(options.env).toMatchObject({MCP_TOOL_TIMEOUT:'86400000',CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT:'86400000'});
  let config:Record<string,{url:string;headers:Record<string,string>;timeout:number}>|undefined,words='',ended=false,started=false;
  const control=new Writable({write(bytes,_encoding,done){pipeBuffers.push(bytes);config=JSON.parse(bytes.toString()).mcpServers;expect(bytes.includes(Buffer.from(token))).toBe(false);done();}}),stdin=new Writable({write(bytes,_encoding,done){words+=bytes.toString();done();}});
  const child=Object.assign(new EventEmitter(),{stdin,stdout:new PassThrough(),stderr:new PassThrough(),stdio:[stdin,null,null,control],kill:vi.fn(()=>{killed=true;child.emit('close',null);return true;})}) as unknown as ChildProcessWithoutNullStreams;
  const start=()=>{if(started||!ended||!config)return;started=true;void(async()=>{
   expect(config!.loom).toMatchObject({timeout:86_400_000});
   const protocol=new Client({name:'native-model-fixture',version:'1'},{capabilities:{}}),connection=config!.loom;
   try{
    expect(words).toMatch(/approvals\.answer[\s\S]*\n\nUse the requested credential without repeating it$/);expect(f.db.select().from(s.inbox).where(eq(s.inbox.source,'thread')).get()?.state).toBe('taken');
    await protocol.connect(new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:connection.headers}}));
    const request=randomUUID();expect(JSON.parse(text(await protocol.callTool({name:'request_secret',arguments:{id:request,secret:'TOKEN',why:'Use it privately',minutes:5}}))).state).toBe('pending');
    const result=await protocol.callTool({name:'use_secret',arguments:{id:randomUUID(),secret:'TOKEN',request}},undefined,{timeout:Number(options.env?.MCP_TOOL_TIMEOUT)});if(killed)return;expect(JSON.parse(text(result)).value).toBe(Buffer.from(privateValue).toString('base64'));expect(f.db.select().from(s.secretUses).get()?.state).toBe('released');
    const reply=decision==='leak-text'?privateValue:decision==='leak-base64'?Buffer.from(privateValue).toString('base64'):'Used the credential privately';
    if(decision==='allow'){
     const {houseRuntimeCli}=await import('../house-runtime-cli.js');
     let out='',loseReply=true;
     const deliver=f.fetcher.getMockImplementation()!;
     f.fetcher.mockImplementation(async(url,init)=>{
      const response=await deliver(url,init);
      if(loseReply&&String(url).endsWith('/api/conversation/message')){
       expect(response.status).toBe(200);
       loseReply=false;
       return Response.json({});
      }
      return response;
     });
     expect(await houseRuntimeCli(['send','--conversation',f.thread.conversation,'--text',reply],{stdout:s=>{out+=s;},stderr(){}},options.env)).toBe(1);
     expect(JSON.parse(out).unconfirmed).toBe(true);
     expect(await houseRuntimeCli(['send','--conversation',f.thread.conversation,'--text','Separate progress update'],{stdout(){},stderr(){}},options.env)).toBe(0);
    }
    const list=args as string[],session=list[list.indexOf('--session-id')+1];child.stdout.emit('data',Buffer.from([{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed',content:[{type:'text',text:reply}]}},{type:'result',session_id:session,is_error:false,subtype:'success',result:reply}].map(row=>JSON.stringify(row)).join('\n')));child.emit('close',0);
   }finally{await protocol.close();}
  })().catch(error=>{if(!killed){failure=error;child.emit('close',1);}}).finally(actorEnded);};
  control.once('finish',start);stdin.once('finish',()=>{ended=true;start();});return child;
 });
 const bytes=Buffer.from(JSON.stringify({job,build:'image',bootstrap:{origin:'https://loom.invalid',job:'job',token}})),errors=vi.fn();
 const running=bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/house',reach:decision==='allow'?'all':'loom'}),stdin:async()=>bytes,env:{ACCOUNT_PROFILE:'/account',LOOM_BODY_OWN_HARNESS:'0'},signal:f.abort.signal,clock:f.clock,fetch:f.fetcher,schedule:{every:(_ms,callback)=>{tick=callback;return cancel;}},error:errors});
 expect(await Promise.race([waiting.then(()=>true),running.then(()=>false)])).toBe(true);expect(f.source).not.toHaveBeenCalled();
 if(decision!=='stop'){
  let published!:()=>void;const waitingStatus=new Promise<void>(resolve=>{published=resolve;}),unobserve=f.root.writes.observe(()=>{if(f.db.select().from(s.agentStatus).get()?.state==='waiting')published();});tick();await waitingStatus;unobserve();expect(f.db.select().from(s.threads).get()?.working).toBe(true);
  const request=f.db.select().from(s.secretRequests).get()!;f.root.writes.run(()=>f.root.services.secrets.requests.answer(request.id,'alice',true));f.clock.advance(1000);
 }else{f.root.writes.run(()=>f.root.services.comms!.threads.requestStop(f.thread.id));tick();}
 expect(await running).toBe(decision.startsWith('leak-')?14:decision==='stop'?10:0);await actorDone;if(failure)throw failure;expect(errors).toHaveBeenCalledTimes(decision.startsWith('leak-')?1:0);expect(cancel).toHaveBeenCalledOnce();expect(bytes.every(byte=>byte===0)).toBe(true);expect(pipeBuffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(f.db.$client.serialize().includes(Buffer.from(token))).toBe(false);expect(f.db.$client.serialize().includes(Buffer.from(privateValue))).toBe(false);
 if(decision==='allow')expect(f.db.select().from(s.messages).where(eq(s.messages.sender,'art')).all()).toHaveLength(2);
 if(decision!=='stop'){expect(f.source).toHaveBeenCalledOnce();expect(f.db.select().from(s.secretUses).get()?.state).toBe('released');expect(f.db.select().from(s.turns).all().filter(row=>row.kind==='reply')).toMatchObject(decision.startsWith('leak-')?[]:[{model:'observed',run:'job'}]);}else{expect(f.source).not.toHaveBeenCalled();expect(f.db.select().from(s.secretUses).all()).toEqual([]);
  // The body leaves the Stop for loom to take when the worker next reports this job.
  expect(f.db.select().from(s.threads).get()?.stopRequested).toBe(true);}
});
it('rejects browser-origin requests even with the local capability, and refuses caller-selected principals',async()=>{
 const f=await fixture();const denied=await fetch(f.config.url,{method:'POST',headers:{...f.config.headers,origin:'https://untrusted.invalid','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/list'})});expect(denied.status).toBe(403);
 await f.client.callTool({name:'use_secret',arguments:{id:randomUUID(),secret:'TOKEN',job:'other',agent:'mark'}}).catch(()=>undefined);expect(f.fetcher).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();
});
it('does not return private source diagnostics in a model tool result',async()=>{
 const f=await fixture(),id=randomUUID();await f.request(id);f.source.mockRejectedValue(new Error(privateValue+' '+raw.body));const result=await f.use(id);expect(result.isError).toBe(true);expect(text(result)).not.toContain(privateValue);expect(text(result)).not.toContain(raw.body);expect(f.db.select().from(s.secretUses).get()?.state).toBe('failed');
});
it('cancels only the disconnected model call, erases its late source, and keeps the body-local server alive',async()=>{
 const f=await fixture(),id=randomUUID();await f.request(id);let entered!:()=>void,release!:(value:Buffer)=>void,aborted!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),cancelled=new Promise<void>(resolve=>{aborted=resolve;});
 f.source.mockImplementation(()=>{entered();return new Promise<Buffer>(resolve=>{release=resolve;});});const fetcher=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation((url,init)=>{if(String(url).endsWith('/private/read'))init?.signal?.addEventListener('abort',aborted,{once:true});return fetcher(url,init);});
 const pending=f.use(id),ended=pending.catch(()=>undefined);await started;await f.client.close();await cancelled;await ended;expect(f.abort.signal.aborted).toBe(false);
 const next=new Client({name:'reconnected-native',version:'1'},{capabilities:{}});await next.connect(new StreamableHTTPClientTransport(new URL(f.config.url),{requestInit:{headers:f.config.headers}}));clean.push(()=>next.close());expect((await next.listTools()).tools).toHaveLength(2);
 const late=Buffer.from('PRIVATE_LATE_SOURCE');release(late);await f.tools.close();await f.root.services.secrets.inputs.close();expect(late.every(byte=>byte===0)).toBe(true);expect(f.db.select().from(s.secretUses).get()?.state).toBe('failed');
});

it('rejects a wrong HTTP authority and oversized JSON before Root access',async()=>{
 const f=await fixture(),headers={...f.config.headers,'content-type':'application/json',accept:'application/json, text/event-stream'};
 const wrong=await new Promise<number|undefined>((resolve,reject)=>{const call=httpRequest(f.config.url,{method:'POST',headers:{...headers,host:'wrong.invalid'}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});call.once('error',reject);call.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}));});expect(wrong).toBe(403);
 const huge=await fetch(f.config.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',padding:'x'.repeat(1_048_576)})});expect(huge.ok).toBe(false);expect(f.fetcher).not.toHaveBeenCalled();
});
it('bounds admitted MCP requests while sixteen tools wait for owner consent',async()=>{
 const f=await fixture('ask'),id=randomUUID();await f.request(id);let armed!:()=>void,count=0;const saturated=new Promise<void>(resolve=>{armed=resolve;}),at=f.clock.at.bind(f.clock);
 vi.spyOn(f.clock,'at').mockImplementation((time,work)=>{if(time===f.clock.now()+1000&&++count===16)armed();return at(time,work);});
 const calls=Array.from({length:16},()=>f.use(id).catch(()=>undefined));await saturated;
 const refused=await fetch(f.config.url,{method:'POST',headers:{...f.config.headers,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/list'})});expect(refused.status).toBe(429);expect(count).toBe(16);expect(f.source).not.toHaveBeenCalled();await f.tools.close();await Promise.all(calls);
});

it('erases random capability bytes and each received authorization buffer',async()=>{
 const f=await fixture(),entropy=vi.mocked(randomBytes).mock.results.filter(result=>result.type==='return').map(result=>result.value as unknown).filter((value):value is Buffer=>Buffer.isBuffer(value));expect(entropy.length).toBeGreaterThan(0);expect(entropy.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
 const from=vi.spyOn(Buffer,'from');await f.client.listTools();
 const captured=from.mock.calls.flatMap((args,index)=>args[0]===f.config.headers.Authorization&&from.mock.results[index].type==='return'?[from.mock.results[index].value]:[]);expect(captured.length).toBeGreaterThan(0);expect(captured.every(bytes=>Buffer.isBuffer(bytes)&&bytes.every(byte=>byte===0))).toBe(true);
});
it('serves a body held to loom\'s tools no secret tool, and lists none for its harness',async()=>{
 const f=await rootFixture(),held=await bodySecretTools({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:f.abort.signal,clock:f.clock,fetch:f.fetcher,secrets:false});clean.push(()=>held.close());
 expect(held.allowedTools).toEqual([]);
 const config=JSON.parse(held.config.toString()).mcpServers.loom as {url:string;headers:Record<string,string>};
 const client=new Client({name:'fictitious-native',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));clean.push(()=>client.close());
 const refused=await client.callTool({name:'use_secret',arguments:{id:randomUUID(),secret:'TOKEN'}}).catch(()=>({isError:true}));expect(refused.isError).toBe(true);
 const asked=await client.callTool({name:'request_secret',arguments:{id:randomUUID(),secret:'TOKEN',why:'Synthetic credential use',minutes:5}}).catch(()=>({isError:true}));expect(asked.isError).toBe(true);
 expect(f.source).not.toHaveBeenCalled();expect(f.db.select().from(s.secretRequests).all()).toEqual([]);
});
it('lets no secret the body was handed leave in a tool call: one it used, or one it was started with',async()=>{
 const f=await rootFixture(),sent:unknown[]=[],startup=Buffer.from('STARTUP_SECRET_VALUE');
 const post={name:'loom_command',description:'Synthetic command',inputSchema:z.object({operation:z.string(),input:z.json(),id:z.string()}).strict(),execute:async(args:Record<string,unknown>)=>{sent.push(args);return{content:[{type:'text' as const,text:'{"ok":true}'}]};}};
 const tools=await bodySecretTools({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:f.abort.signal,clock:f.clock,fetch:f.fetcher,extraTools:[post],alsoSecret:()=>[startup]});clean.push(()=>tools.close());
 const config=JSON.parse(tools.config.toString()).mcpServers.loom as {url:string;headers:Record<string,string>};
 const client=new Client({name:'fictitious-native',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));clean.push(()=>client.close());
 const say=(operation:string,words:string)=>client.callTool({name:'loom_command',arguments:{operation,input:{id:randomUUID(),text:words},id:randomUUID()}});
 expect((await say('bridges.say','Nothing private here')).isError).toBeFalsy();expect(sent).toHaveLength(1);
 // A startup secret's value, in a post.
 expect((await say('bridges.say','it is STARTUP_SECRET_VALUE, there')).isError).toBe(true);expect((await say('bridges.post','STARTUP_SECRET_VALUE')).isError).toBe(true);expect(sent).toHaveLength(1);
 expect(tools.allowsReply('the value STARTUP_SECRET_VALUE')).toBe(false);expect(tools.allowsReply('nothing')).toBe(true);
 // Nor in the reason it gives for asking for a secret, which goes to the owners' Inbox: `request_secret` is a tool call like any other.
 const why=await client.callTool({name:'request_secret',arguments:{id:randomUUID(),secret:'TOKEN',why:'I hold STARTUP_SECRET_VALUE already',minutes:5}});
 expect(why.isError).toBe(true);expect(f.db.select().from(s.secretRequests).all()).toEqual([]);
 // A secret it used, as its bytes and as the base64 it was handed.
 await client.callTool({name:'request_secret',arguments:{id:randomUUID(),secret:'TOKEN',why:'Synthetic credential use',minutes:5}});
 const used=JSON.parse(text(await client.callTool({name:'use_secret',arguments:{id:randomUUID(),secret:'TOKEN'}}))) as {value:string};
 expect((await say('bridges.say',`here: ${privateValue}`)).isError).toBe(true);expect((await say('bridges.post',used.value)).isError).toBe(true);expect(sent).toHaveLength(1);
});
