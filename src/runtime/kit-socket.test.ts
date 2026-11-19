import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {KitRefused} from './kit-refused.js';
import {bodyKitTools} from './body-kit-tools.js';
import {kitSocket} from './kit-socket.js';

it('serves a single job across the worker socket and returns only its bounded result',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'loom-kit-test-'));
 const signal=new AbortController().signal;
 const list=vi.fn(async()=>[{name:'kit_hello',description:'Greet',parameters:{who:{type:'string' as const,description:'Name'}}}]);
 const call=vi.fn(async()=> 'hello');
 const socket=await kitSocket(directory,()=>({list,call}),signal);
 try{
   const tools=await bodyKitTools(socket.path,signal);
   expect(tools.map(tool=>tool.name)).toEqual(['kit_hello']);
   expect(await tools[0].execute({who:'friend'},signal)).toEqual({content:[{type:'text',text:'hello'}]});
   expect(call).toHaveBeenCalledWith('kit_hello',{who:'friend'},expect.anything());
   call.mockRejectedValueOnce(new KitRefused());
   expect(await tools[0].execute({who:'friend'},signal)).toEqual({isError:true,content:[{type:'text',text:new KitRefused().message}]});
 }finally{await socket.close();await rm(directory,{recursive:true,force:true});}
});
