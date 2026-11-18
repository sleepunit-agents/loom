import {afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {eq} from 'drizzle-orm';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {McpServer,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {bodyProgramTools} from './body-program-tools.js';
import {BodyFileRefused} from './body-files.js';
import {bodyFixture,bodyCredentials as raw} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const f=await bodyFixture(clean),signal=new AbortController(),onStop=vi.fn(),onStatus=vi.fn(),fetcher=vi.fn<typeof fetch>(async(input,init)=>f.root.http.fetch(new Request(input,init)));
 const tools=bodyProgramTools({url:'https://loom.example',token:raw.body,signal:signal.signal,fetch:fetcher,clock:f.clock,onStop,onStatus});clean.push(tools.close);
 const server=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:tools.tools}));server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>tools.call(request.params.name,request.params.arguments,extra.signal));
 const client=new Client({name:'fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);clean.push(()=>client.close());clean.push(()=>server.close());
 const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});return{...f,signal,onStop,onStatus,fetcher,tools,client,call};
}
function decoded(value:unknown){return JSON.parse((value as {content:{text:string}[]}).content[0].text);}
it('offers portable tools through a real MCP protocol and discovers new canonical commands',async()=>{
 const f=await fixture(),called=vi.fn();f.root.operations.register({name:'fixture.newCommand',input:z.object({word:z.string()}).strict(),output:z.string(),may:()=>true,run(_ctx,input){called(input.word);return input.word;}});
 expect((await f.client.listTools()).tools.map(tool=>tool.name)).toEqual(['loom_commands','loom_command','loom_query']);
 const list=decoded(await f.call('loom_commands',{}));expect(list.value.commands).toContainEqual({name:'fixture.newCommand',write:false});expect(called).not.toHaveBeenCalled();
 const detail=decoded(await f.call('loom_commands',{name:'fixture.newCommand'}));expect(detail.value.commands).toHaveLength(1);expect(detail.value.commands[0].inputSchema.properties.word.type).toBe('string');
 expect(decoded(await f.call('loom_command',{operation:'fixture.newCommand',input:{word:'Hello'},id:'one'}))).toEqual({ok:true,value:'Hello'});expect(called).toHaveBeenCalledExactlyOnceWith('Hello');
 expect(decoded(await f.call('loom_query',{query:'{agents{id} members{id}}'}))).toMatchObject({data:{agents:[{id:'art'}],members:[]}});
});
it('preserves current Root permissions and stable write receipts',async()=>{
 const f=await fixture();f.root.operations.register({name:'fixture.write',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.boolean(),may:()=>true,run(){f.db.update(s.agents).set({about:f.db.select().from(s.agents).where(eq(s.agents.id,'art')).get()!.about+'!'}).where(eq(s.agents.id,'art')).run();return true;}});
 for(let i=0;i<2;i++)expect(decoded(await f.call('loom_command',{operation:'fixture.write',input:{},id:'same'}))).toEqual({ok:true,value:true});
 expect(f.db.select().from(s.agents).where(eq(s.agents.id,'art')).get()?.about).toBe('!');
 expect(await f.call('loom_command',{operation:'runtime.started',input:{job:'job',build:'fake'},id:'worker'})).toMatchObject({isError:true});
 f.db.update(s.jobs).set({state:'done'}).run();expect(await f.call('loom_commands',{})).toMatchObject({isError:true});expect(await f.call('loom_query',{query:'{agents{id}}'})).toMatchObject({isError:true});
});
it.each([
 ['conversation.take',{}],['conversation.session',{}],['conversation.sessionSave',{session:null}],['conversation.accept',{items:['fake']}],['conversation.confirm',{batch:'fake'}],['conversation.turn',{kind:'action',model:'MADE UP'}],
 ['conversation.status',{state:'idle',work:''}],['conversation.message',{kind:'reply',words:'hello',clientId:'one',model:'MADE UP'}],['bridges.reply',{incoming:'fake',text:'hello',latencyMs:1}],
]as const)('keeps runtime-owned %s facts and private routes out of model calls',async(operation,input)=>{
 const f=await fixture();expect(await f.call('loom_command',{operation,input,id:'forged'})).toMatchObject({isError:true});expect(f.db.select().from(s.turns).all()).toHaveLength(0);expect(f.fetcher.mock.calls.some(([url])=>String(url).includes('/api/'+operation.replace('.','/')))).toBe(false);
});
it('notifies runtime status and stops without allowing a model to acknowledge Stop',async()=>{
 const f=await fixture();expect(decoded(await f.call('loom_command',{operation:'conversation.status',input:{state:'waiting',work:'Waiting for consent'},id:'waiting'}))).toMatchObject({ok:true});expect(f.onStatus).toHaveBeenCalledExactlyOnceWith({state:'waiting',work:'Waiting for consent'});
 await f.call('loom_command',{operation:'conversation.status',input:{state:'working',work:'Resumed'},id:'resumed'});f.root.writes.run(()=>f.root.services.comms!.threads.requestStop(f.thread.id));
 expect(await f.call('loom_command',{operation:'conversation.status',input:{state:'working',work:'Checking'},id:'stop'})).toMatchObject({isError:true});expect(f.onStop).toHaveBeenCalledOnce();expect(f.onStatus).toHaveBeenLastCalledWith({state:'working',work:'Checking'});expect(f.db.select().from(s.threads).get()?.stopRequested).toBe(true);
});
it('closes current and future model calls without reflecting credentials',async()=>{
 const f=await fixture();f.tools.close();const before=f.fetcher.mock.calls.length;const answer=await f.call('loom_commands',{});expect(answer).toMatchObject({isError:true});expect(JSON.stringify(answer)).not.toContain(raw.body);expect(f.fetcher).toHaveBeenCalledTimes(before);
});
it('cancels one tool request without closing the shared body lifetime',async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),fetcher=vi.fn<typeof fetch>(()=>{entered();return new Promise(()=>{});}),abort=new AbortController(),tools=bodyProgramTools({url:'https://loom.example',token:raw.body,signal:new AbortController().signal,fetch:fetcher,onStop:vi.fn(),onStatus:vi.fn()});clean.push(tools.close);
 const pending=tools.call('loom_query',{query:'{agents{id}}'},abort.signal);await started;abort.abort();expect(await pending).toMatchObject({isError:true});expect(fetcher).toHaveBeenCalledOnce();fetcher.mockResolvedValueOnce(Response.json({data:{agents:[]}}));expect(decoded(await tools.call('loom_query',{query:'{agents{id}}'}))).toEqual({data:{agents:[]}});
});
it('snapshots private options before any model call and never reflects echoed credentials',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json({data:{value:raw.body}})),options={url:'https://loom.example',token:raw.body,signal:new AbortController().signal,fetch:fetcher,onStop:vi.fn(),onStatus:vi.fn()},tools=bodyProgramTools(options);clean.push(tools.close);options.url='https://other.example';options.token=raw.member;
 const reply=await tools.call('loom_query',{query:'{value}'});expect(reply).toMatchObject({isError:true});expect(JSON.stringify(reply)).not.toContain(raw.body);expect(String(fetcher.mock.calls[0][0])).toBe('https://loom.example/graphql');expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer '+raw.body);
});

