import {afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import * as privateTools from './body-secret-tools.js';
import {bodyProgram} from './body-program.js';
import type {WorkerAssignment} from './worker.js';
import {bodySecretTools} from './body-secret-tools.js';
import type {BodyModelTool} from './body-model-tools.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();vi.clearAllMocks();});
async function fixture(extraTools:BodyModelTool[]){
 const abort=new AbortController(),root=vi.fn<typeof fetch>(),tools=await bodySecretTools({url:'https://root.invalid',token:'PRIVATE_ROOT_BEARER',job:'job',conversation:'cv',signal:abort.signal,fetch:root,extraTools});clean.push(()=>tools.close());
 const connection=JSON.parse(tools.config.toString()).mcpServers.loom_secrets,client=new Client({name:'composed-model',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:connection.headers}}));clean.push(()=>client.close());return{abort,root,tools,client};
}
it('shares one authenticated MCP listener and exactly advertises the snapped extension names',async()=>{
 const execute=vi.fn(async(input:Record<string,unknown>)=>({content:[{type:'text' as const,text:JSON.stringify(input)}]})),tool={name:'command',description:'Canonical command',inputSchema:z.object({command:z.string()}).strict(),execute},f=await fixture([tool]);tool.name='changed';tool.execute=vi.fn();
 expect(f.tools.allowedTools).toEqual(['mcp__loom_secrets__request_secret','mcp__loom_secrets__use_secret','mcp__loom_secrets__command']);expect((await f.client.listTools()).tools.map(tool=>tool.name)).toEqual(['request_secret','use_secret','command']);
 expect(await f.client.callTool({name:'command',arguments:{command:'list'}})).toMatchObject({content:[{type:'text',text:'{"command":"list"}'}]});expect(execute).toHaveBeenCalledOnce();
 await f.client.callTool({name:'command',arguments:{command:'list',agent:'foreign'}}).catch(()=>undefined);expect(execute).toHaveBeenCalledOnce();const undeclared=await f.client.callTool({name:'undeclared',arguments:{}}).catch(()=>undefined);expect(undeclared===undefined||undeclared.isError===true).toBe(true);expect(execute).toHaveBeenCalledOnce();expect(f.root).not.toHaveBeenCalled();expect(f.tools.config.includes(Buffer.from('PRIVATE_ROOT_BEARER'))).toBe(false);
});
it('sanitizes extension exceptions through the existing private tool wrapper',async()=>{
 const f=await fixture([{name:'command',description:'Canonical command',inputSchema:z.object({}).strict(),execute:async()=>{throw new Error('PRIVATE_ROOT_BEARER');}}]);
 const result=await f.client.callTool({name:'command',arguments:{}});expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain('PRIVATE_ROOT_BEARER');
});
it('cancels extension work and keeps close pending until the callback actually settles',async()=>{
 let entered!:()=>void,aborted!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),cancelled=new Promise<void>(resolve=>{aborted=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const listen=vi.spyOn(Server.prototype,'listen');
 const f=await fixture([{name:'command',description:'Canonical command',inputSchema:z.object({}).strict(),execute:async(_input,signal)=>{entered();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted();resolve();},{once:true}));await gate;return{content:[{type:'text',text:'late'}]};}}]);
 const server=listen.mock.instances[0] as Server,listenerClosed=new Promise<void>(resolve=>server.once('close',resolve)),call=f.client.callTool({name:'command',arguments:{}}).catch(()=>undefined);await started;
 let closed=false;const closing=f.tools.close().then(()=>{closed=true;});await cancelled;await listenerClosed;await new Promise<void>(resolve=>queueMicrotask(()=>queueMicrotask(resolve)));try{expect(closed).toBe(false);}finally{release();}
 await closing;await call;expect(closed).toBe(true);expect(f.tools.config.every(byte=>byte===0)).toBe(true);expect(f.root).not.toHaveBeenCalled();
});
it('rejects invalid extension catalogues before any HTTP listener is bound',async()=>{
 const listen=vi.spyOn(Server.prototype,'listen'),valid:BodyModelTool={name:'command',description:'Canonical command',inputSchema:z.object({}),execute:async()=>({content:[]})};
 for(const extraTools of [[{...valid,name:'use_secret'}],[valid,valid],[{...valid,name:'invalid!'}],Array.from({length:33},(_,i)=>({...valid,name:'tool'+i}))]){
  await expect(bodySecretTools({url:'https://root.invalid',token:'private',job:'job',conversation:'cv',signal:new AbortController().signal,extraTools})).rejects.toThrow('Body model tools unavailable');
 }
 expect(listen).not.toHaveBeenCalled();
});
it('passes the exact composed listener tool names through the actual default body to native policy',async()=>{
 const original=privateTools.bodySecretTools;vi.spyOn(privateTools,'bodySecretTools').mockImplementation(input=>original({...input,extraTools:[{name:'command',description:'Canonical command',inputSchema:z.object({}).strict(),execute:async()=>({content:[]})}]}));
 const job:WorkerAssignment={id:'job',box:'box',agent:'art',conversation:'cv',thread:'thread',model:'requested',account:'account',harness:'claude',brief:'',house:{repository:'r',file:'f',branch:'next'}};
 vi.mocked(spawn).mockImplementation((_command,args)=>{
  expect(args).toContain('mcp__loom_secrets__command');
  const session=args[args.indexOf('--session-id')+1],output=new PassThrough(),child=Object.assign(new EventEmitter(),{stdin:new Writable({write(_bytes,_encoding,done){done();}}),stdout:output,stderr:new PassThrough(),stdio:[null,null,null,new Writable({write(_bytes,_encoding,done){done();}})],kill:vi.fn(()=>true)}) as unknown as ChildProcessWithoutNullStreams;
  child.stdin.once('finish',()=>{output.emit('data',Buffer.from([{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed',content:[{type:'text',text:'done'}]}},{type:'result',session_id:session,is_error:false,subtype:'success',result:'done'}].map(row=>JSON.stringify(row)).join('\n')));child.emit('close',0);});return child;
 });
 const bytes=Buffer.from(JSON.stringify({job,build:'image',bootstrap:{origin:'https://root.invalid',job:'job',token:'body_'+'a'.repeat(64)}})),error=vi.fn();
 const fetcher:typeof fetch=async(url)=>{const path=String(url).split('/').at(-1);if(path==='startup')return Response.json({aliases:[]});const value=path==='take'?{job:'job',conversation:'cv',stopRequested:false,items:[{id:'mail',seq:1,source:'thread',sourceId:null,fromKind:'person',fromId:'alice',at:'2026-11-15T00:00:00.000Z',words:'mail',keepUntil:null,verdict:null,refs:[]}]}:path==='status'?{saved:true,stopRequested:false}:path==='message'?{saved:true,seq:2}:{saved:true};return Response.json({ok:true,value});};
 expect(await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/house'}),stdin:async()=>bytes,env:{},signal:new AbortController().signal,fetch:fetcher,schedule:{every:()=>()=>{}},error})).toBe(0);expect(error).not.toHaveBeenCalled();expect(spawn).toHaveBeenCalledOnce();
});
