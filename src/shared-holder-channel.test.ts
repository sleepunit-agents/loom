import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,readdirSync,statSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FakeClock} from './core/clock.js';
import {holderChannelPair,inProcessSharedHolder} from '../test/fixtures/shared-holder.js';
import {openSharedHolderStorage} from './shared-holder-storage.js';
import {serveSharedHolderChannel,sharedHolderClient} from './shared-holder-channel.js';
const sqlite=vi.hoisted(()=>({opened:[]as string[],events:[]as Array<{kind:string;path:string}>,paths:new Map<number,string>()}));
vi.mock('better-sqlite3',async original=>{const real=await original<{default:typeof import('better-sqlite3')}>();return {...real,default:new Proxy(real.default,{construct(target,args,newTarget){sqlite.opened.push(String(args[0]));sqlite.events.push({kind:'database',path:String(args[0])});return Reflect.construct(target,args,newTarget);}})};});
vi.mock('node:fs',async original=>{const real=await original<typeof import('node:fs')>();return {...real,
 openSync:new Proxy(real.openSync,{apply(target,thisArg,args){const fd=Reflect.apply(target,thisArg,args);sqlite.paths.set(fd,String(args[0]));return fd;}}),
 fsyncSync(fd:number){sqlite.events.push({kind:'sync',path:sqlite.paths.get(fd)??''});real.fsyncSync(fd);},
 closeSync(fd:number){try{real.closeSync(fd);}finally{sqlite.paths.delete(fd);}},
 renameSync:new Proxy(real.renameSync,{apply(target,thisArg,args){sqlite.events.push({kind:'rename',path:String(args[0])});return Reflect.apply(target,thisArg,args);}}),
};});
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
function home(){const root=mkdtempSync(join(tmpdir(),'shared-holder-channel-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));return join(root,'holder');}
it('keeps actual encrypted storage and retry identity across restart through the inherited-channel protocol',async()=>{
 const directory=home(),clock=new FakeClock(),value=Buffer.from('fictional-holder-value-42'),who={member:'owner',writeId:randomUUID()};
 let app=await inProcessSharedHolder(directory,clock);clean.push(()=>app.close());const key=Buffer.from(app.fingerprintKey);expect(key).not.toEqual(readFileSync(join(directory,'fingerprint.key')));
 await app.holder.set(who,'TOKEN',value,'add');expect(value.toString()).toBe('fictional-holder-value-42');expect(await app.holder.hasReceipt(who)).toBe(true);
 const read=await app.source.read('TOKEN');expect(Buffer.from(read)).toEqual(value);read.fill(0);
 for(const name of readdirSync(directory)){expect(statSync(join(directory,name)).mode&0o077).toBe(0);if(name.startsWith('holder.db'))expect(readFileSync(join(directory,name)).includes(value)).toBe(false);}
 await app.close();expect(app.fingerprintKey.every(byte=>byte===0)).toBe(true);
 app=await inProcessSharedHolder(directory,clock);expect(app.fingerprintKey).toEqual(key);key.fill(0);
 expect(await app.holder.recover(who)).toBe('committed');
 const abandoned={member:'owner',writeId:randomUUID()};expect(await app.holder.recover(abandoned)).toBe('undone');await expect(app.holder.set(abandoned,'OTHER',value,'add')).rejects.toThrow('unavailable');
 const replacement={member:'owner',writeId:randomUUID()};await app.holder.set(replacement,'TOKEN',Buffer.from('replacement'),'replace');expect(Buffer.from(await app.source.read('TOKEN')).toString()).toBe('replacement');
 await app.holder.remove({member:'owner',writeId:randomUUID()},'TOKEN');await expect(app.source.read('TOKEN')).rejects.toThrow('unavailable');
});
it.each(['broken','identity','fingerprint.key','daemon-fingerprint.key'])('never regenerates a %s key over retained encrypted values',async missing=>{
 const directory=home(),app=await inProcessSharedHolder(directory,new FakeClock());await app.holder.set({member:'owner',writeId:randomUUID()},'TOKEN',Buffer.from('retained fictional value'),'add');await app.close();
 const before=readFileSync(join(directory,'holder.db'));if(missing==='broken')writeFileSync(join(directory,'identity'),'broken',{mode:0o600});else unlinkSync(join(directory,missing));
 await expect(inProcessSharedHolder(directory,new FakeClock())).rejects.toThrow('unavailable');expect(readFileSync(join(directory,'holder.db'))).toEqual(before);
});
it('fences the original channel on deadline and refuses late responses',async()=>{
 const {parent,child}=holderChannelPair(),clock=new FakeClock(),client=sharedHolderClient(parent,clock);child.send({op:'ready',key:Buffer.alloc(32,1)},()=>{});const key=await client.ready;key.fill(0);
 const pending=client.source.read('TOKEN'),failed=expect(pending).rejects.toThrow('unavailable');clock.advance(5000);await failed;
 expect(parent.connected).toBe(false);await expect(client.source.read('TOKEN')).rejects.toThrow('unavailable');await client.close();
});
it('rejects malformed replies without exposing their byte buffers',async()=>{
 const {parent,child}=holderChannelPair(),clock=new FakeClock(),client=sharedHolderClient(parent,clock);child.send({op:'ready',key:Buffer.alloc(32,1)},()=>{});(await client.ready).fill(0);
 const pending=client.holder.hasReceipt({member:'owner',writeId:randomUUID()}),failed=expect(pending).rejects.toThrow('unavailable');
 const leaked=Buffer.from('unexpected-value');parent.emit('message',{op:'result',seq:1,ok:true,value:leaked});await failed;expect(leaked.every(byte=>byte===0)).toBe(true);expect(parent.connected).toBe(false);
});

it('refuses excess queued requests and fences pending calls on transport loss',async()=>{
 const {parent,child}=holderChannelPair(),clock=new FakeClock(),client=sharedHolderClient(parent,clock);child.send({op:'ready',key:Buffer.alloc(32,1)},()=>{});(await client.ready).fill(0);
 const pending=Array.from({length:64},()=>client.source.read('TOKEN'));const results=Promise.allSettled(pending);
 await expect(client.source.read('TOKEN')).rejects.toThrow('unavailable');child.disconnect();expect((await results).every(result=>result.status==='rejected')).toBe(true);await client.close();
});
it.each([0,65537])('refuses a %s-byte mutation over the storage channel',async size=>{
 const app=await inProcessSharedHolder(home(),new FakeClock());clean.push(()=>app.close());const value=Buffer.alloc(size,7);
 await expect(app.holder.set({member:'owner',writeId:randomUUID()},'TOKEN',value,'add')).rejects.toThrow('unavailable');expect(value.every(byte=>byte===7)).toBe(true);
});
it('erases each owned sender, holder mutation and holder read buffer without erasing the caller',async()=>{
 const {parent,child}=holderChannelPair(),clock=new FakeClock(),directory=home(),store=await openSharedHolderStorage(directory);
 const sent:Uint8Array[]=[],received:Uint8Array[]=[],read:Uint8Array[]=[];
 const originalSend=parent.send.bind(parent);parent.send=(raw:any,callback)=>{if(raw.value instanceof Uint8Array)sent.push(raw.value);return originalSend(raw,callback);};
 const server=serveSharedHolderChannel(child,async()=>({key:Buffer.alloc(32,1),store:{...store,async set(who,name,value,mode){received.push(value);await store.set(who,name,value,mode);},async read(name){const value=await store.read(name);read.push(value);return value;}}}));
 const client=sharedHolderClient(parent,clock);(await client.ready).fill(0);const input=Buffer.from('fictional-buffer-lifetime');
 await client.holder.set({member:'owner',writeId:randomUUID()},'TOKEN',input,'add');const output=await client.source.read('TOKEN');expect(Buffer.from(output)).toEqual(input);output.fill(0);
 await client.close();await server.done;expect(input.toString()).toBe('fictional-buffer-lifetime');for(const group of [sent,received,read]){expect(group).toHaveLength(1);expect(group[0].every(byte=>byte===0)).toBe(true);}
});

it('bounds holder-side work even if its trusted parent exceeds the client queue limit',async()=>{
 const {parent,child}=holderChannelPair(),directory=home(),store=await openSharedHolderStorage(directory);await store.set({member:'owner',writeId:randomUUID()},'TOKEN',Buffer.from('example'),'add');
 let release!:()=>void,reads=0;const held=new Promise<void>(yes=>{release=yes;});
 const server=serveSharedHolderChannel(child,async()=>({key:Buffer.alloc(32,1),store:{...store,async read(name){reads++;await held;return store.read(name);}}}));
 const ready=new Promise<void>(yes=>parent.once('message',()=>yes()));await ready;
 let dispatched!:()=>void;const sent=new Promise<void>(yes=>{dispatched=yes;});
 for(let seq=1;seq<=65;seq++)parent.send({op:'read',name:'TOKEN',seq},()=>{if(seq===65)dispatched();});await sent;
 expect(reads).toBe(64);release();await server.done;expect(parent.connected).toBe(false);
});

it('opens only its own ciphertext database through the real holder entrypoint',async()=>{
 const directory=home();sqlite.opened.length=0;const app=await inProcessSharedHolder(directory,new FakeClock());
 try{await app.holder.set({member:'owner',writeId:randomUUID()},'TOKEN',Buffer.from('example'),'add');(await app.source.read('TOKEN')).fill(0);}finally{await app.close();}
 expect(sqlite.opened).toEqual([join(directory,'holder.db')]);
});
it.each([0,65537])('refuses and erases an invalid %s-byte holder reply',async size=>{
 const {parent,child}=holderChannelPair(),client=sharedHolderClient(parent,new FakeClock());child.send({op:'ready',key:Buffer.alloc(32,1)},()=>{});(await client.ready).fill(0);
 const pending=client.source.read('TOKEN'),failure=expect(pending).rejects.toThrow('unavailable'),value=Buffer.alloc(size,7);
 parent.emit('message',{op:'result',seq:1,ok:true,value});await failure;expect(value.every(byte=>byte===0)).toBe(true);
});
it('erases nested cyclic malformed reply buffers before retiring the original channel',async()=>{
 const {parent,child}=holderChannelPair(),client=sharedHolderClient(parent,new FakeClock());child.send({op:'ready',key:Buffer.alloc(32,1)},()=>{});(await client.ready).fill(0);
 const pending=client.source.read('TOKEN'),failure=expect(pending).rejects.toThrow('unavailable'),bytes=Buffer.from('unexpected nested bytes');const nested:{x:Uint8Array;again?:unknown}={x:bytes};nested.again=nested;
 parent.emit('message',{op:'result',seq:1,ok:true,value:nested});await failure;expect(bytes.every(byte=>byte===0)).toBe(true);
});

it('accepts a legal refilled client window before prior IPC write callbacks arrive',async()=>{
 const {parent,child}=holderChannelPair(),directory=home(),store=await openSharedHolderStorage(directory);await store.set({member:'owner',writeId:randomUUID()},'TOKEN',Buffer.from('example'),'add');
 const callbacks:Array<()=>void>=[],original=child.send.bind(child);child.send=(raw:any,callback)=>original(raw,error=>{if(raw.op==='result'&&raw.value instanceof Uint8Array)callbacks.push(()=>callback(error));else callback(error);});
 const server=serveSharedHolderChannel(child,async()=>({key:Buffer.alloc(32,1),store})),client=sharedHolderClient(parent,new FakeClock());(await client.ready).fill(0);
 try{const first=await Promise.all(Array.from({length:64},()=>client.source.read('TOKEN')));expect(callbacks).toHaveLength(64);const next=await client.source.read('TOKEN');expect(Buffer.from(next).toString()).toBe('example');for(const value of [...first,next])value.fill(0);}
 finally{for(const callback of callbacks)callback();await client.close();await server.done;}
});
it('durably publishes its complete private key directory before opening ciphertext storage',async()=>{
 const directory=home();sqlite.events.length=0;const app=await inProcessSharedHolder(directory,new FakeClock());await app.close();
 const events=sqlite.events,rename=events.findIndex(row=>row.kind==='rename'),stage=events[rename].path;
 expect(rename).toBeGreaterThan(-1);expect(events.slice(0,rename)).toContainEqual({kind:'sync',path:stage});
 const homePath=join(directory,'..'),parent=events.findIndex((row,index)=>index>rename&&row.kind==='sync'&&row.path===homePath);
 expect(parent).toBeGreaterThan(rename);expect(events.findIndex(row=>row.kind==='database')).toBeGreaterThan(parent);
});
it('erases stray private bytes after close acknowledgment until peer EOF without reopening client IO',async()=>{
 const {parent,child}=holderChannelPair(),client=sharedHolderClient(parent,new FakeClock());child.send({op:'ready',key:Buffer.alloc(32,1)},()=>{});(await client.ready).fill(0);
 child.on('message',(raw:any)=>{if(raw.op==='close')child.send({op:'result',seq:raw.seq,ok:true,value:null},()=>{});});
 try{await client.close();expect(parent.connected).toBe(true);await expect(client.source.read('TOKEN')).rejects.toThrow('unavailable');let received:Uint8Array|undefined;parent.on('message',(raw:any)=>{if(raw.seq===99)received=raw.value;});const original=Buffer.alloc(32,7);
 await new Promise<void>(resolve=>child.send({op:'result',seq:99,ok:true,value:original},()=>resolve()));expect(received).toBeDefined();expect(received!.every(byte=>byte===0)).toBe(true);expect(original.every(byte=>byte===7)).toBe(true);child.disconnect();expect(parent.listenerCount('message')).toBe(1);
 }finally{child.disconnect();}
});