it('registers the same tools into the existing server SDK without another listener',async()=>{
 const f=await fixture();
 const request=async(method:string,params:unknown={})=>{const server=new McpServer({name:'composed',version:'1'}),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});for(const tool of f.tools.extensions)server.registerTool(tool.name,{description:tool.description,inputSchema:tool.inputSchema},(args:unknown,extra:{mcpReq:{signal:AbortSignal}})=>tool.execute(args as Record<string,unknown>,extra.mcpReq.signal));await server.connect(transport);clean.push(()=>server.close());clean.push(()=>transport.close());return transport.handleRequest(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}));};
 const list=await request('tools/list');expect(list.status).toBe(200);expect((await list.json()).result.tools.map((tool:{name:string})=>tool.name)).toEqual(f.tools.tools.map(tool=>tool.name));
 const response=await request('tools/call',{name:'loom_query',arguments:{query:'{agents{id}}'}});expect(response.status).toBe(200);expect(decoded((await response.json()).result)).toMatchObject({data:{agents:[{id:'art'}]}});
});

it.each(['close','abort']as const)('cancels pending concurrent tools on lifetime %s and suppresses late responses',async mode=>{
 const releases:((response:Response)=>void)[]=[],signal=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),fetcher=vi.fn<typeof fetch>(()=>new Promise(resolve=>{releases.push(resolve);if(releases.length===2)entered();})),tools=bodyProgramTools({url:'https://loom.example',token:raw.body,signal:signal.signal,fetch:fetcher,onStop:vi.fn(),onStatus:vi.fn()});clean.push(tools.close);
 const pending=[tools.call('loom_query',{query:'{agents{id}}'}),tools.call('loom_query',{query:'{members{id}}'})];await started;if(mode==='close')tools.close();else signal.abort();for(const reply of await Promise.all(pending))expect(reply).toMatchObject({isError:true});
 const cancelled=vi.fn();for(const release of releases)release(new Response(new ReadableStream({cancel:cancelled}),{headers:{'content-type':'application/json'}}));await Promise.resolve();await Promise.resolve();expect(cancelled).toHaveBeenCalledTimes(2);expect(await tools.call('loom_commands',{})).toMatchObject({isError:true});expect(fetcher).toHaveBeenCalledTimes(2);
});
it('still stops when a trusted status observer fails on the Stop response',async()=>{
 const f=await fixture();await f.call('loom_command',{operation:'conversation.status',input:{state:'working',work:'Preparing'},id:'start'});f.root.writes.run(()=>f.root.services.comms!.threads.requestStop(f.thread.id));f.onStatus.mockImplementation(()=>{throw new Error('private observer diagnostics');});const result=await f.call('loom_command',{operation:'conversation.status',input:{state:'working',work:'Check'},id:'stop'});expect(result).toMatchObject({isError:true});expect(f.onStop).toHaveBeenCalledOnce();expect(JSON.stringify(result)).not.toContain('private observer diagnostics');
});
it.each([['unknown',{}],['loom_query',{query:'{agents{id}}',actor:'alice'}],['loom_commands',{name:'conversation.status',token:'fake'}],['loom_command',{operation:'conversation.status',input:{},id:''}]])('rejects invalid tool %s arguments without an upstream request',async(name,args)=>{
 const f=await fixture();expect(await f.call(name,args as Record<string,unknown>)).toMatchObject({isError:true});expect(f.fetcher).not.toHaveBeenCalled();
});
it('notifies Stop before publishing a tool result',async()=>{
 const f=await fixture(),events:string[]=[];await f.call('loom_command',{operation:'conversation.status',input:{state:'working',work:'Preparing'},id:'prepare'});f.root.writes.run(()=>f.root.services.comms!.threads.requestStop(f.thread.id));f.onStop.mockImplementation(()=>{events.push('stop');});await f.tools.call('loom_command',{operation:'conversation.status',input:{state:'working',work:'Checking'},id:'ordered-stop'}).then(result=>{events.push('published');expect(result).toMatchObject({isError:true});});expect(events).toEqual(['stop','published']);
});
it('cancels one request while another already pending request completes normally',async()=>{
 const releases:((value:Response)=>void)[]=[],a=new AbortController();let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;}),fetcher=vi.fn<typeof fetch>(()=>new Promise(resolve=>{releases.push(resolve);if(releases.length===2)ready();})),tools=bodyProgramTools({url:'https://loom.example',token:raw.body,signal:new AbortController().signal,fetch:fetcher,onStop:vi.fn(),onStatus:vi.fn()});clean.push(tools.close);
 const first=tools.call('loom_query',{query:'{one}'},a.signal),second=tools.call('loom_query',{query:'{two}'});await started;a.abort();expect(await first).toMatchObject({isError:true});releases[1](Response.json({data:{two:'still current'}}));expect(decoded(await second)).toEqual({data:{two:'still current'}});const cancelled=vi.fn();releases[0](new Response(new ReadableStream({cancel:cancelled})));await Promise.resolve();await Promise.resolve();expect(cancelled).toHaveBeenCalledOnce();
});
it.each(['idle','offline'])('does not let the model clear a live turn by reporting %s',async state=>{const f=await fixture();expect(await f.call('loom_command',{operation:'conversation.status',input:{state,work:''},id:'fake-end'})).toMatchObject({isError:true});expect(f.fetcher).not.toHaveBeenCalled();expect(f.onStatus).not.toHaveBeenCalled();});
it.each([['conversation.message',{kind:'reply',words:'hello',clientId:'one',latencyMs:2}],['bridges.reply',{incoming:'fake',text:'hello',model:'MADE_UP_MODEL'}]])('rejects the remaining runtime-owned telemetry fields on %s',async(operation,input)=>{const f=await fixture();expect(await f.call('loom_command',{operation,input,id:'telemetry'})).toMatchObject({isError:true});expect(f.fetcher).not.toHaveBeenCalled();});
it('publishes only generic code-interface metadata through actual MCP discovery',async()=>{
 const f=await fixture();f.db.update(s.agents).set({about:'PRIVATE_DESCRIPTOR_RECORD_CANARY'}).where(eq(s.agents.id,'art')).run();f.db.insert(s.secrets).values({name:'PRIVATE_DESCRIPTOR_SECRET_CANARY',description:'PRIVATE_SECRET_DESCRIPTION',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();
 const offered=(await f.client.listTools()).tools,encoded=JSON.stringify(offered);for(const value of[raw.body,raw.member,raw.runner,raw.agent,'PRIVATE_DESCRIPTOR_RECORD_CANARY','PRIVATE_DESCRIPTOR_SECRET_CANARY','PRIVATE_SECRET_DESCRIPTION','https://loom.example'])expect(encoded).not.toContain(value);
 expect(offered.map(tool=>({name:tool.name,properties:Object.keys(tool.inputSchema.properties??{}).sort()}))).toEqual([{name:'loom_commands',properties:['name']},{name:'loom_command',properties:['id','input','operation']},{name:'loom_query',properties:['operationName','query','variables']}]);expect(f.fetcher).not.toHaveBeenCalled();
});
it('reads a post\'s files from the body\'s own area by the path the model gives, and hands loom a name and bytes',async()=>{
 const f=await bodyFixture(clean),seen:unknown[]=[];
 f.root.operations.register({name:'bridges.say',write:true,input:z.object({id:z.string(),text:z.string(),files:z.array(z.object({name:z.string(),contents:z.string()}).strict()).optional()}).strict(),output:z.object({saved:z.literal(true)}).strict(),may:()=>true,run(_ctx,input){seen.push(input);return{saved:true as const};}});
 const asked:string[][]=[];
 const readFiles=(paths:readonly string[])=>{asked.push([...paths]);if(paths.some(path=>path.startsWith('/etc')))throw new BodyFileRefused("Not inside this body's working area: "+paths[0]);return paths.map(path=>({name:path.split('/').pop()!,contents:Buffer.from('BYTES OF '+path)}));};
 const make=(reader?:typeof readFiles)=>{const tools=bodyProgramTools({url:'https://loom.example',token:raw.body,signal:new AbortController().signal,fetch:async(input,init)=>f.root.http.fetch(new Request(input,init)),clock:f.clock,onStop(){},onStatus(){},...(reader?{readFiles:reader}:{})});clean.push(tools.close);return tools;};
 const tools=make(readFiles),text=(value:{content:{text:string}[]})=>value.content[0].text;
 expect(JSON.parse(text(await tools.call('loom_command',{operation:'bridges.say',input:{id:'one',text:'Here',files:[{path:'out/plot.png'}]},id:'one'})))).toEqual({ok:true,value:{saved:true}});
 expect(asked).toEqual([['out/plot.png']]);
 expect(seen).toEqual([{id:'one',text:'Here',files:[{name:'plot.png',contents:Buffer.from('BYTES OF out/plot.png').toString('base64')}]}]);
 // A path outside the area never reaches loom; the model is told which path and why.
 const refused=await tools.call('loom_command',{operation:'bridges.say',input:{id:'two',text:'Here',files:[{path:'/etc/passwd'}]},id:'two'});
 expect(refused.isError).toBe(true);expect(text(refused)).toBe("Not inside this body's working area: /etc/passwd");
 // Bytes of the model's own making under a file's name are not a file: only a path is.
 for(const files of [[{name:'x',contents:'QUJD'}],[{path:'a',name:'b'}],[],'out/plot.png'])expect((await tools.call('loom_command',{operation:'bridges.say',input:{id:'three',text:'x',files},id:'three'})).isError).toBe(true);
 expect(seen).toHaveLength(1);
 // Without files a post is as before, and a body with no reader posts none.
 expect(JSON.parse(text(await tools.call('loom_command',{operation:'bridges.say',input:{id:'four',text:'Plain'},id:'four'})))).toMatchObject({ok:true});
 expect((await make().call('loom_command',{operation:'bridges.say',input:{id:'five',text:'x',files:[{path:'out/plot.png'}]},id:'five'})).isError).toBe(true);
 expect(seen).toHaveLength(2);
});
