import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
import {bodyConversationClient} from './conversation-client.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();});
async function fixture(){
 const f=await bodyFixture(clean),abort=new AbortController(),requests:{url:string;body:Record<string,unknown>}[]=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{requests.push({url:String(url),body:JSON.parse(String(init?.body))});return f.root.http.request(new Request(url,init));});
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:abort.signal,clock:f.clock,fetch:fetcher});clean.push(()=>client.close());return {...f,abort,fetcher,client,requests};
}
it('takes real encrypted input, reports it received without settling it, and reports through current body HTTP doors',async()=>{
 const f=await fixture();await f.send('PRIVATE FIRST','one');await f.send('PRIVATE SECOND','two');const accepted:string[]=[];
 expect(await f.client.takeAndAccept(async row=>{expect(f.db.select().from(s.messages).all().map(m=>m.delivery)).toEqual(['sending','sending']);accepted.push(row.words!);})).toEqual({accepted:2,stopRequested:false});
 expect(accepted).toEqual(['PRIVATE FIRST','PRIVATE SECOND']);expect(f.db.select().from(s.messages).all().map(m=>m.delivery)).toEqual(['delivered','delivered']);expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['taken','taken']);expect(f.requests[1].url).toMatch(/\/accept$/);
 expect(f.requests[0].body).toEqual({input:{limit:50}});expect(f.requests[1].body).toMatchObject({input:{items:expect.any(Array)},id:expect.any(String)});
 expect(await f.client.status({state:'working',work:'Checking'})).toEqual({saved:true,stopRequested:false});expect(await f.client.reply({clientId:'answer',words:'PRIVATE REPLY',model:'actual'})).toEqual({saved:true,seq:3});expect(await f.client.card({clientId:'step',words:'PRIVATE STEP',tool:'Read',cardState:'done'})).toEqual({saved:true,seq:4});expect((await f.client.turn({kind:'note',model:'actual'})).saved).toBe(true);expect((await f.client.digest({summary:'Finished'})).revision).toBe(1);
 // The reply settled what this job had taken; settle() is then a repeat that changes nothing, and has nothing left the second time.
 expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['done','done']);const before=f.requests.length;await f.client.settle();await f.client.settle();expect(f.requests.slice(before).map(r=>r.url.split('/').at(-1))).toEqual(['confirm']);
 expect(JSON.stringify(f.db.select().from(s.operationResults).all())).not.toContain('PRIVATE');expect(f.fetcher.mock.calls.every(([,init])=>init?.redirect==='error'&&init.signal)).toBe(true);
});
it('retains only accepted IDs, repeats an uncertain receipt before taking more, and never hands the sink the same mail twice',async()=>{
 const f=await fixture();await f.send('PRIVATE ONCE','one');const native=f.fetcher.getMockImplementation()!;let lost=false;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await native(url,init);if(String(url).endsWith('/accept')&&!lost){lost=true;await response.body?.cancel();throw Error('PRIVATE transport diagnostic');}return response;});
 const timers=vi.spyOn(f.clock,'at'),accept=vi.fn(async()=>{}),taking=f.client.takeAndAccept(accept);await vi.waitFor(()=>expect(timers).toHaveBeenCalledWith(f.clock.now()+1000,expect.any(Function)));f.clock.advance(1000);
 expect(await taking).toEqual({accepted:1,stopRequested:false});expect(accept).toHaveBeenCalledTimes(1);expect(f.db.select().from(s.messages).get()?.delivery).toBe('delivered');
 expect(await f.client.takeAndAccept(accept)).toEqual({accepted:0,stopRequested:false});expect(accept).toHaveBeenCalledTimes(1);expect(f.requests.map(r=>r.url.split('/').at(-1))).toEqual(['take','accept','accept','take']);expect(f.requests[1].body).toEqual(f.requests[2].body);
 // Settling is the same: an uncertain confirmation is sent again under the same operation id.
 lost=false;f.fetcher.mockImplementation(async(url,init)=>{const response=await native(url,init);if(String(url).endsWith('/confirm')&&!lost){lost=true;await response.body?.cancel();throw Error('PRIVATE transport diagnostic');}return response;});
 const settling=f.client.settle();await vi.waitFor(()=>expect(timers).toHaveBeenCalledWith(f.clock.now()+1000,expect.any(Function)));f.clock.advance(1000);await settling;expect(f.requests.at(-1)!.body).toEqual(f.requests.at(-2)!.body);expect(f.db.select().from(s.inbox).get()?.state).toBe('done');
});
it('keeps only the accepted prefix after a later sink failure, and settles it with the rest',async()=>{
 const f=await fixture();await f.send('First','one');await f.send('Second','two');const seen:string[]=[];let failed=false;
 const accept=async(row:{words:string|null})=>{if(row.words==='Second'&&!failed){failed=true;throw Error('PRIVATE sink detail');}seen.push(row.words!);};
 await expect(f.client.takeAndAccept(accept)).rejects.toThrow('Conversation body request failed');expect(f.requests.map(r=>r.url.split('/').at(-1))).toEqual(['take']);
 expect(await f.client.takeAndAccept(accept)).toEqual({accepted:1,stopRequested:false});expect(seen).toEqual(['First','Second']);expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['taken','taken']);await f.client.settle();expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['done','done']);
});
it.each(['close','abort'] as const)('ends a held acceptance on %s without confirming, and forbids concurrent input',async how=>{
 const f=await fixture();await f.send('PRIVATE HELD','one');let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});let sinkSignal:AbortSignal|undefined;
 const pending=f.client.takeAndAccept(async(_row,signal)=>{sinkSignal=signal;entered();await new Promise<void>(()=>{});});await started;
 await expect(f.client.takeAndAccept(async()=>{})).rejects.toThrow('Conversation body request failed');if(how==='close')f.client.close();else f.abort.abort();await expect(pending).rejects.toThrow('Conversation body request failed');expect(sinkSignal?.aborted).toBe(true);expect(f.requests).toHaveLength(1);expect(f.db.select().from(s.messages).get()?.delivery).toBe('sending');
});
it('withholds a later item that expires while an earlier item is being accepted',async()=>{
 const f=await fixture();await f.send('First','one');await f.send('PRIVATE EXPIRES','two');let time=f.clock.now();vi.spyOn(f.clock,'now').mockImplementation(()=>time);f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(time+1000).toISOString()}).where(eq(s.messages.seq,2)).run());const seen:(string|null)[]=[];
 await f.client.takeAndAccept(async row=>{seen.push(row.words);time+=1000;});expect(seen).toEqual(['First',null]);
});
it('sanitizes upstream diagnostics and rejects insecure credential URLs before fetching',async()=>{
 const abort=new AbortController(),fetcher=vi.fn<typeof fetch>(async()=>new Response('PRIVATE TOKEN URL WORDS',{status:403}));
 for(const url of ['http://remote.invalid','https://user:pass@loom.invalid','https://loom.invalid/path','https://loom.invalid/?token=x'])expect(()=>bodyConversationClient({url,token:raw.body,job:'job',conversation:'cv',signal:abort.signal,fetch:fetcher})).toThrow('Conversation body request failed');
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:'cv',signal:abort.signal,fetch:fetcher});clean.push(()=>client.close());await expect(client.status({state:'idle',work:''})).rejects.toThrow(/^Conversation body request failed; outcome may be uncertain$/);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps the bounded deadline active while an upstream response body is stalled',async()=>{
 const f=await fixture();let cancel=false;const stream=new ReadableStream<Uint8Array>({cancel(){cancel=true;}});
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:f.abort.signal,clock:f.clock,timeoutMs:1000,fetch:async()=>new Response(stream,{headers:{'content-type':'application/json'}})});clean.push(()=>client.close());
 const pending=client.status({state:'idle',work:''});const checked=expect(pending).rejects.toThrow('Conversation body request failed');await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));f.clock.advance(1000);f.abort.abort();await checked;expect(cancel).toBe(true);
});
it.each(['job','conversation','order','duplicate','limit','extra','extra-item','deadline'] as const)('rejects a malformed %s batch before acceptance or confirmation',async change=>{
 const f=await fixture(),base={id:'one',seq:1,source:'thread',sourceId:'m1',fromKind:'person',fromId:'alice',at:new Date(f.clock.now()).toISOString(),words:'PRIVATE MALFORMED',keepUntil:null,verdict:null,refs:[]};const value:{job:string;conversation:string;items:Record<string,unknown>[];stopRequested:boolean;extra?:boolean}={job:'job',conversation:f.thread.conversation,items:[base],stopRequested:false};
 if(change==='job')value.job='other';if(change==='conversation')value.conversation='other';if(change==='order')value.items=[{...base,id:'two',seq:2},base];if(change==='duplicate')value.items=[base,{...base,seq:2}];if(change==='limit')value.items=[base,{...base,id:'two',seq:2}];if(change==='extra')value.extra=true;if(change==='extra-item')value.items=[{...base,privateExtra:'PRIVATE UNKNOWN FIELD'}];if(change==='deadline')value.items=[{...base,keepUntil:'not-a-time'}];
 f.fetcher.mockResolvedValue(Response.json({ok:true,value}));const accept=vi.fn(async()=>{});await expect(f.client.takeAndAccept(accept,change==='limit'?1:50)).rejects.toThrow('Conversation body request failed');expect(accept).not.toHaveBeenCalled();expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('rejects an oversized request before any fetch',async()=>{
 const f=await fixture();await expect(f.client.reply({clientId:'large',words:'x'.repeat(1_048_577)})).rejects.toThrow('Conversation body request failed');expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(['declared','streamed'] as const)('cancels a %s oversized valid response before acceptance',async mode=>{
 const f=await fixture(),value={job:'job',conversation:f.thread.conversation,stopRequested:false,items:[{id:'large',seq:1,source:'thread',sourceId:null,fromKind:'person',fromId:'alice',at:new Date(f.clock.now()).toISOString(),words:mode==='streamed'?'x'.repeat(16_777_216):'Fictitious',keepUntil:null,verdict:null,refs:[]}]};
 const bytes=new TextEncoder().encode(JSON.stringify({ok:true,value}));let sent=false,cancelled=false;
 const stream=new ReadableStream<Uint8Array>({pull(controller){if(sent)controller.close();else{sent=true;controller.enqueue(bytes);}},cancel(){cancelled=true;}},{highWaterMark:0});
 f.fetcher.mockResolvedValue(new Response(stream,{headers:{'content-type':'application/json',...(mode==='declared'?{'content-length':'16777217'}:{})}}));const accept=vi.fn(async()=>{});
 await expect(f.client.takeAndAccept(accept,1)).rejects.toThrow('Conversation body request failed');expect(cancelled).toBe(true);expect(accept).not.toHaveBeenCalled();expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each([['abort','fetch'],['close','fetch'],['abort','body'],['close','body']] as const)('ends parent %s during stalled %s and cancels any late response',async(how,phase)=>{
 const f=await fixture();let entered!:()=>void,release!:(response:Response)=>void;const started=new Promise<void>(r=>{entered=r;});let cancelled=false;
 const stream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}},{highWaterMark:0}),response=new Response(stream,{headers:{'content-type':'application/json'}});
 f.fetcher.mockImplementation(async()=>{entered();return phase==='body'?response:new Promise<Response>(r=>{release=r;});});
 const accept=vi.fn(async()=>{}),pending=f.client.takeAndAccept(accept);await started;await Promise.resolve();if(how==='close')f.client.close();else f.abort.abort();await expect(pending).rejects.toThrow('Conversation body request failed');
 if(phase==='fetch'){release(response);await Promise.resolve();await Promise.resolve();}
 expect(cancelled).toBe(true);expect(accept).not.toHaveBeenCalled();expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it.each(['http://localhost','http://127.0.0.1','http://[::1]'])('uses fixed authenticated conversation endpoints on loopback origin %s',async url=>{
 const f=await fixture(),client=bodyConversationClient({url,token:raw.body,job:'job',conversation:f.thread.conversation,signal:f.abort.signal,clock:f.clock,fetch:f.fetcher});clean.push(()=>client.close());
 expect(await client.status({state:'idle',work:'Ready'})).toEqual({saved:true,stopRequested:false});expect(f.requests[0].url).toBe(url+'/api/conversation/status');expect(f.requests[0].body).toMatchObject({input:{state:'idle',work:'Ready'},id:expect.any(String)});
});
it.each(['reply','card','status','turn','digest','finding','confirm'] as const)('rejects extra private words in the %s acknowledgement',async method=>{
 const f=await fixture(),values={reply:{saved:true,seq:1},card:{saved:true,seq:1},status:{saved:true,stopRequested:false},turn:{saved:true,conversation:f.thread.conversation,seq:1},digest:{saved:true,digest:'dg',revision:1,item:null},finding:{saved:true,day:'2026-11-14'},accept:{saved:true},confirm:{saved:true}};
 const native=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith('/take')?native(url,init):Response.json({ok:true,value:{...values[method],words:'PRIVATE ACK LEAK'}}));
 let pending:Promise<unknown>;
 if(method==='reply')pending=f.client.reply({clientId:'r',words:'Fictitious'});
 else if(method==='card')pending=f.client.card({clientId:'c',words:'Fictitious',tool:'Read',cardState:'done'});
 else if(method==='status')pending=f.client.status({state:'idle',work:''});
 else if(method==='turn')pending=f.client.turn({kind:'note'});
 else if(method==='digest')pending=f.client.digest({summary:'Finished'});
 else if(method==='finding')pending=f.client.finding({turnSeq:1,measure:'useful',score:4,text:'Fictitious review'});
 else {await f.send('Fictitious input','one');pending=f.client.takeAndAccept(async()=>{});}
 await expect(pending).rejects.toThrow(/^Conversation body request failed; outcome may be uncertain$/);
});

it.each(['timer','after-await'] as const)('expires private input during its own acceptance at %s without a confirmation',async phase=>{
 const f=await fixture();await f.send('PRIVATE ACCEPTANCE DEADLINE','one');let time=f.clock.now();
 f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(time+1000).toISOString()}).run());let sinkSignal:AbortSignal|undefined,release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
 if(phase==='after-await')vi.spyOn(f.clock,'now').mockImplementation(()=>time);
 const pending=f.client.takeAndAccept(async(row,signal)=>{expect(row.words).toBe('PRIVATE ACCEPTANCE DEADLINE');sinkSignal=signal;entered();if(phase==='timer')await new Promise<void>(r=>{release=r;});else time+=1000;});
 const checked=expect(pending).rejects.toThrow('Conversation body request failed');await started;if(phase==='timer')f.clock.advance(1000);await checked;
 expect(sinkSignal?.aborted).toBe(true);expect(f.requests.map(row=>row.url.split('/').at(-1))).toEqual(['take']);expect(f.db.select().from(s.messages).get()?.delivery).toBe('sending');expect(f.db.select().from(s.inbox).get()?.state).toBe('taken');if(phase==='timer')release();
});
it.each(['http','http-oversize','operation'] as const)('does not adapt an ordinary %s take failure',async mode=>{
 const f=await fixture(),accept=vi.fn(async()=>{});
 f.fetcher.mockResolvedValue(Response.json({ok:false,code:'unavailable',message:'Fictitious refusal'},{status:mode.startsWith('http')?403:200,headers:mode==='http-oversize'?{'content-length':'16777217'}:{}}));
 await expect(f.client.takeAndAccept(accept)).rejects.toThrow('Conversation body request failed');
 expect(accept).not.toHaveBeenCalled();expect(f.fetcher).toHaveBeenCalledTimes(1);
 expect(new URL(String(f.fetcher.mock.calls[0][0])).pathname).toBe('/api/conversation/take');
});
it.each(['declared','streamed'] as const)('does not retry a %s oversized non-take response',async mode=>{
 const f=await fixture();let cancelled=false,sent=false;
 const bytes=new TextEncoder().encode(JSON.stringify({ok:true,value:{saved:true,seq:1,extra:mode==='streamed'?'x'.repeat(16_777_216):'Fictitious'}}));
 f.fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({pull(controller){if(sent)controller.close();else{sent=true;controller.enqueue(bytes);}},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{'content-type':'application/json',...(mode==='declared'?{'content-length':'16777217'}:{})}}));
 await expect(f.client.reply({clientId:'reply',words:'PRIVATE REPLY'})).rejects.toThrow('Conversation body request failed');
 expect(f.fetcher).toHaveBeenCalledTimes(1);expect(new URL(String(f.fetcher.mock.calls[0][0])).pathname).toBe('/api/conversation/message');expect(cancelled).toBe(true);
});
