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
import * as s from '../core/data/schema.js';
import {bodyProgram} from './body-program.js';
import type {WorkerAssignment} from './worker.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();vi.clearAllMocks();});
function decoded(result:unknown){return JSON.parse((result as {content:{text:string}[]}).content[0].text);}
it.each(['finish','stop'] as const)('uses canonical tools and Secret delivery in the actual default body: %s',async mode=>{
 const privateValue='PRIVATE_CANONICAL_CREDENTIAL',sourceBuffers:Buffer[]=[],source=vi.fn(async()=>{const bytes=Buffer.from(privateValue);sourceBuffers.push(bytes);return bytes;}),f=await bodyFixture(clean,{secretInputs:{source:{read:source}}}),token='body_'+'e'.repeat(64);
 f.root.writes.run(()=>{
  f.db.delete(s.tokens).where(eq(s.tokens.job,'job')).run();f.db.insert(s.tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Fictional native',kind:'agent',agent:'art',job:'job',createdAt:new Date(f.clock.now()).toISOString()}).run();
  f.db.update(s.jobs).set({model:'requested',harness:'claude'}).where(eq(s.jobs.id,'job')).run();
  f.db.insert(s.secrets).values({name:'TOKEN',description:'Fictional credential',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();f.db.insert(s.secretChanges).values({id:'baseline',secret:'TOKEN',action:'add',by:'alice',at:new Date(f.clock.now()).toISOString()}).run();f.root.services.secrets.requests.setRule({secret:'TOKEN',answer:'auto',minutes:5,agents:[{agent:'art',when:'on_request'}]});
 });
 expect((await f.send('Use canonical tools privately','canonical')).status).toBe(200);
 const job:WorkerAssignment={id:'job',agent:'art',box:'box',conversation:f.thread.conversation,thread:f.thread.id,venue:'loom',model:'requested',account:'account',harness:'claude',brief:'',house:{repository:'fixture',file:'HOUSE.md',branch:'next'}};
 let tick!:()=>void,actorEnded!:()=>void,failure:unknown,killed=false,endpoint:{url:string;headers:Record<string,string>}|undefined;const done=new Promise<void>(resolve=>{actorEnded=resolve;}),cancel=vi.fn(),pipeBuffers:Buffer[]=[],statusInputs:unknown[]=[];
 vi.mocked(spawn).mockImplementation((_command,args,options)=>{
  for(const name of ['request_secret','use_secret','loom_commands','loom_command','loom_query'])expect(args).toContain('mcp__loom_secrets__'+name);expect(JSON.stringify({args,options})).not.toContain(token);
  let words='',ended=false,started=false;const control=new Writable({write(bytes,_encoding,next){pipeBuffers.push(bytes);endpoint=JSON.parse(bytes.toString()).mcpServers.loom_secrets;expect(bytes.includes(Buffer.from(token))).toBe(false);next();}}),stdin=new Writable({write(bytes,_encoding,next){words+=bytes.toString();next();}});
  const child=Object.assign(new EventEmitter(),{stdin,stdout:new PassThrough(),stderr:new PassThrough(),stdio:[stdin,null,null,control],kill:vi.fn(()=>{killed=true;child.emit('close',null);return true;})}) as unknown as ChildProcessWithoutNullStreams;
  const start=()=>{if(started||!ended||!endpoint)return;started=true;void(async()=>{
   const model=new Client({name:'fictional-native-model',version:'1'},{capabilities:{}});try{
    expect(words).toBe('Use canonical tools privately');await model.connect(new StreamableHTTPClientTransport(new URL(endpoint!.url),{requestInit:{headers:endpoint!.headers}}));
    expect((await model.listTools()).tools.map(tool=>tool.name)).toEqual(['request_secret','use_secret','loom_commands','loom_command','loom_query']);
    expect(decoded(await model.callTool({name:'loom_commands',arguments:{name:'secrets.request'}})).value.commands[0].name).toBe('secrets.request');
    expect(decoded(await model.callTool({name:'loom_query',arguments:{query:'{agents{id} members{id}}'}}))).toMatchObject({data:{agents:[{id:'art'}],members:[]}});
    const request=randomUUID();expect(decoded(await model.callTool({name:'loom_command',arguments:{operation:'secrets.request',input:{id:request,secret:'TOKEN',why:'Fictional private use',minutes:5,scope:'job'},id:request}}))).toEqual({ok:true,value:{id:request,state:'allowed'}});
    expect(decoded(await model.callTool({name:'use_secret',arguments:{id:randomUUID(),secret:'TOKEN',request}}))).toEqual({encoding:'base64',value:Buffer.from(privateValue).toString('base64')});expect(f.db.select().from(s.secretUses).get()?.state).toBe('released');
    expect(decoded(await model.callTool({name:'loom_command',arguments:{operation:'conversation.status',input:{state:'waiting',work:'Canonical waiting'},id:randomUUID()}}))).toMatchObject({ok:true});tick();
    if(mode==='stop'){
     f.root.writes.run(()=>f.root.services.comms!.threads.requestStop(f.thread.id));await model.callTool({name:'loom_command',arguments:{operation:'conversation.status',input:{state:'working',work:'Checking Stop'},id:randomUUID()}}).catch(()=>undefined);return;
    }
    const session=args[args.indexOf('--session-id')+1];child.stdout.emit('data',Buffer.from([{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed',content:[{type:'text',text:'Used canonical tools privately'}]}},{type:'result',session_id:session,is_error:false,subtype:'success',result:'Used canonical tools privately'}].map(row=>JSON.stringify(row)).join('\n')));child.emit('close',0);
   }finally{await model.close();}
  })().catch(error=>{if(!killed){failure=error;child.emit('close',1);}}).finally(actorEnded);};control.once('finish',start);stdin.once('finish',()=>{ended=true;start();});return child;
 });
 const bytes=Buffer.from(JSON.stringify({job,build:'image',bootstrap:{origin:'https://loom.invalid',job:'job',token}})),error=vi.fn();
 const fetcher:typeof fetch=async(url,init)=>{if(String(url).endsWith('/conversation/status'))statusInputs.push(JSON.parse(String(init?.body)).input);return f.root.http.request(new Request(url,init));};
 expect(await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/house'}),stdin:async()=>bytes,env:{ACCOUNT_PROFILE:'/account'},signal:new AbortController().signal,clock:f.clock,fetch:fetcher,schedule:{every:(_ms,callback)=>{tick=callback;return cancel;}},error})).toBe(0);await done;if(failure)throw failure;
 expect(error).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();expect(bytes.every(byte=>byte===0)).toBe(true);expect(pipeBuffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(sourceBuffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(source).toHaveBeenCalledOnce();expect(statusInputs.filter(value=>JSON.stringify(value)===JSON.stringify({state:'waiting',work:'Canonical waiting'}))).toHaveLength(2);
 const replies=f.db.select().from(s.turns).all().filter(row=>row.kind==='reply');expect(replies).toHaveLength(mode==='finish'?1:0);if(mode==='finish')expect(replies[0]).toMatchObject({model:'observed',run:'job'});else{expect(killed).toBe(true);expect(statusInputs).toContainEqual({state:'idle',work:'',seenStop:true});expect(f.db.select().from(s.threads).get()?.stopRequested).toBe(false);}
 expect(f.db.$client.serialize().includes(Buffer.from(token))).toBe(false);expect(f.db.$client.serialize().includes(Buffer.from(privateValue))).toBe(false);
 expect(endpoint).toBeDefined();await expect(fetch(endpoint!.url,{method:'POST',headers:endpoint!.headers,body:'{}'})).rejects.toThrow();
});
