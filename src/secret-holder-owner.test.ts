import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {holderOwner,serveHolderOwner} from './secret-holder-owner.js';
import {run} from './secret-holder.js';
import {pair} from './secret-holder-owner.fixture.js';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const binding=()=>({agent:'art',job:randomUUID(),runner:'r',box:'b',claimedAt:42});
const fingerprint=Array(32).fill('AB').join(':');
function worker(){return {binding:binding(),fingerprint,config:{socket:'/private/input.sock',ca:'/private/ca',cert:'/private/cert',key:'/private/key',servername:'worker.test'}};}
const cleanups:Array<()=>unknown>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();vi.useRealTimers();});
async function setup(){
  const {parent,child}=pair(),replaceOwnedWorkers=vi.fn(async(_workers:unknown)=>{}),close=vi.fn(async()=>{});
  const server=serveHolderOwner(child,async()=>({replaceOwnedWorkers,close}));
  const client=holderOwner(parent);cleanups.push(async()=>{client.abort();await server.close().catch(()=>{});await server.done.catch(()=>{});});
  await client.ready;return {parent,child,replaceOwnedWorkers,close,server,client};
}
it('carries binding and peer pin only, joins replacement before ack, and closes original holder',async()=>{
  const f=await setup(),hold=deferred(),entered=deferred();
  f.replaceOwnedWorkers.mockImplementation(async()=>{entered.resolve();await hold.promise;});
  const selected=worker(),original=structuredClone(selected);
  let acknowledged=false;const replacing=f.client.replaceWorkers([selected]).then(()=>{acknowledged=true;});
  selected.binding.claimedAt=99;selected.fingerprint='bad';selected.config.key='SENTINEL-KEY';
  await entered.promise;await new Promise<void>(resolve=>setImmediate(resolve));expect(acknowledged).toBe(false);
  expect(f.child.messages).toEqual([{op:'ready',seq:0}]);
  expect(f.replaceOwnedWorkers).toHaveBeenCalledWith([{binding:original.binding,fingerprint}]);
  expect(JSON.stringify(f.parent.messages)).not.toMatch(/private|SENTINEL|config|key/);
  hold.resolve();await replacing;
  await f.client.replaceWorkers([]);expect(f.replaceOwnedWorkers).toHaveBeenLastCalledWith([]);
  await f.client.close();await f.server.close();await expect(f.server.done).resolves.toBeUndefined();expect(f.close).toHaveBeenCalledOnce();
});
it('joins late startup after original channel loss',async()=>{
  const {parent,child}=pair(),entered=deferred(),hold=deferred(),close=vi.fn(async()=>{});
  const server=serveHolderOwner(child,async()=>{entered.resolve();await hold.promise;return {close,replaceOwnedWorkers:vi.fn()};});
  const client=holderOwner(parent);await entered.promise;client.abort();
  let joined=false;const stopping=server.close().then(()=>{joined=true;},()=>{joined=true;});
  await Promise.resolve();expect(joined).toBe(false);hold.resolve();await stopping;
  await expect(server.done).rejects.toThrow('Secret holder owner unavailable');expect(close).toHaveBeenCalledOnce();
  expect(child.messages).toEqual([]);
});
it('still closes the initialized original holder when ready acknowledgement fails',async()=>{
  const {parent,child}=pair(),close=vi.fn(async()=>{});
  vi.spyOn(child,'send').mockImplementation((_m,cb)=>{cb(new Error('lost'));return false;});
  const server=serveHolderOwner(child,async()=>({close,replaceOwnedWorkers:vi.fn()}));
  const client=holderOwner(parent);
  await expect(client.ready).rejects.toThrow();await expect(server.done).rejects.toThrow();expect(close).toHaveBeenCalledOnce();
});
it.each(['extra','value','path','duplicate','sequence','unknown'] as const)('poisons inherited channel on %s command without invoking holder',async kind=>{
  const f=await setup();let message:unknown={op:'replace',seq:1,workers:[{binding:binding(),fingerprint}]};
  if(kind==='extra'||kind==='value'||kind==='path')Object.assign(message!,{[kind]:'PRIVATE-SENTINEL'});
  if(kind==='sequence')Object.assign(message!,{seq:3});
  if(kind==='unknown')message={op:'read',seq:1,name:'API'};
  if(kind==='duplicate')message={op:'replace',seq:0,workers:[]};
  f.parent.send(message,()=>{});await expect(f.server.done).rejects.toThrow();expect(f.replaceOwnedWorkers).not.toHaveBeenCalled();
});
it.each(['capacity','nested-extra','nested-invalid','pin-invalid','missing-binding','non-array'])('protocol refuses %s worker selection before invoking original holder',async kind=>{
  const f=await setup(),selected:{binding?:unknown;fingerprint:string}={binding:binding(),fingerprint};
  if(kind==='nested-extra')Object.assign(selected.binding!,{value:'PRIVATE-SENTINEL'});
  if(kind==='nested-invalid')Object.assign(selected.binding!,{claimedAt:'42'});
  if(kind==='pin-invalid')selected.fingerprint='not-a-pin';
  if(kind==='missing-binding')delete selected.binding;
  f.parent.send({op:'replace',seq:1,workers:kind==='capacity'?Array(1025).fill(selected):kind==='non-array'?selected:[selected]},()=>{});
  await new Promise<void>(resolve=>setImmediate(resolve));expect(f.replaceOwnedWorkers).not.toHaveBeenCalled();expect(f.parent.connected).toBe(false);
  await expect(f.server.done).rejects.toThrow();
  await expect(f.client.replaceWorkers([worker()])).rejects.toThrow();
  expect(f.close).toHaveBeenCalledOnce();
});
it('fences a second request while replacement is draining and joins the first before holder close',async()=>{
  const f=await setup(),hold=deferred(),entered=deferred();
  f.replaceOwnedWorkers.mockImplementation(async()=>{entered.resolve();await hold.promise;});
  const pending=f.client.replaceWorkers([worker()]);void pending.catch(()=>{});await entered.promise;
  f.parent.send({op:'replace',seq:2,workers:[]},()=>{});
  await Promise.resolve();await Promise.resolve();await Promise.resolve();expect(f.close).toHaveBeenCalledOnce();
  hold.resolve();await expect(pending).rejects.toThrow();await expect(f.server.done).rejects.toThrow();
  expect(f.close).toHaveBeenCalledOnce();expect(f.child.messages).toEqual([{op:'ready',seq:0}]);
});
it.each(['wrong-sequence','wrong-kind','extra','duplicate-ready'])('poisons original client on %s ack and never retries',async kind=>{
  const f=await setup(),hold=deferred(),entered=deferred();
  f.replaceOwnedWorkers.mockImplementation(async()=>{entered.resolve();await hold.promise;});
  const pending=f.client.replaceWorkers([worker()]);void pending.catch(()=>{});await entered.promise;
  const value=kind==='wrong-sequence'?{op:'replaced',seq:2}:kind==='wrong-kind'?{op:'closed',seq:1}:
    kind==='extra'?{op:'replaced',seq:1,value:'SENTINEL'}:{op:'ready',seq:0};
  f.child.send(value,()=>{});await expect(pending).rejects.toThrow();hold.resolve();
  await expect(f.client.replaceWorkers([])).rejects.toThrow();expect(f.parent.messages).toHaveLength(1);
});
it('retires on lost replacement ack and disallows retry even with identical metadata',async()=>{
  vi.useFakeTimers();const f=await setup();f.child.drop=true;
  const pending=f.client.replaceWorkers([worker()]);void pending.catch(()=>{});
  await vi.advanceTimersByTimeAsync(5000);await expect(pending).rejects.toThrow();
  await expect(f.client.replaceWorkers([])).rejects.toThrow();await expect(f.server.done).rejects.toThrow();
  expect(f.parent.messages).toHaveLength(1);expect(f.close).toHaveBeenCalledOnce();
});
it('joins pending replacement when parent dies and never acknowledges the retired generation',async()=>{
  const f=await setup(),hold=deferred(),entered=deferred();
  f.replaceOwnedWorkers.mockImplementation(async()=>{entered.resolve();await hold.promise;});
  const pending=f.client.replaceWorkers([worker()]);void pending.catch(()=>{});await entered.promise;f.client.abort();
  await Promise.resolve();await Promise.resolve();expect(f.close).toHaveBeenCalledOnce();hold.resolve();
  await expect(pending).rejects.toThrow();await expect(f.server.done).rejects.toThrow();expect(f.close).toHaveBeenCalledOnce();
  expect(f.child.messages).toEqual([{op:'ready',seq:0}]);
});
it('does not acknowledge failed route replacement or holder close',async()=>{
  const f=await setup();f.replaceOwnedWorkers.mockRejectedValue(new Error('PRIVATE-SENTINEL'));
  await expect(f.client.replaceWorkers([worker()])).rejects.toThrow('Secret holder owner unavailable');
  await expect(f.server.done).rejects.toThrow('Secret holder owner unavailable');expect(f.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.child.messages)).not.toContain('PRIVATE');
});
it('close acknowledgement waits for original holder shutdown',async()=>{
  const f=await setup(),hold=deferred(),entered=deferred();f.close.mockImplementation(async()=>{entered.resolve();await hold.promise;});
  let done=false;const pending=f.client.close().then(()=>{done=true;});await entered.promise;expect(done).toBe(false);
  hold.resolve();await pending;
});
it('never acknowledges failed holder shutdown or reuses its channel',async()=>{
  const f=await setup();f.close.mockRejectedValue(new Error('PRIVATE-CLOSE'));
  const pending=f.client.close();await expect(pending).rejects.toThrow('Secret holder owner unavailable');
  await expect(f.server.done).rejects.toThrow('Secret holder owner unavailable');
  await expect(f.server.close()).rejects.toThrow('Secret holder owner unavailable');
  expect(f.child.messages).toEqual([{op:'ready',seq:0}]);expect(f.client.close()).toBe(pending);
  await expect(f.client.replaceWorkers([])).rejects.toThrow();
});
it('poisons concurrent owner calls instead of queueing or adopting a later generation',async()=>{
  const f=await setup(),entered=deferred(),hold=deferred();
  f.replaceOwnedWorkers.mockImplementation(async()=>{entered.resolve();await hold.promise;});
  const pending=f.client.replaceWorkers([worker()]);void pending.catch(()=>{});await entered.promise;
  await expect(f.client.replaceWorkers([])).rejects.toThrow();hold.resolve();await expect(pending).rejects.toThrow();
  await expect(f.server.done).rejects.toThrow();expect(f.parent.messages).toHaveLength(1);
});
it('times out missing startup ack without sending a route selection',async()=>{
  vi.useFakeTimers();const {parent,child}=pair();child.drop=true;
  const close=vi.fn(async()=>{}),server=serveHolderOwner(child,async()=>({close,replaceOwnedWorkers:vi.fn()}));
  const client=holderOwner(parent);const pending=client.replaceWorkers([worker()]);void pending.catch(()=>{});
  await vi.advanceTimersByTimeAsync(5000);await expect(pending).rejects.toThrow();await expect(server.done).rejects.toThrow();
  expect(parent.messages).toEqual([]);expect(close).toHaveBeenCalledOnce();
});
it('joins original holder close after local signal-style shutdown',async()=>{
  const f=await setup();await f.server.close();await expect(f.server.done).resolves.toBeUndefined();
  expect(f.close).toHaveBeenCalledOnce();await expect(f.client.replaceWorkers([])).rejects.toThrow();
});
it.each(['duplicate','malformed'])('withholds close ack after %s command poisons held shutdown',async kind=>{
  const f=await setup(),entered=deferred(),hold=deferred();f.close.mockImplementation(async()=>{entered.resolve();await hold.promise;});
  const pending=f.client.close();void pending.catch(()=>{});await entered.promise;
  f.parent.send(kind==='duplicate'?{op:'close',seq:1}:{op:'read',seq:2},()=>{});
  await new Promise<void>(resolve=>setImmediate(resolve));hold.resolve();
  await expect(pending).rejects.toThrow();await expect(f.server.done).rejects.toThrow();
  expect(f.child.messages).toEqual([{op:'ready',seq:0}]);expect(f.close).toHaveBeenCalledOnce();
});
it('packaged owned entrypoint refuses an absent inherited channel and mixed legacy arguments',async()=>{
  const connected=process.connected,stderr=vi.fn();
  try {
    Object.defineProperty(process,'connected',{value:false,configurable:true,writable:true});
    expect(await run(['--owned','--config','/no/such/config'],stderr)).toBe(2);
    expect(await run(['--owned','--socket','/no/such/socket'],stderr)).toBe(2);
    expect(stderr.mock.calls.flat()).toEqual(['Local secret holder could not start\n','Local secret holder could not start\n']);
  }finally {Object.defineProperty(process,'connected',{value:connected,configurable:true,writable:true});}
});
