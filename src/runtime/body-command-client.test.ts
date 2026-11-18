import {afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
import {FakeClock} from '../core/clock.js';
import {bodyCommandClient} from './body-command-client.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();});
const error='Body request failed; outcome may be uncertain';
function client(fetcher:typeof fetch,signal=new AbortController().signal,clock=new FakeClock()){
 const value=bodyCommandClient({url:'https://loom.example',token:raw.body,signal,clock,fetch:fetcher});clean.push(value.close);return value;
}
async function fixture(){
 const f=await bodyFixture(clean),fetcher=vi.fn<typeof fetch>(async(input,init)=>f.root.http.fetch(new Request(input,init))),value=bodyCommandClient({url:'https://loom.example',token:raw.body,signal:new AbortController().signal,clock:f.clock,fetch:fetcher});clean.push(value.close);return{...f,fetcher,value};
}
it('uses actual Root commands, stable receipts and current policy without forwarding caller authority',async()=>{
 const f=await fixture();f.root.operations.register({name:'fixture.record',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.object({saved:z.literal(true)}).strict(),may:viewer=>viewer.kind==='agent'&&viewer.id==='art',run(ctx){f.db.update(s.agents).set({about:f.db.select().from(s.agents).where(eq(s.agents.id,'art')).get()!.about+'!'}).where(eq(s.agents.id,'art')).run();ctx.changed('agents','art');return{saved:true as const};}});
 for(let i=0;i<2;i++)expect(await f.value.command('fixture.record',{},'same-receipt')).toEqual({ok:true,value:{saved:true}});
 expect(f.db.select().from(s.agents).where(eq(s.agents.id,'art')).get()?.about).toBe('!');
 expect(await f.value.command('conversation.status',{state:'working',work:'Checking'},'status')).toMatchObject({ok:true,value:{saved:true}});expect(f.db.select().from(s.agentStatus).get()).toMatchObject({agent:'art',state:'working',work:'Working privately'});
 expect(await f.value.command('runtime.started',{job:'job',build:'fake'},'forbidden')).toMatchObject({ok:false,code:'denied'});
 expect(await f.value.command('conversation.status',{state:'working',work:'Bad',agent:'mark'},'overposted')).toMatchObject({ok:false,code:'invalid'});
 for(const [url,options]of f.fetcher.mock.calls){expect(String(url).startsWith('https://loom.example/api/')).toBe(true);expect(options?.redirect).toBe('error');expect(new Headers(options?.headers).get('authorization')).toBe('Bearer '+raw.body);expect(options?.body).not.toContain(raw.body);}
});
it('uses the existing generated GraphQL viewer without gaining another member read',async()=>{
 const f=await fixture();expect(await f.value.query({query:'{agents{id} members{id}}'})).toMatchObject({data:{agents:[{id:'art'}],members:[]}});
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).run());expect(await f.value.command('fixture.record',{},'ended')).toMatchObject({ok:false,code:'denied'});await expect(f.value.query({query:'{agents{id}}'})).rejects.toThrow(error);
});
it.each(['https://user:pass@loom.example','https://loom.example/private','https://loom.example?token=x','https://loom.example#fragment','https:\\loom.example',' https://loom.example','http://remote.example'])('rejects unsafe Root origin %s before fetch',url=>{
 const fetcher=vi.fn<typeof fetch>();expect(()=>bodyCommandClient({url,token:raw.body,signal:new AbortController().signal,fetch:fetcher})).toThrow(error);expect(fetcher).not.toHaveBeenCalled();
});
it.each(['../runtime.started','https://evil.example/x','runtime.started/other','runtime..started','runtime.started?host=evil'])('rejects operation path injection %s before fetch',async operation=>{
 const fetcher=vi.fn<typeof fetch>();await expect(client(fetcher).command(operation,{},'id')).rejects.toThrow(error);expect(fetcher).not.toHaveBeenCalled();
});
it('requires a bounded stable ID and a bounded UTF8 request before sending',async()=>{
 const fetcher=vi.fn<typeof fetch>(),value=client(fetcher);for(const id of['','x'.repeat(201)])await expect(value.command('fixture.write',{},id)).rejects.toThrow(error);
 await expect(value.command('fixture.write',{words:'é'.repeat(600000)},'id')).rejects.toThrow(error);expect(fetcher).not.toHaveBeenCalled();
});
it('erases received bytes and joined copies while returning an owned JSON value',async()=>{
 const bytes=Buffer.from(JSON.stringify({ok:true,value:{text:'PRIVATE_BODY_RESPONSE'}})),marker=Buffer.from('PRIVATE_BODY_RESPONSE'),join=Buffer.concat,owned:Buffer[]=[];vi.spyOn(Buffer,'concat').mockImplementation((list,length)=>{const value=join(list,length);if(value.includes(marker))owned.push(value);return value;});const value=client(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),{headers:{'content-type':'application/json'}}));
 expect(await value.command('fixture.read',{},'id')).toEqual({ok:true,value:{text:'PRIVATE_BODY_RESPONSE'}});expect(bytes.every(byte=>byte===0)).toBe(true);expect(owned.length).toBeGreaterThan(0);for(const bytes of owned)expect(bytes.every(byte=>byte===0)).toBe(true);
});
it('erases owned partial bytes at cancellation before the pending reader settles',async()=>{
 const original=Buffer.from('{"ok":true,"value":"PRIVATE_PARTIAL'),copy=Buffer.from,abort=new AbortController();let owned:Buffer|undefined,received!:()=>void;const copied=new Promise<void>(resolve=>{received=resolve;});
 vi.spyOn(Buffer,'from').mockImplementation((...args:Parameters<typeof Buffer.from>)=>{const value=Reflect.apply(copy,Buffer,args)as ReturnType<typeof Buffer.from>;if((args[0]as unknown)===original){owned=value;received();}return value;});
 const value=client(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(original);}}),{headers:{'content-type':'application/json'}}),abort.signal),pending=value.command('fixture.read',{},'id');void pending.catch(()=>{});await copied;expect(owned!.some(byte=>byte!==0)).toBe(true);abort.abort();expect(owned!.every(byte=>byte===0)).toBe(true);expect(original.every(byte=>byte===0)).toBe(true);await expect(pending).rejects.toThrow(error);
});
it('cancels a late response on close and never retries an uncertain write',async()=>{
 let release!:(response:Response)=>void;const flight=new Promise<Response>(resolve=>{release=resolve;}),fetcher=vi.fn<typeof fetch>(()=>flight),value=client(fetcher),pending=value.command('fixture.write',{},'stable');void pending.catch(()=>{});value.close();await expect(pending).rejects.toThrow(error);const cancel=vi.fn();release(new Response(new ReadableStream({cancel}),{headers:{'content-type':'application/json'}}));await flight;await Promise.resolve();expect(cancel).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();await expect(value.command('fixture.write',{},'stable')).rejects.toThrow(error);expect(fetcher).toHaveBeenCalledOnce();
});
it('bounds request lifetime and rejects later calls after external abort',async()=>{
 const clock=new FakeClock(),abort=new AbortController(),fetcher=vi.fn<typeof fetch>(()=>new Promise(()=>{})),value=client(fetcher,abort.signal,clock),pending=value.command('fixture.write',{},'stable');void pending.catch(()=>{});clock.advance(15000);expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);abort.abort();await expect(pending).rejects.toThrow(error);expect(fetcher).toHaveBeenCalledOnce();abort.abort();await expect(value.command('fixture.write',{},'stable')).rejects.toThrow(error);expect(fetcher).toHaveBeenCalledOnce();
});
it.each(['raw-token','escaped-token','bad-json','bad-utf8','bad-status','bad-type','redirect','length','overflow']as const)('refuses %s response without leaking the Root bearer',async mode=>{
 const bytes=mode==='overflow'?new Uint8Array(16777217).fill(65):undefined,fetcher=vi.fn<typeof fetch>(async()=>{
  if(bytes)return new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),{headers:{'content-type':'application/json'}});
  const text=mode==='raw-token'?JSON.stringify({ok:true,value:raw.body}):mode==='escaped-token'?'{"ok":true,"value":"\\u0062'+raw.body.slice(1)+'"}':mode==='bad-json'?'not JSON':JSON.stringify({ok:true,value:'value'});
  if(mode==='redirect')return{redirected:true,body:new ReadableStream(),headers:new Headers({'content-type':'application/json'})}as Response;
  return new Response(mode==='bad-utf8'?new Uint8Array([255]):text,{status:mode==='bad-status'?201:200,headers:{'content-type':mode==='bad-type'?'text/plain':'application/json',...(mode==='length'?{'content-length':'16777217'}:{})}});
 });const value=client(fetcher);await expect(value.command('fixture.read',{},'stable')).rejects.toThrow(error);expect(fetcher).toHaveBeenCalledOnce();if(bytes)expect(bytes.every(byte=>byte===0)).toBe(true);
});
it('returns GraphQL validation errors through the same generated read door',async()=>{
 const value=client(async()=>Response.json({errors:[{message:'Unknown selected field'}]},{status:400}));expect(await value.query({query:'{unknown}'})).toEqual({errors:[{message:'Unknown selected field'}]});
});

