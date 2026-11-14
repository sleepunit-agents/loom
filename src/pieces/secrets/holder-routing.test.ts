import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { routedHolderAuthority, managedHolderAuthority } from './holder-routing.js';

function setup() {
  const binding = {agent:'art',job:randomUUID(),runner:'worker',box:'box',claimedAt:123,service:'voice'};
  const claim = {name:'API',pendingId:randomUUID(),destination:binding,
    current:vi.fn(async()=>true),finish:vi.fn(async(_ack:boolean)=>{})};
  const tickets = {claim:vi.fn(async()=>claim)};
  const transport = {deliver:vi.fn(async(_id:string,_binding:typeof binding,_bytes:Uint8Array)=>{})};
  const configured = [{binding:{...binding},transport}];
  const authority = routedHolderAuthority(tickets,configured);
  return {binding,claim,tickets,transport,configured,authority};
}
it('snapshots exact assignment and configured transport, retaining the claim for owner completion',async()=>{
  const f=setup(),original=f.transport.deliver;
  f.configured[0].binding.box='replaced';f.configured.length=0;
  f.transport.deliver=vi.fn(async()=>{});
  const id=randomUUID(),d=(await f.authority(id))!,bytes=Buffer.from('synthetic');
  expect(await d.current()).toBe(true);await d.handTo(bytes);
  expect(f.tickets.claim).toHaveBeenCalledExactlyOnceWith(id);
  expect(original).toHaveBeenCalledExactlyOnceWith(f.claim.pendingId,f.binding,bytes);
  expect(f.transport.deliver).not.toHaveBeenCalled();expect(f.claim.finish).not.toHaveBeenCalled();
  await expect(d.handTo(bytes)).rejects.toThrow(/^Secret handoff unavailable$/);
  await d.abandon!();await d.abandon!();expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
  expect(await d.current()).toBe(false);
});
it.each(['agent','job','runner','box','claimedAt','service','absent-service'] as const)('burns an unmatched %s claim before delivery',async field=>{
  const f=setup();
  if(field==='absent-service')delete (f.claim.destination as Partial<typeof f.binding>).service;
  else if(field==='claimedAt')f.claim.destination.claimedAt++;
  else f.claim.destination[field]=field==='job'?randomUUID():'other';
  expect(await f.authority(randomUUID())).toBeNull();
  expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);expect(f.transport.deliver).not.toHaveBeenCalled();
});
it('rejects legacy unbound claims and ambiguous owner routes',async()=>{
  const f=setup();delete (f.claim as Partial<typeof f.claim>).pendingId;
  expect(await f.authority(randomUUID())).toBeNull();expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
  expect(()=>routedHolderAuthority(f.tickets,[...f.configured,...f.configured])).toThrow();
});
it.each(['current','delivery','settlement'] as const)('consumes the original failed %s attempt without retry',async phase=>{
  const f=setup(),d=(await f.authority(randomUUID()))!;
  if(phase==='current')f.claim.current.mockResolvedValue(false);
  else f.transport.deliver.mockRejectedValueOnce(Error('private'));
  if(phase==='settlement')f.claim.finish.mockRejectedValueOnce(Error('private'));
  await expect(d.handTo(Buffer.from('synthetic'))).rejects.toThrow(/^Secret handoff unavailable$/);
  await expect(d.handTo(Buffer.from('synthetic'))).rejects.toThrow();await d.abandon!();
  expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);expect(await d.current()).toBe(false);
});
it('selects each owning transport when two exact assignments are configured',async()=>{
 const f=setup(),second=setup();
 const tickets={claim:vi.fn(async(id:string)=>id===f.binding.job?f.claim:second.claim)};
 const authority=routedHolderAuthority(tickets,[...f.configured,...second.configured]);
 const first=(await authority(f.binding.job))!,other=(await authority(second.binding.job))!;
 const bytes=Buffer.from('synthetic');await first.handTo(bytes);await other.handTo(bytes);
 expect(f.transport.deliver).toHaveBeenCalledExactlyOnceWith(f.claim.pendingId,f.binding,bytes);
 expect(second.transport.deliver).toHaveBeenCalledExactlyOnceWith(second.claim.pendingId,second.binding,bytes);
});

