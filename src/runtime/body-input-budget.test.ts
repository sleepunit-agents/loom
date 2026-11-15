import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
import {Jobs} from './jobs.js';
import {bodyConversationClient} from './conversation-client.js';
import {claudeBody,type ClaudeSpawn} from './claude-body.js';
import type {WorkerAssignment} from './worker.js';
import {BODY_INPUT_BYTES} from './body-input-limit.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const job:WorkerAssignment={id:'job',box:'box',agent:'art',conversation:'cv',model:'requested',account:'fixture',harness:'claude',brief:'',house:{repository:'r',file:'Housefile',branch:'next'}};
function nativeFixture(){
 let input='';
 const child=Object.assign(new EventEmitter(),{stdin:new Writable({write(chunk,_encoding,done){input+=chunk.toString();done();}}),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(()=>{child.emit('close',null);return true;})}) as unknown as ChildProcessWithoutNullStreams;
 const spawn=vi.fn<ClaudeSpawn>(()=>child),abort=new AbortController(),run=claudeBody({command:'/fixture/claude',cwd:'/fixture',env:{},spawn});
 const finish=(overflow=false)=>{if(overflow)(child.stdout as PassThrough).write('x'.repeat(1_048_577));else{const args=spawn.mock.calls[0][1],session=args[args.indexOf('--session-id')+1];(child.stdout as PassThrough).write([{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed',content:[{type:'text',text:'Answer'}]}},{type:'result',session_id:session,subtype:'success',is_error:false,result:'Answer'}].map(row=>JSON.stringify(row)).join('\n'));}child.emit('close',0);};
 return {run,spawn,abort,finish,input:()=>input,child};
}
it('accepts native UTF8 input near the existing receiving-envelope ceiling',async()=>{
 const f=nativeFixture(),words='界'.repeat(Math.floor((BODY_INPUT_BYTES-4096)/3)),result=f.run(job,words,f.abort.signal);
 if(f.spawn.mock.calls.length)f.finish();await expect(result).resolves.toMatchObject({text:'Answer',model:'observed'});expect(f.input()).toBe(words);
 expect(JSON.stringify(f.spawn.mock.calls)).not.toContain(words);
});
it('refuses native input above the receiving ceiling before spawn',async()=>{
 const f=nativeFixture();await expect(f.run(job,'x'.repeat(BODY_INPUT_BYTES+1),f.abort.signal)).rejects.toThrow('Native Claude execution unavailable');expect(f.spawn).not.toHaveBeenCalled();expect(f.input()).toBe('');
});
it('keeps native output bounded at one MiB independently of the larger input ceiling',async()=>{
 const f=nativeFixture(),result=f.run(job,'mail',f.abort.signal);f.finish(true);await expect(result).rejects.toThrow();expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
});
it.each(['declared','streamed'] as const)('shrinks an oversized %s unaccepted Root batch without confirming skipped mail',async mode=>{
 const f=await bodyFixture(clean);expect((await f.send('FIRST PRIVATE','one')).status).toBe(200);expect((await f.send('SECOND PRIVATE','two')).status).toBe(200);
 const abort=new AbortController(),limits:number[]=[],accepted:string[]=[],confirmations:string[][]=[];let cancelled=false;
 const client=bodyConversationClient({url:'http://127.0.0.1/',token:raw.body,job:'job',conversation:f.thread.conversation,clock:f.clock,signal:abort.signal,fetch:async(url,init)=>{
  const path=new URL(String(url)).pathname,input=JSON.parse(String(init?.body)).input,response=await f.root.http.request(new Request(url,init));
  if(path.endsWith('/confirm'))confirmations.push(input.items);
  if(path.endsWith('/take')){
   limits.push(input.limit);if(input.limit>1){expect(response.status).toBe(200);await response.body?.cancel();
    let chunks=0;const stream=new ReadableStream<Uint8Array>({pull(controller){if(mode==='streamed')controller.enqueue(new Uint8Array(1_048_576));else controller.enqueue(new Uint8Array(1));if(++chunks>17)controller.close();},cancel(){cancelled=true;}},{highWaterMark:0});
    return new Response(stream,{headers:{'content-type':'application/json',...(mode==='declared'?{'content-length':String(BODY_INPUT_BYTES+1)}:{})}});
   }
  }return response;
 }});clean.push(()=>client.close());
 expect(await client.takeAndAccept(async item=>{accepted.push(item.words!);},2)).toEqual({accepted:1,stopRequested:false});
 expect(limits).toEqual([2,1]);expect(cancelled).toBe(true);expect(accepted).toEqual(['FIRST PRIVATE']);
 const items=f.db.select().from(s.inbox).all();expect(confirmations).toEqual([[items[0].id]]);expect(items.map(item=>item.state)).toEqual(['done','taken']);
 f.root.writes.run(()=>new Jobs(f.db,()=>new Date(f.clock.now()).toISOString()).finish('job','box',0));
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,items[1].id)).get()).toMatchObject({state:'waiting',job:null});
 expect(f.db.select().from(s.messages).all().map(message=>message.delivery)).toEqual(['delivered','held']);
});