it.each([{data:7},{data:[]},{errors:[{message:7}]},{errors:[]},{data:{},errors:[]},{unrelated:'value'}])('rejects invalid GraphQL envelopes: %j',async response=>{
 const value=client(async()=>Response.json(response));await expect(value.query({query:'{agents{id}}'})).rejects.toThrow(error);
});

it.each([0,30001,1.5,NaN])('rejects invalid request timeout %s before fetch',timeoutMs=>{
 const fetcher=vi.fn<typeof fetch>();expect(()=>bodyCommandClient({url:'https://loom.example',token:raw.body,signal:new AbortController().signal,timeoutMs,fetch:fetcher})).toThrow(error);expect(fetcher).not.toHaveBeenCalled();
});
it('accepts the maximum deadline and rejects credential header injection before any request',async()=>{
 const clock=new FakeClock(),fetcher=vi.fn<typeof fetch>(()=>new Promise(()=>{})),value=bodyCommandClient({url:'https://loom.example',token:raw.body,signal:new AbortController().signal,clock,timeoutMs:30000,fetch:fetcher});clean.push(value.close);let settled=false;const pending=value.command('fixture.write',{},'stable');void pending.then(()=>{settled=true;},()=>{settled=true;});clock.advance(29999);await Promise.resolve();expect(settled).toBe(false);clock.advance(1);expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);value.close();await expect(pending).rejects.toThrow(error);expect(fetcher).toHaveBeenCalledOnce();
 expect(()=>bodyCommandClient({url:'https://loom.example',token:raw.body+String.fromCharCode(13,10)+'Host: evil',signal:new AbortController().signal,fetch:fetcher})).toThrow(error);expect(fetcher).toHaveBeenCalledOnce();
});
it.each(['command','query']as const)('does not publish %s data when abort wins the response-completion microtask boundary',async mode=>{
 const abort=new AbortController(),marker=Buffer.from('PRIVATE_PUBLICATION'),join=Buffer.concat;vi.spyOn(Buffer,'concat').mockImplementation((list,length)=>{const bytes=join(list,length);if(bytes.includes(marker))queueMicrotask(()=>abort.abort());return bytes;});
 const value=client(async()=>Response.json(mode==='command'?{ok:true,value:'PRIVATE_PUBLICATION'}:{data:{value:'PRIVATE_PUBLICATION'}}),abort.signal),pending=mode==='command'?value.command('fixture.read',{},'id'):value.query({query:'{value}'});await expect(pending).rejects.toThrow(error);
});
it('snapshots the constructor credential and origin even if the options object is reused',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:'safe'})),options={url:'https://loom.example',token:raw.body,signal:new AbortController().signal,fetch:fetcher},value=bodyCommandClient(options);clean.push(value.close);options.token=raw.member;options.url='https://other.example';
 expect(await value.command('fixture.read',{},'id')).toEqual({ok:true,value:'safe'});expect(String(fetcher.mock.calls[0][0])).toBe('https://loom.example/api/fixture/read');expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer '+raw.body);
});
it('keeps echo detection bound to the admitted credential while a request is pending',async()=>{
 let entered!:()=>void,release!:(response:Response)=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),response=new Promise<Response>(resolve=>{release=resolve;}),fetcher=vi.fn<typeof fetch>(()=>{entered();return response;}),options={url:'https://loom.example',token:raw.body,signal:new AbortController().signal,fetch:fetcher},value=bodyCommandClient(options);clean.push(value.close);const pending=value.command('fixture.read',{},'id');void pending.catch(()=>{});await started;options.token=raw.member;release(Response.json({ok:true,value:raw.body}));await expect(pending).rejects.toThrow(error);
});
it.each(['0','999','-1','1.5','1x'])('rejects invalid or mismatched declared length %s',async length=>{
 const value=client(async()=>new Response(JSON.stringify({ok:true,value:'safe'}),{headers:{'content-type':'application/json','content-length':length}}));await expect(value.command('fixture.read',{},'id')).rejects.toThrow(error);
});
it('requests identity encoding and accepts an exact UTF8 byte length',async()=>{
 const text=JSON.stringify({ok:true,value:'é'}),fetcher=vi.fn<typeof fetch>(async()=>new Response(text,{headers:{'content-type':'application/json','content-encoding':'identity','content-length':String(Buffer.byteLength(text))}})),value=client(fetcher);expect(await value.command('fixture.read',{},'id')).toEqual({ok:true,value:'é'});expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('accept-encoding')).toBe('identity');
});
it('refuses an unnegotiated content encoding',async()=>{
 const value=client(async()=>Response.json({ok:true,value:'safe'},{headers:{'content-encoding':'gzip'}}));await expect(value.command('fixture.read',{},'id')).rejects.toThrow(error);
});
it.each([false,true])('refuses a bearer echo discarded by a duplicate property (escaped=%s)',async escaped=>{
 const token=escaped?'\\u0062'+raw.body.slice(1):raw.body,text='{"ok":true,"value":"'+token+'","value":"safe"}',value=client(async()=>new Response(text,{headers:{'content-type':'application/json'}}));await expect(value.command('fixture.read',{},'id')).rejects.toThrow(error);
});
it.each([{status:200,value:{ok:true}},{status:200,value:{ok:true,value:'safe',extra:true}},{status:403,value:{ok:false,code:'denied',message:7}},{status:403,value:{ok:false,code:'denied'}}])('rejects malformed command envelopes: %j',async({status,value:body})=>{
 const value=client(async()=>Response.json(body,{status}));await expect(value.command('fixture.read',{},'id')).rejects.toThrow(error);
});
it.each([undefined,{value:undefined},{value:NaN},{value:()=>1}])('rejects unsupported command JSON before fetch: %j',async input=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:'safe'}));await expect(client(fetcher).command('fixture.write',input as never,'id')).rejects.toThrow(error);expect(fetcher).not.toHaveBeenCalled();
});
it('refuses cyclic input with a generic error before fetch',async()=>{
 const input:Record<string,unknown>={};input.self=input;const fetcher=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:'safe'}));await expect(client(fetcher).command('fixture.write',input as never,'id')).rejects.toThrow(error);expect(fetcher).not.toHaveBeenCalled();
});
it('preserves a structured unavailable outcome without retrying the write',async()=>{
 const reply={ok:false,code:'unavailable',message:'Operation could not complete'},fetcher=vi.fn<typeof fetch>(async()=>Response.json(reply,{status:503}));expect(await client(fetcher).command('fixture.write',{},'stable')).toEqual(reply);expect(fetcher).toHaveBeenCalledOnce();
});

