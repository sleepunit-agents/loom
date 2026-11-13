import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as foundation from '../foundation.js';
import { run } from './serve.js';
import { FakeClock } from '../core/clock.js';

it('serve --next --staging reaches the new listener and closes cleanly on a signal',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-cli-next-'));
  const actual=foundation.startLoom;
  const started=vi.spyOn(foundation,'startLoom').mockImplementation(options=>actual({...options,port:0,clock:new FakeClock(0)}));
  let ready!:(url:string)=>void;const listening=new Promise<string>(ok=>{ready=ok;});
  const running=run(['--next','--staging','--home',home,'--host','127.0.0.1','--port','8788'],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:text=>{const url=/next app on (http:\/\/\S+)/.exec(text)?.[1];if(url)ready(url);}});
  try{
    const url=await listening;expect(started.mock.calls[0][0]).toMatchObject({home,next:true,staging:true,host:['127.0.0.1'],port:8788});
    expect(await(await fetch(url+'/health')).json()).toEqual({ok:true,next:true,staging:true});
    expect((await fetch(url+'/events')).status).toBe(404);
  }finally{process.emit('SIGTERM');expect(await running).toBe(0);started.mockRestore();rmSync(home,{recursive:true,force:true});}
});
it('staging cannot silently affect old mode',async()=>{
  const error:string[]=[];
  expect(await run(['--staging'],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:s=>error.push(s)})).toBe(2);
  expect(error.join('')).toContain('require --next');
});

it.each([
  {args:[],env:undefined,expected:'default'},
  {args:[],env:'/fixture/env-next',expected:'/fixture/env-next'},
  {args:['--home','/fixture/explicit-next'],env:'/fixture/env-next',expected:'/fixture/explicit-next'},
])('next home uses explicit flag, then environment, then the separate default: $expected',async({args,env,expected})=>{
  const {homedir}=await import('node:os');const {resolve}=await import('node:path');
  vi.stubEnv('LOOM_HOME',env);
  const start=vi.spyOn(foundation,'startLoom').mockResolvedValue({url:'http://127.0.0.1:8788',close:async()=>{}} as never);
  let ready!:()=>void;const listening=new Promise<void>(ok=>{ready=ok;});
  const running=run(['--next',...args],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:()=>ready()});
  try{await listening;expect(start.mock.calls[0][0].home).toBe(expected==='default'?resolve(homedir(),'.config/loom-next'):expected);}
  finally{process.emit('SIGTERM');await running;start.mockRestore();vi.unstubAllEnvs();}
});

it('holder configuration requires next mode and invalid configuration never starts a daemon',async()=>{
  const start=vi.spyOn(foundation,'startLoom');
  const errors:string[]=[];
  const io={stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:(s:string)=>errors.push(s)};
  try {
    expect(await run(['--secret-holder','/does-not-exist'],io)).toBe(2);
    expect(await run(['--next','--secret-holder','/does-not-exist'],io)).toBe(2);
    expect(start).not.toHaveBeenCalled();
    expect(errors).toEqual(['--secret-holder requires --next\n','Invalid local secret holder configuration\n']);
  } finally { start.mockRestore(); }
});

it('holder authority requires next mode and explicit valid private configuration',async()=>{
  const start=vi.spyOn(foundation,'startLoom');const errors:string[]=[];
  const io={stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:(s:string)=>errors.push(s)};
  try {
    expect(await run(['--secret-authority','/does-not-exist'],io)).toBe(2);
    expect(await run(['--next','--secret-authority','/does-not-exist'],io)).toBe(2);
    expect(start).not.toHaveBeenCalled();
    expect(errors).toEqual(['--secret-authority requires --next\n','Invalid secret holder authority configuration\n']);
  } finally {start.mockRestore();}
});
