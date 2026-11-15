import { expect, it, vi } from 'vitest';
import { bodyProgram } from './body-program.js';
import type { WorkerAssignment } from './worker.js';
const job: WorkerAssignment = { id: 'job', box: 'box', agent: 'art', conversation: 'cv', thread: 'thread', model: 'requested', account: 'sub', harness: 'claude', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' } };
const raw = 'body_' + 'a'.repeat(64);
function fixture() {
  const input = Buffer.from(JSON.stringify({ job, build: 'image', bootstrap: { origin: 'https://loom.example', job: 'job', token: raw } }));
  const abort = new AbortController(), calls: { path: string; body: Record<string, unknown> }[] = [], error = vi.fn();
  const native = vi.fn(async (_job: WorkerAssignment, _words: string, _signal: AbortSignal) => {
    expect(calls.map(row => row.path).filter(path=>path!=='startup')).toEqual(['status', 'take', 'confirm', 'status']);
    expect(input.every(byte => byte === 0)).toBe(true);
    return { text: 'Actual answer', model: 'observed', actions: [{ model: 'action-model' }] };
  });
  let stopRequested = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+raw);
    const path = String(url).split('/').at(-1)!, body = JSON.parse(String(init?.body)); calls.push({ path, body });
    if(path==='startup')return Response.json({aliases:[]});
    const values = {
      take: { job: 'job', conversation: 'cv', stopRequested, items: [{ id: 'mail', seq: 1, source: 'thread', sourceId: null, fromKind: 'person', fromId: 'alice', at: '2026-11-15T00:00:00.000Z', words: 'PRIVATE MAIL', keepUntil: null, verdict: null, refs: [] }] },
      reply:{saved:true}, confirm: { saved: true }, status: { saved: true, stopRequested }, turn: { saved: true, conversation: 'cv', seq: 1 }, message: { saved: true, seq: 2 },
    };
    return Response.json({ ok: true, value: values[path as keyof typeof values] });
  });
  const options = { args: ['config'], read: async () => JSON.stringify({ command: '/native/claude', cwd: '/house' }), stdin: async () => input, env: { ACCOUNT_PROFILE: '/private/profile' }, signal: abort.signal, fetch: fetcher, native, error };
  return { options, input, native, error, calls, abort, stop: () => { stopRequested = true; } };
}
it('accepts within the child, confirms before native execution, and reports actual response/action models', async () => {
  const f = fixture(); expect(await bodyProgram(f.options)).toBe(0);
  expect(f.native).toHaveBeenCalledWith(job, 'PRIVATE MAIL', expect.any(AbortSignal));
  expect(f.calls.find(row => row.path === 'message')?.body.input).toMatchObject({ kind: 'reply', words: 'Actual answer', model: 'observed' });
  expect(f.calls.find(row => row.path === 'turn')?.body.input).toEqual({ kind: 'action', model: 'action-model', outcome: 'progressed' });
  expect(JSON.stringify(f.calls)).not.toContain(raw); expect(f.error).not.toHaveBeenCalled(); expect(f.input.every(byte => byte === 0)).toBe(true);
});
it('runs startup inside the receiving child before any mail acceptance', async () => {
  const f = fixture(); let bytes: Uint8Array | undefined;
  expect(await bodyProgram({ ...f.options, startup: async (assigned, bootstrap, signal) => {
    expect(assigned).toEqual(job); expect(signal.aborted).toBe(false); expect(f.calls.map(row=>row.path)).toEqual(['status']);
    bytes = bootstrap.token; expect(Buffer.from(bytes).toString()).toBe(raw);
  } })).toBe(0); expect(bytes!.every(byte => byte === 0)).toBe(true);
});
it('does not invoke the native model after a Stop', async () => {
  const f = fixture(); f.stop(); expect(await bodyProgram(f.options)).toBe(0); expect(f.native).not.toHaveBeenCalled();
  expect(f.calls.at(-1)?.body.input).toEqual({ state: 'idle', work: '', seenStop: true });
});
it.each(['token', 'job', 'origin', 'harness', 'conversation', 'thread', 'malformed', 'large', 'pre-abort'] as const)('refuses %s before native execution and erases input', async mode => {
  const f = fixture(), value = JSON.parse(f.input.toString());
  if (mode === 'token') value.bootstrap.token = 'machine-credential';
  if (mode === 'job') value.bootstrap.job = 'other-job';
  if (mode === 'origin') value.bootstrap.origin = 'https://loom.example/private/..';
  if (mode === 'harness') value.job.harness = 'codex';
  if (mode === 'conversation') value.job.conversation = null;
  if (mode === 'thread') value.job.thread = null;
  if (mode === 'pre-abort') f.abort.abort();
  const bytes = Buffer.from(mode === 'malformed' ? '{' : mode === 'large' ? 'x'.repeat(1_048_577) : JSON.stringify(value));
  expect(await bodyProgram({ ...f.options, stdin: async () => bytes })).toBe(1); expect(f.native).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  if (mode !== 'pre-abort') expect(bytes.every(byte => byte === 0)).toBe(true);
  expect(f.error).toHaveBeenCalledWith('Body stopped: invalid input or unavailable execution\n');
});
it('erases bootstrap at cancellation while startup remains pending, before its promise settles', async () => {
  const f = fixture(); let entered!: () => void, release!: () => void, bytes: Uint8Array | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = bodyProgram({ ...f.options, startup: async (_job, bootstrap) => { bytes = bootstrap.token; entered(); await new Promise<void>(resolve => { release = resolve; }); } });
  await started; f.abort.abort(); expect(bytes!.every(byte => byte === 0)).toBe(true); expect(f.input.every(byte => byte === 0)).toBe(true); release();
  expect(await pending).toBe(1); expect(f.native).not.toHaveBeenCalled(); expect(f.calls.map(row=>row.path)).toEqual(['status']);
});