it.each(['http://localhost:8123','http://127.0.0.1:8123','http://[::1]:8123'])('accepts a loopback HTTP Root and completes a command: %s',async url=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:'safe'})),value=bodyCommandClient({url,token:raw.body,signal:new AbortController().signal,fetch:fetcher});clean.push(value.close);expect(await value.command('fixture.read',{},'id')).toEqual({ok:true,value:'safe'});expect(String(fetcher.mock.calls[0][0])).toBe(url+'/api/fixture/read');
});
it.each([{status:200,body:{errors:[{message:'x',path:7}]}},{status:200,body:{errors:[{message:'x',locations:'invalid'}]}},{status:200,body:{errors:[{message:'x',locations:[{line:0,column:1}]}]}},{status:200,body:{errors:[{message:'x',path:[-1]}]}},{status:400,body:{data:{}}},{status:400,body:{data:{},errors:[{message:'x'}]}}])('rejects inconsistent GraphQL error fields or status: %j',async({status,body})=>{
 const value=client(async()=>Response.json(body,{status}));await expect(value.query({query:'{value}'})).rejects.toThrow(error);
});
it('preserves standard GraphQL partial-data error locations, paths and extensions',async()=>{
 const body={data:{value:null},errors:[{message:'Resolver refused value',path:['value',0],locations:[{line:1,column:2}],extensions:{code:'FORBIDDEN'}}],extensions:{trace:'synthetic'}},value=client(async()=>Response.json(body));expect(await value.query({query:'{value}'})).toEqual(body);
});

