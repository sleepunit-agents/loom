/** Installed bridge credentials, without agent/service grants. Every use proves
 * the same private-holder generation before and after acquisition. A lifetime
 * also binds each name to the bytes first authenticated, so later platform
 * requests cannot silently use a replacement credential under old evidence.
 * Only digests live between uses; all exclusively owned buffers are erased.
 */
import { createHash } from 'node:crypto';
import type { Clock } from '../../core/clock.js';
import type { SecretValueSource, SecretUse } from '../secrets/role.js';
import type { HolderGeneration } from '../secrets/role.js';
const unavailable=()=>new Error('Bridge credential unavailable');
export function sharedBridgeSecretUse(options:{
 source:SecretValueSource&HolderGeneration;clock:Clock;generation:string;names:readonly string[];
 current():boolean;invalidate():void;
}):SecretUse&{close():void}{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.generation))throw unavailable();
 const hashes=new Map<string,string>(),names=new Set(options.names);let closed=false;
 const current=()=>{if(closed)return false;try{return options.current();}catch{return false;}};
 return {
  async withValue<T>(name:string,use:(token:string)=>Promise<T>):Promise<T>{
   if(!names.has(name)||!current())throw unavailable();
   let expired=false,bytes:Uint8Array|undefined;
   const deadline=options.clock.now()+5000;
   const fresh=()=>!expired&&current()&&options.clock.now()<deadline;
   let cancel!:()=>void;
   const timedOut=new Promise<never>((_resolve,reject)=>{cancel=options.clock.at(deadline,()=>{expired=true;reject(unavailable());});});
   const acquire=(async()=>{
    if(!fresh()||await options.source.generation()!==options.generation||!fresh())throw unavailable();
    const found=await options.source.read(name);
    // A source may finish after our deadline. Erase its late owned buffer too.
    if(!(found instanceof Uint8Array))throw unavailable();
    if(!fresh()){found.fill(0);throw unavailable();}
    bytes=found;
    if(found.byteLength<1||found.byteLength>65536||await options.source.generation()!==options.generation||!fresh())throw unavailable();
    const hash=createHash('sha256').update(found).digest('hex'),old=hashes.get(name);
    if(old!==undefined&&old!==hash)throw unavailable();hashes.set(name,hash);
    return found;
   })();
   try{
    const value=await Promise.race([acquire,timedOut]);
    if(!fresh())throw unavailable();
    cancel(); // Platform adapters own their bounded effect lifetime from here.
    const token=Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('utf8');
    if(!token||!Buffer.from(token).equals(value))throw unavailable();
    const result=await use(token);
    if(!current())throw unavailable();
    return result;
   }catch{if(current()){try{options.invalidate();}catch{ /* fixed error below */ }}throw unavailable();}
   finally{expired=true;cancel();bytes?.fill(0);}
  },
  close(){closed=true;hashes.clear();},
 };
}