it('never reports private native diagnostics as a body error',async()=>{
 const f=fixture();expect(await bodyProgram({...f.options,native:async()=>{throw new Error(raw);}})).toBe(1);
 expect(f.error).toHaveBeenCalledExactlyOnceWith('Body stopped: invalid input or unavailable execution\n');
 expect(JSON.stringify(f.error.mock.calls)).not.toContain(raw);
});

it('honors a Stop arriving after mail acceptance and before native startup',async()=>{
 const f=fixture(),fetcher=f.options.fetch;
 expect(await bodyProgram({...f.options,fetch:async(url,init)=>{const response=await fetcher(url,init);if(String(url).endsWith('/confirm'))f.stop();return response;}})).toBe(0);
 expect(f.native).not.toHaveBeenCalled();expect(f.calls.at(-1)?.body.input).toEqual({state:'idle',work:'',seenStop:true});
});
it('keeps native work reported, serializes beats, and erases bootstrap before stopped native work settles',async()=>{
 const f=fixture(),cancel=vi.fn();let tick!:()=>void,entered!:()=>void,stopped!:()=>void,close!:()=>void,owned:Uint8Array|undefined,startupSignal:AbortSignal|undefined;
 const started=new Promise<void>(resolve=>{entered=resolve;}),cancelled=new Promise<void>(resolve=>{stopped=resolve;}),closed=new Promise<void>(resolve=>{close=resolve;});
 f.native.mockImplementation(async(_job,_words,signal)=>{entered();signal.addEventListener('abort',stopped,{once:true});await closed;throw new Error();});
 const pending=bodyProgram({...f.options,startup:async(_job,bootstrap,signal)=>{owned=bootstrap.token;startupSignal=signal;},
  schedule:{every:(ms,callback)=>{expect(ms).toBe(15_000);tick=callback;return cancel;}}});
 await started;f.stop();tick();tick();await cancelled;expect(owned!.every(byte=>byte===0)).toBe(true);expect(startupSignal!.aborted).toBe(true);close();
 expect(await pending).toBe(0);expect(cancel).toHaveBeenCalledOnce();
 expect(f.calls.filter(row=>row.path==='status'&&(row.body.input as {state:string}).state==='working')).toHaveLength(3);
 expect(f.calls.at(-1)?.body.input).toEqual({state:'idle',work:'',seenStop:true});expect(f.calls.some(row=>row.path==='message')).toBe(false);
});
it('ends native work when a current body status beat fails, without publishing a late reply',async()=>{
 const f=fixture(),fetcher=f.options.fetch;let tick!:()=>void,entered!:()=>void,statuses=0;const started=new Promise<void>(resolve=>{entered=resolve;});
 f.native.mockImplementation(async(_job,_words,signal)=>{entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));throw new Error();});
 const pending=bodyProgram({...f.options,schedule:{every:(_ms,callback)=>{tick=callback;return()=>{};}},fetch:async(url,init)=>{
  if(String(url).endsWith('/status')&&++statuses>2)throw new Error(raw);return fetcher(url,init);
 }});
 await started;tick();expect(await pending).toBe(1);expect(f.calls.some(row=>row.path==='message')).toBe(false);expect(JSON.stringify(f.error.mock.calls)).not.toContain(raw);
});
it('refuses mail arriving after Stop was observed during an outstanding take',async()=>{
 const f=fixture(),fetcher=f.options.fetch;let tick!:()=>void,entered!:()=>void,release!:()=>void,cancelled!:()=>void;
 const taking=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;}),stopped=new Promise<void>(resolve=>{cancelled=resolve;});
 const running=bodyProgram({...f.options,startup:async(_job,_bootstrap,signal)=>{signal.addEventListener('abort',cancelled,{once:true});},schedule:{every:(_ms,callback)=>{tick=callback;return()=>{};}},fetch:async(url,init)=>{
  const response=await fetcher(url,init);if(String(url).endsWith('/take')){entered();await held;}return response;
 }});
 await taking;f.stop();tick();await stopped;release();expect(await running).toBe(0);expect(f.native).not.toHaveBeenCalled();expect(f.calls.some(row=>row.path==='confirm')).toBe(false);expect(f.calls.at(-1)?.body.input).toEqual({state:'idle',work:'',seenStop:true});
});
it('waits for an outstanding serialized status beat before publishing or releasing its client',async()=>{
 const f=fixture(),fetcher=f.options.fetch,cancel=vi.fn();let tick!:()=>void,entered!:()=>void,finish!:()=>void,beatEntered!:()=>void,release!:()=>void,statuses=0,settled=false,execution:AbortSignal|undefined;
 const nativeStarted=new Promise<void>(resolve=>{entered=resolve;}),nativeHeld=new Promise<void>(resolve=>{finish=resolve;}),beatStarted=new Promise<void>(resolve=>{beatEntered=resolve;}),beatHeld=new Promise<void>(resolve=>{release=resolve;});
 f.native.mockImplementation(async()=>{entered();await nativeHeld;return{text:'Answer',model:'observed',actions:[]};});
 const running=bodyProgram({...f.options,startup:async(_job,_bootstrap,signal)=>{execution=signal;},schedule:{every:(_ms,callback)=>{tick=callback;return cancel;}},fetch:async(url,init)=>{
  if(String(url).endsWith('/status')&&++statuses===3){beatEntered();await beatHeld;}return fetcher(url,init);
 }});void running.then(()=>{settled=true;});
 await nativeStarted;tick();tick();await beatStarted;finish();for(let i=0;i<32;i++)await Promise.resolve();expect(settled).toBe(false);expect(execution!.aborted).toBe(true);expect(f.calls.some(row=>row.path==='message')).toBe(false);expect(cancel).toHaveBeenCalledOnce();release();expect(await running).toBe(0);expect(f.calls.filter(row=>row.path==='message')).toHaveLength(1);expect(cancel).toHaveBeenCalledOnce();
});

