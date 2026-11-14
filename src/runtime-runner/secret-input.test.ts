import { afterEach, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { workerSecretInputs, type SecretInputBinding } from './secret-input.js';
const binding=():SecretInputBinding=>({agent:'art',job:randomUUID(),runner:'runner',box:'box',claimedAt:10,service:'work'});
function deferred<T>() {let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
afterEach(()=>vi.useRealTimers());
function fixture() {
 const inputs=workerSecretInputs(),received:string[]=[],borrowed:Buffer[]=[];
 const input=new Writable({write(b,_encoding,done){borrowed.push(b);received.push(b.toString());done();}});
 const d=binding(),current=vi.fn(()=>true),authority=vi.fn(async()=>true);
 const handle=inputs.register(d,input,current,authority,Date.now()+20_000);
 return {inputs,input,d,current,authority,handle,received,borrowed};
}
it('delivers once to the original private stream and erases its borrowed write after consumption',async()=>{
 const f=fixture(),claim=f.inputs.claim(f.handle.id,f.d)!;
 await claim.release(Buffer.from('SECRET-SENTINEL'),()=>true);
 expect(f.received).toEqual(['SECRET-SENTINEL']);expect(f.borrowed[0].every(b=>b===0)).toBe(true);
 expect(f.authority).toHaveBeenCalledOnce();expect(f.inputs.claim(f.handle.id,f.d)).toBeNull();
 await expect(claim.release(Buffer.from('AGAIN'),()=>true)).rejects.toThrow('Worker secret input unavailable');
 expect(f.received).toHaveLength(1);
});
it.each(['agent','job','runner','box','claimedAt','service'] as const)('burns a claim with a different %s without touching either stream',async key=>{
 const f=fixture(),d={...f.d,[key]:key==='claimedAt'?11:key==='job'?randomUUID():'different'};
 expect(f.inputs.claim(f.handle.id,d)).toBeNull();expect(f.inputs.claim(f.handle.id,f.d)).toBeNull();
 expect(f.received).toEqual([]);expect(f.authority).not.toHaveBeenCalled();
});
it.each(['revoke','cancel','close','deadline','stream','disconnect'] as const)('fences %s while async authority is pending',async phase=>{
 const f=fixture(),wait=deferred<boolean>(),entered=deferred<void>();let alive=true;
 f.authority.mockImplementationOnce(async()=>{entered.resolve();return wait.promise;});
 const claim=f.inputs.claim(f.handle.id,f.d)!;
 const result=claim.release(Buffer.from('SECRET-SENTINEL'),()=>alive).catch(e=>e);await entered.promise;
 if(phase==='revoke')f.current.mockReturnValue(false);
 if(phase==='cancel')f.handle.cancel();
 if(phase==='close')f.inputs.close();
 if(phase==='stream')f.input.destroy();
 if(phase==='disconnect')alive=false;
 if(phase==='deadline'){vi.useFakeTimers();vi.setSystemTime(Date.now()+30_000);}
 wait.resolve(true);expect((await result).message).toBe('Worker secret input unavailable');
 expect(f.received).toEqual([]);expect(f.inputs.claim(f.handle.id,f.d)).toBeNull();
});
it('does not redirect a held claim to a replacement request with identical metadata',async()=>{
 const f=fixture(),wait=deferred<boolean>(),entered=deferred<void>();
 f.authority.mockImplementationOnce(async()=>{entered.resolve();return wait.promise;});
 const claim=f.inputs.claim(f.handle.id,f.d)!;
 const result=claim.release(Buffer.from('SECRET-SENTINEL'),()=>true).catch(e=>e);await entered.promise;
 f.handle.cancel();const other:string[]=[];
 const replacement=f.inputs.register(f.d,new Writable({write(b,_e,done){other.push(b.toString());done();}}),()=>true,async()=>true,Date.now()+20_000);
 wait.resolve(true);expect(await result).toBeInstanceOf(Error);expect(f.received).toEqual([]);expect(other).toEqual([]);
 await f.inputs.claim(replacement.id,f.d)!.release(Buffer.from('FRESH'),()=>true);expect(other).toEqual(['FRESH']);
});
it.each(['false','throw'] as const)('authority %s is sticky and cannot retry a retained claim',async phase=>{
 const f=fixture();if(phase==='false')f.authority.mockResolvedValue(false);else f.authority.mockRejectedValue(Error('SECRET-SENTINEL'));
 const claim=f.inputs.claim(f.handle.id,f.d)!;
 await expect(claim.release(Buffer.from('SECRET-SENTINEL'),()=>true)).rejects.toThrow(/^Worker secret input unavailable$/);
 f.authority.mockResolvedValue(true);
 await expect(claim.release(Buffer.from('SECRET-SENTINEL'),()=>true)).rejects.toThrow();expect(f.received).toEqual([]);
});
it('retains borrowed bytes through a pending write and treats close before acknowledgement as uncertain',async()=>{
 const inputs=workerSecretInputs(),entered=deferred<void>();let complete!:(e?:Error|null)=>void,borrowed!:Buffer;
 const stream=new Writable({write(b,_e,done){borrowed=b;complete=done;entered.resolve();}});
 const d=binding(),h=inputs.register(d,stream,()=>true,async()=>true,Date.now()+20_000),claim=inputs.claim(h.id,d)!;
 const result=claim.release(Buffer.from('SECRET-SENTINEL'),()=>true).catch(e=>e);await entered.promise;
 inputs.close();expect(borrowed.toString()).toBe('SECRET-SENTINEL');complete();
 expect(await result).toBeInstanceOf(Error);expect(borrowed.every(b=>b===0)).toBe(true);
 expect(inputs.claim(h.id,d)).toBeNull();
});
it('has no restart reconstruction and refuses oversized or empty values before authority',async()=>{
 const f=fixture();expect(workerSecretInputs().claim(f.handle.id,f.d)).toBeNull();
 await expect(f.inputs.claim(f.handle.id,f.d)!.release(Buffer.alloc(65537),()=>true)).rejects.toThrow();
 expect(f.authority).not.toHaveBeenCalled();
 const next=fixture();await expect(next.inputs.claim(next.handle.id,next.d)!.release(Buffer.alloc(0),()=>true)).rejects.toThrow();
 expect(next.authority).not.toHaveBeenCalled();
});
it.each(['callback','throw'] as const)('sanitizes %s write failures and burns the request',async phase=>{
 const inputs=workerSecretInputs();let borrowed:Buffer|undefined;
 const input=new Writable({write(b,_e,done){borrowed=b;if(phase==='throw')throw Error('SECRET-SENTINEL');done(Error('SECRET-SENTINEL'));}});
 const d=binding(),h=inputs.register(d,input,()=>true,async()=>true,Date.now()+20_000);
 await expect(inputs.claim(h.id,d)!.release(Buffer.from('SECRET-SENTINEL'),()=>true)).rejects.toThrow(/^Worker secret input unavailable$/);
 await new Promise<void>(resolve=>setImmediate(resolve));
 expect(borrowed!.every(b=>b===0)).toBe(true);expect(inputs.claim(h.id,d)).toBeNull();
});
it.each(['revoke','deadline'] as const)('reports uncertainty when %s occurs during an already-started write',async phase=>{
 const inputs=workerSecretInputs(),entered=deferred<void>();let complete!:(e?:Error|null)=>void,current=true;
 const input=new Writable({write(_b,_e,done){complete=done;entered.resolve();}});
 const d=binding(),h=inputs.register(d,input,()=>current,async()=>true,Date.now()+20_000);
 const result=inputs.claim(h.id,d)!.release(Buffer.from('SECRET'),()=>true).catch(e=>e);await entered.promise;
 if(phase==='revoke')current=false;else {vi.useFakeTimers();vi.setSystemTime(Date.now()+30_000);}
 complete();expect(await result).toBeInstanceOf(Error);expect(inputs.claim(h.id,d)).toBeNull();
});
it.each(['corked','queued'] as const)('refuses a %s input rather than queue secret release behind deferred writes',async phase=>{
 const inputs=workerSecretInputs(),input=new Writable({write(_b,_e,_done){}});
 if(phase==='corked')input.cork();else input.write('earlier');
 expect(()=>inputs.register(binding(),input,()=>true,async()=>true,Date.now()+20_000)).toThrow();input.destroy();
});
it('reserves a pending request before awaited authority, excluding overlapping deliveries',async()=>{
 const f=fixture(),entered=deferred<void>(),wait=deferred<boolean>();
 f.authority.mockImplementationOnce(async()=>{entered.resolve();return wait.promise;});
 const first=f.inputs.claim(f.handle.id,f.d)!;
 const result=first.release(Buffer.from('FIRST'),()=>true);await entered.promise;
 expect(f.inputs.claim(f.handle.id,f.d)).toBeNull();wait.resolve(true);await result;expect(f.received).toEqual(['FIRST']);
});
