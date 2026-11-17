import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
import {FakeClock} from '../core/clock.js';
import {Jobs} from './jobs.js';
import {bodyConversationClient} from './conversation-client.js';
import type {WorkerAssignment} from './worker.js';
import {nativeClaudeFixture} from '../../test/fixtures/native-claude.js';
import {BODY_INPUT_BYTES} from './body-input-limit.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const job:WorkerAssignment={id:'job',box:'box',agent:'art',conversation:'cv',model:'requested',account:'fixture',harness:'claude',brief:'',house:{repository:'r',file:'Housefile',branch:'next'}};

it('accepts native UTF8 input near the existing receiving-envelope ceiling',async()=>{
 const f=nativeClaudeFixture(),words='界'.repeat(Math.floor((BODY_INPUT_BYTES-4096)/3)),result=f.run(job,words,f.abort.signal);
 if(f.launch.mock.calls.length)f.finish(f.rows());await expect(result).resolves.toMatchObject({text:'Answer é',model:'observed-model'});expect(f.words()).toBe(words);
 expect(JSON.stringify(f.launch.mock.calls)).not.toContain(words);
});
it('refuses native input above the receiving ceiling before spawn',async()=>{
 const f=nativeClaudeFixture();await expect(f.run(job,'x'.repeat(BODY_INPUT_BYTES+1),f.abort.signal)).rejects.toThrow('Native execution unavailable');expect(f.launch).not.toHaveBeenCalled();expect(f.words()).toBe('');
});
it('keeps native output bounded at one MiB independently of the larger input ceiling',async()=>{
 const f=nativeClaudeFixture(),result=f.run(job,'mail',f.abort.signal);f.finish('x'.repeat(1_048_577));await expect(result).rejects.toThrow();expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
});
it.each(['declared','streamed'] as const)('shrinks an oversized %s unaccepted Root batch without confirming skipped mail',async mode=>{
 const f=await bodyFixture(clean);expect((await f.send('FIRST PRIVATE','one')).status).toBe(200);expect((await f.send('SECOND PRIVATE','two')).status).toBe(200);
 const abort=new AbortController(),limits:number[]=[],accepted:string[]=[],confirmations:string[][]=[],emitted:Uint8Array[]=[],copies:Buffer[]=[];let cancelled=false;
 const client=bodyConversationClient({url:'http://127.0.0.1/',token:raw.body,job:'job',conversation:f.thread.conversation,clock:f.clock,signal:abort.signal,fetch:async(url,init)=>{
  const path=new URL(String(url)).pathname,input=JSON.parse(String(init?.body)).input,response=await f.root.http.request(new Request(url,init));
  if(path.endsWith('/confirm'))confirmations.push(input.items);
  if(path.endsWith('/take')){
   limits.push(input.limit);if(input.limit>1){expect(response.status).toBe(200);await response.body?.cancel();
    let chunks=0;const stream=new ReadableStream<Uint8Array>({pull(controller){const part=new Uint8Array(mode==='streamed'?1_048_576:1).fill(90);emitted.push(part);controller.enqueue(part);if(++chunks>17)controller.close();},cancel(){cancelled=true;}},{highWaterMark:0});
    return new Response(stream,{headers:{'content-type':'application/json',...(mode==='declared'?{'content-length':String(BODY_INPUT_BYTES+1)}:{})}});
   }
  }return response;
 }});clean.push(()=>client.close());
 const original=Buffer.from,spy=vi.spyOn(Buffer,'from').mockImplementation(((...args:unknown[])=>{const result=Reflect.apply(original,Buffer,args) as Buffer;if(emitted.includes(args[0] as Uint8Array))copies.push(result);return result;}) as typeof Buffer.from);
 try{expect(await client.takeAndAccept(async item=>{accepted.push(item.words!);},2)).toEqual({accepted:1,stopRequested:false});}finally{spy.mockRestore();}
 if(mode==='streamed'){expect(emitted.length).toBeGreaterThan(0);expect(copies.length).toBeGreaterThan(0);expect(emitted.every(part=>part.every(byte=>byte===0))).toBe(true);expect(copies.every(part=>part.every(byte=>byte===0))).toBe(true);}
 expect(limits).toEqual([2,1]);expect(cancelled).toBe(true);expect(accepted).toEqual(['FIRST PRIVATE']);
 const items=f.db.select().from(s.inbox).all();expect(confirmations).toEqual([[items[0].id]]);expect(items.map(item=>item.state)).toEqual(['done','taken']);
 f.root.writes.run(()=>new Jobs(f.db,()=>new Date(f.clock.now()).toISOString()).finish('job','box',0));
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,items[1].id)).get()).toMatchObject({state:'waiting',job:null});
 expect(f.db.select().from(s.messages).all().map(message=>message.delivery)).toEqual(['delivered','held']);
});

