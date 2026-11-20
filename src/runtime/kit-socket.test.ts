import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {KitCapacity,KitRefused} from './kit-refused.js';
import {bodyKitTools} from './body-kit-tools.js';
import {kitSocket} from './kit-socket.js';

it('serves a single job across the worker socket and returns only its bounded result',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'loom-kit-test-'));
 const signal=new AbortController().signal;
 const field={type:'string' as const,description:'Sample'};
 const wide=Object.fromEntries(Array.from({length:16},(_,i)=>['field'+i,field]));
 const list=vi.fn(async()=>[{name:'kit_hello',description:'Greet',parameters:{who:field}},{name:'kit_bulk',description:'Submit samples',parameters:wide}]);
 const call=vi.fn(async()=> 'hello');
 const socket=await kitSocket(directory,()=>({list,call}),signal);
 try{
   const tools=await bodyKitTools(socket.path,signal);
   expect(tools.map(tool=>tool.name)).toEqual(['kit_hello','kit_bulk']);
   expect(await tools[0].execute({who:'friend'},signal)).toEqual({content:[{type:'text',text:'hello'}]});
   expect(call).toHaveBeenCalledWith('kit_hello',{who:'friend'},expect.anything());
   const large=Object.fromEntries(Array.from({length:16},(_,n)=>['field'+n,'界'.repeat(4096)]));
   expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(96*1024);
   expect(await tools[1].execute(tools[1].inputSchema.parse(large),signal)).toEqual({content:[{type:'text',text:'hello'}]});
   call.mockRejectedValueOnce(new KitRefused());
   expect(await tools[0].execute({who:'friend'},signal)).toEqual({isError:true,content:[{type:'text',text:new KitRefused().message}]});
 }finally{await socket.close();await rm(directory,{recursive:true,force:true});}
});

it('delivers a fixed unavailability reason to the body when no tool can be listed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-kit-'));
  const signal=new AbortController().signal;
  const socket=await kitSocket(directory,()=>({list:async()=>[],call:vi.fn()}),signal,
    async()=>[{kit:'pond',reason:'house'}]);
  try{
    const unavailable=vi.fn();
    expect(await bodyKitTools(socket.path,signal,unavailable)).toEqual([]);
    expect(unavailable).toHaveBeenCalledWith([{kit:'pond',reason:'house'}]);
  }finally{
    await socket.close();
    await rm(directory,{recursive:true,force:true});
  }
});

it('keeps a listed tool usable when reporting its availability fails',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-kit-'));
  const signal=new AbortController().signal;
  const list=async()=>[{name:'kit_lookup',description:'Lookup',parameters:{}}];
  const socket=await kitSocket(directory,()=>({list,call:async()=>'found'}),signal,
    async()=>{throw Error('report unavailable');});
  try{
    const failed=vi.fn();
    const [lookup]=await bodyKitTools(socket.path,signal,undefined,failed);
    expect(failed).toHaveBeenCalledOnce();
    expect(await lookup.execute({},signal)).toEqual({content:[{type:'text',text:'found'}]});
  }finally{
    await socket.close();
    await rm(directory,{recursive:true,force:true});
  }
});

it('reports both a local capacity failure and an unconfirmed owner report',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-kit-'));
  const signal=new AbortController().signal;
  const socket=await kitSocket(directory,()=>({list:async()=>{throw new KitCapacity();},call:vi.fn()}),
    signal,async()=>{throw Error('report unavailable');});
  try{
    const failed=vi.fn();
    await expect(bodyKitTools(socket.path,signal,undefined,failed)).rejects.toBeInstanceOf(KitCapacity);
    expect(failed).toHaveBeenCalledOnce();
  }finally{
    await socket.close();
    await rm(directory,{recursive:true,force:true});
  }
});
