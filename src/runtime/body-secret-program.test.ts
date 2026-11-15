import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterEach,expect,it,vi} from 'vitest';
import {FakeClock} from '../core/clock.js';
import {bodyProgram} from './body-program.js';
import type {WorkerAssignment} from './worker.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();});
const raw='body_'+'a'.repeat(64),privateValue='PRIVATE_STARTUP_VALUE';
const job:WorkerAssignment={id:'job',box:'box',agent:'art',conversation:'cv',thread:'thread',model:'requested',account:'account',harness:'claude',brief:'',house:{repository:'r',file:'f',branch:'next'}};
function fixture(){
 const env:NodeJS.ProcessEnv={PATH:'/bin',ACCOUNT_PROFILE:'/account'},abort=new AbortController(),clock=new FakeClock(),calls:string[]=[],errors=vi.fn();
 let words='',stop=false,pending=false,tick=()=>{},cancel=vi.fn(),notifyPlan=()=>{};
 const planned=new Promise<void>(resolve=>{notifyPlan=resolve;});
 const fetcher=vi.fn<typeof fetch>(async(url,options)=>{
  expect(new Headers(options?.headers).get('authorization')).toBe('Bearer '+raw);
  const path=String(url).split('/').at(-1)!;calls.push(path);
  if(path==='startup'){notifyPlan();return Response.json({aliases:[{alias:'GITHUB_TOKEN'}],...(pending?{pending:true}:{})});}
  if(path==='read')return new Response(new Blob([privateValue]),{headers:{'content-type':'application/octet-stream','x-loom-secret-use':'use-input-'+'a'.repeat(64)}});
  if(path==='confirm'&&String(url).includes('/secrets/'))return Response.json({confirmed:true});
  const values={status:{saved:true,stopRequested:stop},take:{job:'job',conversation:'cv',stopRequested:stop,items:[{id:'mail',seq:1,source:'thread',sourceId:null,fromKind:'person',fromId:'alice',at:'2026-11-15T00:00:00.000Z',words:'ACCEPTED_MAIL',keepUntil:null,verdict:null,refs:[]}]},confirm:{saved:true},message:{saved:true,seq:2}};
  return Response.json({ok:true,value:values[path as keyof typeof values]});
 });
 vi.mocked(spawn).mockImplementation((_command,args,options)=>{
  expect((options as {env:NodeJS.ProcessEnv}).env).toEqual({...env,GITHUB_TOKEN:privateValue});
  expect(JSON.stringify(args)).not.toContain(privateValue);expect(JSON.stringify(options)).not.toContain(raw);
  expect(calls.indexOf('read')).toBeGreaterThan(calls.indexOf('startup'));
  expect(calls.filter(p=>p==='confirm')).toHaveLength(2);
  const child=Object.assign(new EventEmitter(),{stdin:new Writable({write(chunk,_encoding,done){words+=chunk.toString();done();}}),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(()=>true)}) as unknown as ChildProcessWithoutNullStreams;
  queueMicrotask(()=>{const list=args as string[],session=list[list.indexOf('--session-id')+1];
   child.stdout.emit('data',Buffer.from([{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed',content:[{type:'text',text:'Answer'}]}},{type:'result',session_id:session,is_error:false,subtype:'success',result:'Answer'}].map(row=>JSON.stringify(row)).join('\n')));child.emit('close',0);
  });return child;
 });
 const bytes=Buffer.from(JSON.stringify({job,build:'image',bootstrap:{origin:'https://loom.example',job:'job',token:raw}}));
 const options={args:['config'],read:async()=>JSON.stringify({command:'/native/claude',cwd:'/house'}),stdin:async()=>bytes,env,signal:abort.signal,clock,fetch:fetcher,error:errors,schedule:{every:(ms:number,callback:()=>void)=>{expect(ms).toBe(15000);tick=callback;return cancel;}}};
 return{env,abort,clock,calls,errors,options,bytes,planned,cancel,words:()=>words,stop:()=>{stop=true;tick();},tick:()=>tick(),pending:()=>{pending=true;}};
}
it('uses default startup delivery before the actual native constructor and removes its environment on completion',async()=>{
 const f=fixture();expect(await bodyProgram(f.options)).toBe(0);expect(spawn).toHaveBeenCalledOnce();expect(f.words()).toBe('ACCEPTED_MAIL');expect(f.words()).not.toContain(privateValue);expect(f.env).toEqual({PATH:'/bin',ACCOUNT_PROFILE:'/account'});expect(f.errors).not.toHaveBeenCalled();expect(f.bytes.every(b=>b===0)).toBe(true);expect(f.cancel).toHaveBeenCalledOnce();
});
it('observes Stop while default startup consent is pending, without launching a model or injecting late values',async()=>{
 const f=fixture();f.pending();const running=bodyProgram(f.options);await f.planned;f.stop();expect(await running).toBe(0);expect(spawn).not.toHaveBeenCalled();expect(f.calls).not.toContain('read');expect(f.calls).not.toContain('take');expect(f.env.GITHUB_TOKEN).toBeUndefined();expect(f.errors).not.toHaveBeenCalled();expect(f.cancel).toHaveBeenCalledOnce();
});

it.each(['abort','status failure'])('cancels pending default startup on %s without a native launch',async mode=>{
 const f=fixture();f.pending();const fetcher=f.options.fetch;let fail=false;
 const running=bodyProgram({...f.options,fetch:async(url,options)=>{if(fail&&String(url).endsWith('/status'))throw new Error(raw);return fetcher(url,options);}});
 await f.planned;if(mode==='abort')f.abort.abort();else{fail=true;f.tick();}
 expect(await running).toBe(1);expect(spawn).not.toHaveBeenCalled();expect(f.calls).not.toContain('read');expect(f.env.GITHUB_TOKEN).toBeUndefined();expect(f.cancel).toHaveBeenCalledOnce();expect(f.errors).toHaveBeenCalledExactlyOnceWith('Body stopped: invalid input or unavailable execution\n');expect(f.bytes.every(b=>b===0)).toBe(true);
});