it('counts UTF8 bytes rather than characters at the native input ceiling',async()=>{
 const f=nativeClaudeFixture(),words='界'.repeat(Math.floor(BODY_INPUT_BYTES/3)+1);
 expect(words.length).toBeLessThan(BODY_INPUT_BYTES);expect(Buffer.byteLength(words)).toBeGreaterThan(BODY_INPUT_BYTES);
 const result=f.run(job,words,f.abort.signal);if(f.launch.mock.calls.length)f.finish(f.rows());
 await expect(result).rejects.toThrow('Native execution unavailable');expect(f.launch).not.toHaveBeenCalled();
});
it('erases source chunks, copies and joined response bytes after rejected JSON without retrying',async()=>{
 const f=await bodyFixture(clean),abort=new AbortController(),part=new TextEncoder().encode('PRIVATE MALFORMED JSON {'),copies:Buffer[]=[],joined:Buffer[]=[];
 const client=bodyConversationClient({url:'http://127.0.0.1/',token:raw.body,job:'job',conversation:f.thread.conversation,clock:f.clock,signal:abort.signal,fetch:vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(part);controller.close();}},{highWaterMark:0}),{headers:{'content-type':'application/json'}}))});clean.push(()=>client.close());
 const from=Buffer.from,concat=Buffer.concat,fromSpy=vi.spyOn(Buffer,'from').mockImplementation(((...args:unknown[])=>{const value=Reflect.apply(from,Buffer,args) as Buffer;if(args[0]===part)copies.push(value);return value;}) as typeof Buffer.from);
 const concatSpy=vi.spyOn(Buffer,'concat').mockImplementation(((...args:unknown[])=>{const value=Reflect.apply(concat,Buffer,args) as Buffer,list=args[0] as readonly Uint8Array[];if(list.length&&list.every(row=>copies.includes(row as Buffer)))joined.push(value);return value;}) as typeof Buffer.concat);
 const accept=vi.fn(async()=>{});
 try{await expect(client.takeAndAccept(accept)).rejects.toThrow('Conversation body request failed');}
 finally{fromSpy.mockRestore();concatSpy.mockRestore();}
 expect(accept).not.toHaveBeenCalled();expect(copies).toHaveLength(1);expect(joined).toHaveLength(1);
 expect([part,...copies,...joined].every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
});
it.each([true,false])('repeatedly halves an odd unaccepted batch through a singleton (success=%s)',async success=>{
 const abort=new AbortController(),limits:number[]=[],accept=vi.fn(async()=>{});
 const client=bodyConversationClient({url:'http://127.0.0.1/',token:raw.body,job:'job',conversation:'cv',clock:new FakeClock(),signal:abort.signal,fetch:async(_url,init)=>{
  const limit=JSON.parse(String(init?.body)).input.limit as number;limits.push(limit);
  if(limit>1||!success)return new Response('',{headers:{'content-type':'application/json','content-length':String(BODY_INPUT_BYTES+1)}});
  return Response.json({ok:true,value:{job:'job',conversation:'cv',items:[],stopRequested:false}});
 }});clean.push(()=>client.close());
 const pending=client.takeAndAccept(accept,7);
 if(success)expect(await pending).toEqual({accepted:0,stopRequested:false});else await expect(pending).rejects.toThrow();
 expect(limits).toEqual([7,3,1]);expect(accept).not.toHaveBeenCalled();
});
it('rechecks actual private assignment on a reduced take after an oversized claimed batch',async()=>{
 const f=await bodyFixture(clean);await f.send('FIRST PRIVATE','one');await f.send('SECOND PRIVATE','two');
 const abort=new AbortController(),limits:number[]=[],accept=vi.fn(async()=>{}),client=bodyConversationClient({url:'http://127.0.0.1/',token:raw.body,job:'job',conversation:f.thread.conversation,clock:f.clock,signal:abort.signal,fetch:async(url,init)=>{
  expect(new URL(String(url)).pathname).toBe('/api/conversation/take');const limit=JSON.parse(String(init?.body)).input.limit as number;limits.push(limit);
  const response=await f.root.http.request(new Request(url,init));
  if(limit===2){expect(response.status).toBe(200);await response.body?.cancel();f.root.writes.run(()=>f.db.delete(s.memberAgents).run());return new Response('',{headers:{'content-type':'application/json','content-length':String(BODY_INPUT_BYTES+1)}});}
  expect(response.status).toBe(403);return response;
 }});clean.push(()=>client.close());
 await expect(client.takeAndAccept(accept,2)).rejects.toThrow();expect(limits).toEqual([2,1]);expect(accept).not.toHaveBeenCalled();
 expect(f.db.select().from(s.inbox).all().map(item=>item.state)).toEqual(['taken','taken']);
});
