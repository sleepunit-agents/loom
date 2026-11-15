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
 const f=fixture();await expect(f.use.withValue('OTHER',async()=>{})).rejects.toThrow('Bridge credential unavailable');expect(f.source.read).not.toHaveBeenCalled();
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