it.each([' ', '\t', '\n', '\r'])('rejects whitespace-normalized credentials before sending %j',suffix=>{
 const fetcher=vi.fn<typeof fetch>();for(const token of[raw.body+suffix,suffix+raw.body])expect(()=>bodyCommandClient({url:'https://loom.example',token,signal:new AbortController().signal,fetch:fetcher})).toThrow(error);expect(fetcher).not.toHaveBeenCalled();
});
it.each(['json','utf8'])('erases received chunks, owned copies and joined bytes on %s parsing failure',async mode=>{
 const marker=Buffer.from('PRIVATE_PARSE_FAILURE'),original=mode==='json'?Buffer.from('{"secret":"PRIVATE_PARSE_FAILURE",'):Buffer.concat([marker,Buffer.from([255])]),copy=Buffer.from,join=Buffer.concat,owned:Buffer[]=[];
 vi.spyOn(Buffer,'from').mockImplementation((...args:Parameters<typeof Buffer.from>)=>{const value=Reflect.apply(copy,Buffer,args)as ReturnType<typeof Buffer.from>;if((args[0]as unknown)===original)owned.push(value);return value;});
 vi.spyOn(Buffer,'concat').mockImplementation((list,length)=>{const value=join(list,length);if(value.includes(marker))owned.push(value);return value;});
 const value=client(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(original);controller.close();}}),{headers:{'content-type':'application/json'}}));await expect(value.command('fixture.read',{},'one')).rejects.toThrow(error);expect(owned).toHaveLength(2);for(const bytes of[original,...owned])expect(bytes.every(byte=>byte===0)).toBe(true);
});

