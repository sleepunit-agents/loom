import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { routedHolderAuthority } from './holder-routing.js';

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
