import { expect, it, vi } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import { sharedBridgeSecretUse } from './shared-secret-use.js';
const generation='12345678-1234-4234-8234-123456789abc';
function fixture(){
 const clock=new FakeClock(),buffers:Buffer[]=[];
 const source={generation:vi.fn(async()=>generation),read:vi.fn(async()=>{const bytes=Buffer.from('synthetic-token');buffers.push(bytes);return bytes;})};
 let alive=true;const invalidate=vi.fn(()=>{alive=false;});
 const use=sharedBridgeSecretUse({source,clock,generation,names:['TOKEN'],current:()=>alive,invalidate});
 return {clock,source,buffers,invalidate,use,retire:()=>{alive=false;}};
}
it('uses fresh authenticated bytes without any service grant and erases each owned buffer',async()=>{
 const f=fixture(),action=vi.fn(async token=>{expect(token).toBe('synthetic-token');return 'done';});
 expect(await f.use.withValue('TOKEN',action)).toBe('done');expect(f.buffers[0].every(byte=>byte===0)).toBe(true);
 expect(await f.use.withValue('TOKEN',action)).toBe('done');expect(f.source.read).toHaveBeenCalledTimes(2);expect(f.invalidate).not.toHaveBeenCalled();
});
it('rejects unknown names before holder acquisition',async()=>{
 const f=fixture();await expect(f.use.withValue('OTHER',async()=>{})).rejects.toThrow('Bridge credential unavailable');expect(f.source.read).not.toHaveBeenCalled();expect(f.source.generation).not.toHaveBeenCalled();
});
it('invalidates replacement bytes even if a broken provider reuses its generation',async()=>{
 const f=fixture();await f.use.withValue('TOKEN',async()=>{});
 const changed=Buffer.from('different-token');f.source.read.mockResolvedValue(changed);const action=vi.fn(async()=>{});
 await expect(f.use.withValue('TOKEN',action)).rejects.toThrow('Bridge credential unavailable');expect(action).not.toHaveBeenCalled();expect(f.invalidate).toHaveBeenCalledOnce();expect(changed.every(byte=>byte===0)).toBe(true);
});
it('refuses a generation changed during acquisition before any platform callback',async()=>{
 const f=fixture(),action=vi.fn(async()=>{});f.source.generation.mockResolvedValueOnce(generation).mockResolvedValue('87654321-1234-4234-8234-123456789abc');
 await expect(f.use.withValue('TOKEN',action)).rejects.toThrow('Bridge credential unavailable');expect(action).not.toHaveBeenCalled();expect(f.buffers[0].every(byte=>byte===0)).toBe(true);
});
it('rejects at the absolute acquisition deadline and erases a source buffer arriving later',async()=>{
 const f=fixture();let release!:(value:Awaited<ReturnType<typeof f.source.read>>)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});
 const action=vi.fn(async()=>{}),pending=f.use.withValue('TOKEN',action);await started;
 f.clock.advance(5000);await expect(pending).rejects.toThrow('Bridge credential unavailable');
 const late=Buffer.from('late-synthetic');release(late);
 // Observe the original read promise's continuation without wall-clock waits.
 await f.source.read.mock.results[0].value;await Promise.resolve();expect(late.every(byte=>byte===0)).toBe(true);expect(action).not.toHaveBeenCalled();
});
it('fences callback results after retirement and erases the acquired value',async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const pending=f.use.withValue('TOKEN',async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});return 'late';});await started;f.use.close();release();
 await expect(pending).rejects.toThrow('Bridge credential unavailable');expect(f.buffers[0].every(byte=>byte===0)).toBe(true);
});
it.each([undefined,Buffer.alloc(0),Buffer.alloc(65537,65),Buffer.from([0xff]),Buffer.from('token\0suffix')])('refuses missing or malformed credentials before callback',async bytes=>{
 const f=fixture();f.source.read.mockResolvedValue(bytes as Awaited<ReturnType<typeof f.source.read>>);const callback=vi.fn(async()=>{});await expect(f.use.withValue('TOKEN',callback)).rejects.toThrow(/^Bridge credential unavailable$/);expect(callback).not.toHaveBeenCalled();if(bytes)expect(bytes.every(byte=>byte===0)).toBe(true);
});
it('erases owned bytes before a stalled callback and refuses holder rotation on callback completion',async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const pending=f.use.withValue('TOKEN',async()=>{expect(f.buffers[0].every(byte=>byte===0)).toBe(true);entered();await new Promise<void>(resolve=>{release=resolve;});});await started;
 f.source.generation.mockResolvedValue('87654321-1234-4234-8234-123456789abc');release();await expect(pending).rejects.toThrow(/^Bridge credential unavailable$/);expect(f.invalidate).toHaveBeenCalledOnce();
});
it.each(['retire','close'] as const)('erases a late acquisition and never calls platform code after %s',async phase=>{
 const f=fixture();let release!:(bytes:Awaited<ReturnType<typeof f.source.read>>)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});const callback=vi.fn(async()=>{}),pending=f.use.withValue('TOKEN',callback);await started;if(phase==='close')f.use.close();else f.retire();const late=Buffer.from('late');release(late);await expect(pending).rejects.toThrow(/^Bridge credential unavailable$/);expect(late.every(byte=>byte===0)).toBe(true);expect(callback).not.toHaveBeenCalled();
});
it.each(['source','callback','invalidate'] as const)('sanitizes %s errors and retires the lease even when its hook fails',async phase=>{
 const clock=new FakeClock(),source={generation:vi.fn(async()=>generation),read:vi.fn(async()=>Buffer.from('synthetic'))},invalidate=vi.fn(()=>{if(phase==='invalidate')throw Error('PRIVATE token');});
 const use=sharedBridgeSecretUse({source,clock,generation,names:['TOKEN'],current:()=>true,invalidate});if(phase==='source')source.read.mockRejectedValue(Error('PRIVATE source'));const callback=vi.fn(async()=>{throw Error('PRIVATE callback');});
 await expect(use.withValue('TOKEN',callback)).rejects.toThrow(/^Bridge credential unavailable$/);expect(invalidate).toHaveBeenCalledOnce();source.read.mockClear();await expect(use.withValue('TOKEN',async()=>{})).rejects.toThrow(/^Bridge credential unavailable$/);expect(source.read).not.toHaveBeenCalled();
});
it('rejects a replacement with an uncooperative invalidation hook and prevents all later callbacks',async()=>{
 const clock=new FakeClock(),source={generation:async()=>generation,read:vi.fn(async()=>Buffer.from('first'))},invalidate=vi.fn(()=>{throw Error('PRIVATE');}),use=sharedBridgeSecretUse({source,clock,generation,names:['TOKEN'],current:()=>true,invalidate});
 await use.withValue('TOKEN',async()=>{});source.read.mockResolvedValue(Buffer.from('replacement'));const callback=vi.fn(async()=>{});await expect(use.withValue('TOKEN',callback)).rejects.toThrow(/^Bridge credential unavailable$/);source.read.mockClear();await expect(use.withValue('TOKEN',callback)).rejects.toThrow();expect(source.read).not.toHaveBeenCalled();expect(callback).not.toHaveBeenCalled();
});
it('bounds generation acquisition and the final generation check independently',async()=>{
 for(const final of [false,true]){
  const f=fixture();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const stall=()=>{entered();return new Promise<string>(()=>{});};if(final)f.source.generation.mockResolvedValueOnce(generation).mockResolvedValueOnce(generation).mockImplementationOnce(stall);else f.source.generation.mockImplementationOnce(stall);
  const pending=f.use.withValue('TOKEN',async()=>{}),refusal=expect(pending).rejects.toThrow(/^Bridge credential unavailable$/);await started;f.clock.advance(5000);await refusal;
 }
});
it('uses one absolute acquisition deadline across generation and value reads',async()=>{
 const f=fixture();f.source.generation.mockImplementationOnce(async()=>{f.clock.advance(3000);return generation;});const bytes=Buffer.from('synthetic');f.source.read.mockImplementation(async()=>{f.clock.advance(2000);return bytes;});const callback=vi.fn(async()=>{});await expect(f.use.withValue('TOKEN',callback)).rejects.toThrow(/^Bridge credential unavailable$/);expect(callback).not.toHaveBeenCalled();expect(bytes.every(byte=>byte===0)).toBe(true);
});
it('erases the acquired buffer when post-read generation verification stalls past timeout',async()=>{
 const f=fixture();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.generation.mockResolvedValueOnce(generation).mockImplementationOnce(()=>{entered();return new Promise<string>(()=>{});});const pending=f.use.withValue('TOKEN',async()=>{}),refused=expect(pending).rejects.toThrow('unavailable');await started;expect(f.buffers[0].some(byte=>byte!==0)).toBe(true);f.clock.advance(5000);await refused;expect(f.buffers[0].every(byte=>byte===0)).toBe(true);
});
it('isolates stable fingerprints by configured name and invalidates replacement of either name',async()=>{
 for(const changed of ['TOKEN','APP']){
  const clock=new FakeClock();let replacement=false;const source={generation:async()=>generation,read:async(name:string)=>Buffer.from(replacement&&name===changed?'replacement':'synthetic:'+name)},use=sharedBridgeSecretUse({source,clock,generation,names:['TOKEN','APP'],current:()=>true,invalidate(){}});
  for(const name of ['TOKEN','APP','TOKEN','APP'])expect(await use.withValue(name,async token=>token)).toBe('synthetic:'+name);
  replacement=true;await expect(use.withValue(changed,async()=>{})).rejects.toThrow('unavailable');await expect(use.withValue(changed==='TOKEN'?'APP':'TOKEN',async()=>{})).rejects.toThrow('unavailable');
 }
});
it('close immediately erases bytes held by stalled post-read generation verification',async()=>{
 const f=fixture();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.generation.mockResolvedValueOnce(generation).mockImplementationOnce(()=>{entered();return new Promise<string>(()=>{});});const pending=f.use.withValue('TOKEN',async()=>{}),refused=expect(pending).rejects.toThrow('unavailable');await started;expect(f.buffers[0].some(byte=>byte!==0)).toBe(true);f.use.close();expect(f.buffers[0].every(byte=>byte===0)).toBe(true);f.clock.advance(5000);await refused;
});
