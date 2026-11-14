/** Worker-owned pending credential inputs. Not registered in the daemon or
 * composed into standalone runner startup. No pending proof survives restart. */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { z } from 'zod';

export const secretInputBindingSchema=z.object({agent:z.string().min(1).max(100),job:z.uuid(),runner:z.string().min(1).max(200),
  box:z.string().min(1).max(200),claimedAt:z.number().finite(),service:z.string().min(1).max(200).optional()}).strict();
export type SecretInputBinding=z.infer<typeof secretInputBindingSchema>;
const failed=()=>new Error('Worker secret input unavailable');
const identity=(binding:SecretInputBinding)=>JSON.stringify(secretInputBindingSchema.parse(binding));
interface Pending {
  binding:SecretInputBinding; input:Writable; current:()=>boolean; authority:()=>Promise<boolean>; expiresAt:number;
  state:'pending'|'claimed'|'spent';
}
/** The owning worker supplies the ORIGINAL private input stream, local proof
 * closure and exact assignment, never a body operation or transport caller.
 * Each request owns a dedicated stream. Replacement must cancel the old handle.
 * The input must consume each write before its callback; it may not retain the
 * borrowed buffer afterwards. A write error/lost ack is uncertain, never retry.
 */
export function workerSecretInputs() {
  const pending=new Map<string,Pending>();
  let closed=false;
  function valid(p:Pending) {
    let current=false;
    try {current=p.current()===true;}catch { /* sticky failure */ }
    if(closed||p.state==='spent'||Date.now()>=p.expiresAt||p.input.destroyed||p.input.errored||p.input.writableEnded||p.input.writableCorked>0||p.input.writableLength>0||!current) {
      p.state='spent';return false;
    }
    return true;
  }
  return {
    register(binding:SecretInputBinding,input:Writable,current:()=>boolean,authority:()=>Promise<boolean>,expiresAt:number) {
      if(closed||typeof current!=='function'||typeof authority!=='function'||!Number.isFinite(expiresAt)||expiresAt<=Date.now()
        ||expiresAt>Date.now()+30_000)throw failed();
      for(const [id,p] of pending)if(!valid(p))pending.delete(id);
      if(pending.size>=1024)throw failed();
      const p:Pending={binding:Object.freeze(secretInputBindingSchema.parse(binding)),input,current,authority,expiresAt,state:'pending'};
      if(!valid(p))throw failed();
      const id=randomUUID();pending.set(id,p);
      // Writable emits an error after invoking a failed write callback. Keep
      // its diagnostic out of uncaught process errors; revocation is sticky.
      input.once('error',()=>{p.state='spent';pending.delete(id);});
      return Object.freeze({id,binding:p.binding,cancel(){p.state='spent';pending.delete(id);}});
    },
    /** Called only after holder authentication. Burns the original request
     * before any awaited authority/IO. Matching metadata is not release proof. */
    claim(id:string,binding:SecretInputBinding) {
      const p=pending.get(id);
      if(!p||p.state!=='pending')return null;
      p.state='claimed';
      try {if(identity(p.binding)!==identity(binding)||!valid(p))throw failed();}
      catch {p.state='spent';pending.delete(id);return null;}
      let used=false;
      return {
        async release(bytes:Uint8Array,alive:()=>boolean):Promise<void> {
          if(used)throw failed();used=true;
          let copy:Buffer|undefined;
          try {
            if(!valid(p)||!alive()||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>65536)throw failed();
            const authorized=await p.authority();
            // No await, transport lookup, destination reconstruction or other
            // caller code between this FINAL local proof and the stream write.
            if(authorized!==true||!alive()||!valid(p))throw failed();
            copy=Buffer.from(bytes);
            p.state='spent';pending.delete(id);
            await new Promise<void>((resolve,reject)=>{
              p.input.write(copy!,error=>error?reject(failed()):resolve());
            });
            // The write has happened; a failed ack remains uncertain.
            if(closed||!alive()||Date.now()>=p.expiresAt||p.current()!==true)throw failed();
          }catch {throw failed();}
          finally {p.state='spent';pending.delete(id);copy?.fill(0);}
        },
        cancel(){p.state='spent';pending.delete(id);},
      };
    },
    close(){closed=true;for(const p of pending.values())p.state='spent';pending.clear();},
  };
}