it.each(['missing-ref','foreign-platform','unsupported-venue'])('refuses a %s bridge route before native execution',async mode=>{
 const f=fixture(),fetcher=f.options.fetch,startup=vi.fn(async()=>{}),value=JSON.parse(f.input.toString());value.job.venue=mode==='unsupported-venue'?'unhandled':'slack';value.job.thread=mode==='unsupported-venue'?'thread':null;const bytes=Buffer.from(JSON.stringify(value));
 expect(await bodyProgram({...f.options,stdin:async()=>bytes,...(mode==='unsupported-venue'?{startup}:{}),fetch:async(url,options)=>{
  const response=await fetcher(url,options);if(!String(url).endsWith('/take'))return response;
  const batch=await response.json();Object.assign(batch.value.items[0],{source:mode==='foreign-platform'?'discord':'slack',refs:mode==='missing-ref'?[]:['bi:fixture']});return Response.json(batch);
 }})).toBe(1);expect(f.native).not.toHaveBeenCalled();expect(f.calls.some(row=>row.path==='confirm')).toBe(false);expect(bytes.every(byte=>byte===0)).toBe(true);if(mode==='unsupported-venue'){expect(startup).not.toHaveBeenCalled();expect(f.calls).toEqual([]);}
});

it('replies to the last accepted matching bridge reference even when its words are unavailable',async()=>{
 const f=fixture(),fetcher=f.options.fetch,value=JSON.parse(f.input.toString());value.job.venue='slack';value.job.thread=null;f.native.mockResolvedValue({text:'Answer',model:'observed',actions:[]});
 expect(await bodyProgram({...f.options,stdin:async()=>Buffer.from(JSON.stringify(value)),fetch:async(url,options)=>{
  const response=await fetcher(url,options);if(!String(url).endsWith('/take'))return response;
  const batch=await response.json(),first={...batch.value.items[0],source:'slack',refs:['bi:first']};batch.value.items=[first,{...first,id:'second',seq:2,words:null,refs:['bi:last']}];return Response.json(batch);
 }})).toBe(0);expect(f.native).toHaveBeenCalledWith(expect.anything(),'PRIVATE MAIL',expect.any(AbortSignal));expect(f.calls.find(row=>row.path==='reply')?.body.input).toMatchObject({incoming:'bi:last',model:'observed'});expect(f.calls.some(row=>row.path==='message')).toBe(false);
});
it('passes retained question context with a short answer to native execution',async()=>{
 const f=fixture(),fetcher=f.options.fetch,question={words:'PRIVATE QUESTION',why:'PRIVATE WHY',ifYes:'PRIVATE YES',ifNo:'PRIVATE NO',link:null};
 const fetchWithContext=async(url:Parameters<typeof fetcher>[0],init?:Parameters<typeof fetcher>[1])=>{
  const response=await fetcher(url,init);
  if(new URL(String(url)).pathname.endsWith('/take')){const value=await response.json();value.value.items[0]={...value.value.items[0],source:'answer',words:'yes',verdict:'yes',question,questionKeepUntil:'9999-01-01T00:00:00.000Z'};return Response.json(value);}
  return response;
 };
 expect(await bodyProgram({...f.options,fetch:fetchWithContext})).toBe(0);
 expect(f.native).toHaveBeenCalledWith(job,JSON.stringify({question,answer:'yes',verdict:'yes'}),expect.any(AbortSignal));
 expect(JSON.stringify(f.calls)).not.toContain('PRIVATE QUESTION');
});