it('replays a lost command acknowledgement with its original id and commits the effect once',async()=>{
 const f=await fixture();
 f.root.operations.register({name:'fixture.increment',write:true,input:z.object({}).strict(),output:z.string(),
  may:viewer=>viewer.kind==='agent'&&viewer.id==='art',
  run(){
   const about=f.db.select().from(s.agents).where(eq(s.agents.id,'art')).get()!.about+'!';
   f.db.update(s.agents).set({about}).where(eq(s.agents.id,'art')).run();
   return about;
  }});
 const rootFetch=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementationOnce(async(url,init)=>{
  const reply=await rootFetch(url,init);await reply.body?.cancel();throw new Error('Lost after commit');
 });
 const timers=vi.spyOn(f.clock,'at');
 const pending=f.value.command('fixture.increment',{},'same-through-restart');
 await vi.waitFor(()=>expect(timers).toHaveBeenCalledWith(f.clock.now()+1000,expect.any(Function)));
 f.clock.advance(1000);
 expect(await pending).toEqual({ok:true,value:'!'});
 expect(f.fetcher).toHaveBeenCalledTimes(2);
 expect(f.fetcher.mock.calls[0][1]?.body).toEqual(f.fetcher.mock.calls[1][1]?.body);
 expect(f.db.select().from(s.agents).where(eq(s.agents.id,'art')).get()?.about).toBe('!');
});
