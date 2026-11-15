/** Credential lifetime metadata on the existing private channel, never a value. */
import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FakeClock} from './core/clock.js';
import {sharedHolderClient,serveSharedHolderChannel} from './shared-holder-channel.js';
import {openSharedHolderStorage} from './shared-holder-storage.js';
import {holderChannelPair,inProcessSharedHolder} from '../test/fixtures/shared-holder.js';
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it('reads the persisted generation through the real entry and changes it only with holder values',async()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-holder-generation-')),directory=join(home,'holder'),clock=new FakeClock();
 clean.push(()=>rmSync(home,{recursive:true,force:true}));
 let owner=await inProcessSharedHolder(directory,clock);clean.push(()=>owner.close());
 const before=await owner.source.generation();expect(before).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
 expect(await owner.source.generation()).toBe(before);
 const who={member:'owner',writeId:randomUUID()};
 await owner.holder.set(who,'TOKEN',Buffer.from('FICTITIOUS_GENERATION_VALUE'),'add');
 const changed=await owner.source.generation();expect(changed).not.toBe(before);
 await owner.holder.set(who,'TOKEN',Buffer.from('FICTITIOUS_GENERATION_VALUE'),'add');expect(await owner.source.generation()).toBe(changed);
 await owner.close();await expect(owner.source.generation()).rejects.toThrow('unavailable');
 owner=await inProcessSharedHolder(directory,clock);expect(await owner.source.generation()).toBe(changed);
 await owner.holder.remove({member:'owner',writeId:randomUUID()},'TOKEN');expect(await owner.source.generation()).not.toBe(changed);
});
it.each(['not-a-generation','00000000-0000-1000-8000-000000000000','committed',true,Buffer.from('private malformed metadata')])('rejects malformed generation metadata and retires the channel (%#)',async value=>{
 const {parent,child}=holderChannelPair(),client=sharedHolderClient(parent,new FakeClock());
 child.send({op:'ready',key:Buffer.alloc(32,1)},()=>{});(await client.ready).fill(0);clean.push(()=>client.close());
 const pending=client.source.generation(),failure=expect(pending).rejects.toThrow('unavailable');
 parent.emit('message',{op:'result',seq:1,ok:true,value});await failure;
 expect(parent.connected).toBe(false);if(value instanceof Uint8Array)expect(value.every(byte=>byte===0)).toBe(true);
 await expect(client.source.read('TOKEN')).rejects.toThrow('unavailable');
});
it('does not accept a UUID as a secret-value reply',async()=>{
 const {parent,child}=holderChannelPair(),client=sharedHolderClient(parent,new FakeClock());
 child.send({op:'ready',key:Buffer.alloc(32,1)},()=>{});(await client.ready).fill(0);clean.push(()=>client.close());
 const pending=client.source.read('TOKEN'),failure=expect(pending).rejects.toThrow('unavailable');
 parent.emit('message',{op:'result',seq:1,ok:true,value:randomUUID()});await failure;expect(parent.connected).toBe(false);
});

it('refuses invalid store metadata before putting it on the private wire',async()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-invalid-generation-')),clock=new FakeClock();
 clean.push(()=>rmSync(home,{recursive:true,force:true}));
 const store=await openSharedHolderStorage(join(home,'holder')),{parent,child}=holderChannelPair();
 const frames:unknown[]=[];parent.on('message',value=>frames.push(value));
 const server=serveSharedHolderChannel(child,async()=>({key:Buffer.alloc(32,1),store:{...store,generation:()=> 'invalid store generation'}}));
 const client=sharedHolderClient(parent,clock);(await client.ready).fill(0);
 clean.push(async()=>{await client.close();await server.done;});
 await expect(client.source.generation()).rejects.toThrow('unavailable');
 expect(frames.at(-1)).toEqual({op:'result',seq:1,ok:false,value:null});
});