it('replaces equal routes, burns retained claims once and fences old destinations',async()=>{
 const f=setup();const c=managedHolderAuthority(f.tickets,f.configured);
 const old=(await c.authority(randomUUID()))!;
 await c.replace(f.configured);
 expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
 expect(await old.current()).toBe(false);
 await expect(old.handTo(Buffer.from('synthetic'))).rejects.toThrow();
 expect(f.transport.deliver).not.toHaveBeenCalled();
 const fresh=(await c.authority(randomUUID()))!;
 await fresh.handTo(Buffer.from('synthetic'));
 expect(f.transport.deliver).toHaveBeenCalledOnce();
 await c.close();await c.close();
 expect(await fresh.current()).toBe(false);
 expect(await c.authority(randomUUID())).toBeNull();
 await expect(c.replace(f.configured)).rejects.toThrow();
});
it.each(['duplicate','sparse','invalid','mixed','over-capacity'] as const)('rejects %s replacement without retiring current routes',async kind=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 const old=(await c.authority(randomUUID()))!;
 const bad=kind==='duplicate'?[...f.configured,...f.configured]:kind==='sparse'?Array(1):
 kind==='over-capacity'?Array(1025):kind==='mixed'?[...f.configured,{binding:{},transport:f.transport}]:[{binding:{},transport:f.transport}];
 await expect(c.replace(bad as typeof f.configured)).rejects.toThrow();
 expect(await old.current()).toBe(true);expect(f.claim.finish).not.toHaveBeenCalled();
 await old.handTo(Buffer.from('synthetic'));expect(f.transport.deliver).toHaveBeenCalledOnce();
 await c.close();
});
it.each(['claim','current','delivery'] as const)('fences replacement across pending %s',async phase=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
 if(phase==='claim')f.tickets.claim.mockImplementationOnce(async()=>{await wait;return f.claim;});
 const replacement=setup();
 const acquiring=c.authority(randomUUID());
 if(phase==='claim'){
  await c.replace([{binding:f.binding,transport:replacement.transport}]);release();expect(await acquiring).toBeNull();
 }else{
  const d=(await acquiring)!;
  if(phase==='current')f.claim.current.mockImplementationOnce(async()=>{await wait;return true;});
  else f.transport.deliver.mockImplementationOnce(async()=>{await wait;});
  const sending=d.handTo(Buffer.from('synthetic'));
  // Drain the authority check so delivery is actually pending in that case.
  await Promise.resolve();
  await c.replace([{binding:f.binding,transport:replacement.transport}]);release();await expect(sending).rejects.toThrow();
  expect(await d.current()).toBe(false);
 }
 expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
 if(phase!=='delivery')expect(f.transport.deliver).not.toHaveBeenCalled();
 expect(replacement.transport.deliver).not.toHaveBeenCalled();
 await c.close();
});
it('keeps acquisition diagnostics private',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 f.tickets.claim.mockRejectedValueOnce(Error('PRIVATE-ACQUISITION-SENTINEL'));
 expect(await c.authority(randomUUID())).toBeNull();
 expect(f.transport.deliver).not.toHaveBeenCalled();expect(f.claim.finish).not.toHaveBeenCalled();
 await c.close();
});
it('shutdown retires an outstanding destination exactly once',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 const d=(await c.authority(randomUUID()))!;
 await c.close();await c.close();await d.abandon();
 expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
 expect(await d.current()).toBe(false);
 await expect(d.handTo(Buffer.from('synthetic'))).rejects.toThrow();
 expect(f.transport.deliver).not.toHaveBeenCalled();
});
it('leaves a successful delivery to daemon settlement across replacement and shutdown',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 const d=(await c.authority(randomUUID()))!;
 await d.handTo(Buffer.from('synthetic'));
 await c.replace([]);await c.close();
 expect(f.claim.finish).not.toHaveBeenCalled();expect(await d.current()).toBe(false);
});
it('all shutdown callers drain the original outstanding settlement',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 await c.authority(randomUUID());
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.claim.finish.mockImplementationOnce(async()=>gate);
 const first=c.close(),second=c.close();expect(second).toBe(first);
 let drained=false;void second.then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
 release();await first;expect(drained).toBe(true);
 expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('fences current itself when its original proof resolves after replacement',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 const d=(await c.authority(randomUUID()))!;
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.claim.current.mockImplementationOnce(async()=>{await gate;return true;});
 const current=d.current();await c.replace(f.configured);release();
 expect(await current).toBe(false);expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
 await c.close();
});
it('shutdown also drains settlements begun by an earlier route replacement',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 await c.authority(randomUUID());
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.claim.finish.mockImplementationOnce(async()=>gate);
 const replacing=c.replace([]),closing=c.close();
 let drained=false;void closing.then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
 release();await Promise.all([replacing,closing]);expect(drained).toBe(true);
 expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('sanitizes direct abandonment errors and never retries their settlement',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured),d=(await c.authority(randomUUID()))!;
 f.claim.finish.mockRejectedValueOnce(Error('PRIVATE-SETTLEMENT-SENTINEL'));
 await expect(d.abandon()).rejects.toThrow(/^Secret handoff unavailable$/);
 await d.abandon();await c.close();expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('empty replacement refuses fresh claims and changed routes use only the new transport',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured);
 await c.replace([]);
 expect(await c.authority(randomUUID())).toBeNull();expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
 const other=setup();await c.replace([{binding:f.binding,transport:other.transport}]);
 const fresh=(await c.authority(randomUUID()))!;await fresh.handTo(Buffer.from('synthetic'));
 expect(other.transport.deliver).toHaveBeenCalledOnce();expect(f.transport.deliver).not.toHaveBeenCalled();
 await c.close();
});
it('sanitizes owner configuration diagnostics and preserves existing routes on rejection',async()=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured),d=(await c.authority(randomUUID()))!;
 const bad=[{get binding():typeof f.binding {throw Error('PRIVATE-CONFIG-SENTINEL');},transport:f.transport}];
 expect(()=>managedHolderAuthority(f.tickets,bad)).toThrow(/^Secret handoff unavailable$/);
 await expect(c.replace(bad)).rejects.toThrow(/^Secret handoff unavailable$/);
 expect(await d.current()).toBe(true);expect(f.claim.finish).not.toHaveBeenCalled();
 await c.close();
});
it.each(['false','reject'] as const)('standalone %s proof abandons once before returning false',async kind=>{
 const f=setup(),c=managedHolderAuthority(f.tickets,f.configured),d=(await c.authority(randomUUID()))!;
 if(kind==='false')f.claim.current.mockResolvedValueOnce(false);
 else f.claim.current.mockRejectedValueOnce(Error('PRIVATE-PROOF-SENTINEL'));
 f.claim.finish.mockRejectedValueOnce(Error('PRIVATE-SETTLEMENT-SENTINEL'));
 expect(await d.current()).toBe(false);expect(f.claim.finish).toHaveBeenCalledExactlyOnceWith(false);
 await expect(d.handTo(Buffer.from('synthetic'))).rejects.toThrow(/^Secret handoff unavailable$/);
 expect(await d.current()).toBe(false);await c.close();expect(f.claim.finish).toHaveBeenCalledOnce();
});
