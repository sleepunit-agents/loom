import {expect,it,vi} from 'vitest';
import {runtimeJobTransport} from './job-transport.js';
import type {WorkerControlRuntime} from './control.js';

it('retains the original connection and deadline receiver across owner configuration changes',async()=>{
  const requests:Array<{url:string;init:RequestInit}>=[];
  const config={url:'http://127.0.0.1:12345',token:'synthetic-runtime-token',job:'original'};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const runtime:WorkerControlRuntime={
    async request(url,init){requests.push({url:String(url),init:init!});await gate;return Response.json({ok:true,value:{job:'original',state:'starting'}});},
    deadline(ms){expect(this).toBe(runtime);expect(ms).toBe(1500);return new AbortController().signal;},
    every(){return ()=>{};},
  };
  const call=runtimeJobTransport(config,runtime);
  const first=call('claimJob',{job:'original'});
  config.url='https://replacement.invalid';config.token='replacement';
  runtime.request=async()=>{throw Error('replacement request must not run');};
  runtime.deadline=()=>{throw Error('replacement deadline must not run');};
  release();await first;await call('reportJob',{job:'original',state:'running'});
  expect(requests).toHaveLength(2);
  expect(requests[0].url).toBe('http://127.0.0.1:12345/api/runtime/claimJob');
  expect(requests[0].init.redirect).toBe('error');
  for(const request of requests){expect(request.url).toContain('http://127.0.0.1:12345/api/runtime/');expect(request.init.headers).toMatchObject({authorization:'Bearer synthetic-runtime-token'});}
});

const config={url:'http://127.0.0.1:12345',token:'synthetic-runtime-token',job:'original'};
it.each([{ok:false,value:{}},{ok:true,value:{},diagnostic:'synthetic-diagnostic'},{value:{}},null])('refuses an invalid response envelope without retrying: %j',async envelope=>{
 const request=vi.fn(async()=>Response.json(envelope));
 const call=runtimeJobTransport(config,{request,deadline:()=>new AbortController().signal,every:()=>()=>{}});
 await expect(call('claimJob',{job:'original'})).rejects.toThrow('reconcile');expect(request).toHaveBeenCalledTimes(1);
});
it.each(['success','transport','status','json'] as const)('keeps input and diagnostics out of every logging sink on %s',async outcome=>{
 const sinks=[vi.spyOn(console,'log'),vi.spyOn(console,'error'),vi.spyOn(console,'warn'),vi.spyOn(console,'info'),vi.spyOn(console,'debug'),vi.spyOn(process.stdout,'write'),vi.spyOn(process.stderr,'write')];
 for(const sink of sinks)sink.mockImplementation((()=>true) as never);
 try {
  const request=vi.fn(async()=>{
   if(outcome==='transport')throw Error('synthetic-private-diagnostic');
   if(outcome==='status')return new Response('synthetic-private-diagnostic',{status:500});
   if(outcome==='json')return new Response('synthetic-private-diagnostic');
   return Response.json({ok:true,value:{job:'original',state:'done'}});
  });
  const call=runtimeJobTransport(config,{request,deadline:()=>new AbortController().signal,every:()=>()=>{}});
  const promise=call('finishJob',{job:'original',log:'synthetic-private-input'});
  if(outcome==='success')await promise;else await expect(promise).rejects.toThrow('Runtime worker start unavailable; reconcile the job before retrying');
  expect(request).toHaveBeenCalledTimes(1);for(const sink of sinks)expect(sink).not.toHaveBeenCalled();
 }finally {for(const sink of sinks)sink.mockRestore();}
});
