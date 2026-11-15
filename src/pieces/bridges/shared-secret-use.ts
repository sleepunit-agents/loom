/** Installed bridge credentials, without internal service grants. Every use
 * proves one holder/config lifetime. Only domain-separated digests survive a
 * use; mutable credential bytes are erased before the platform callback runs. */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { Clock } from '../../core/clock.js';
import type { SecretValueSource, SecretUse, HolderGeneration } from '../secrets/role.js';
const unavailable=()=>new Error('Bridge credential unavailable');
export function sharedBridgeSecretUse(options:{
 source:SecretValueSource&HolderGeneration;clock:Clock;generation:string;names:readonly string[];
 current():boolean;invalidate():void;
}):SecretUse&{close():void}{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.generation))throw unavailable();
 const owned=new Set<Uint8Array>(),hashes=new Map<string,string>(),names=new Set(options.names);let closed=false;
 const current=()=>{if(closed)return false;try{return options.current();}catch{return false;}};
 const clear=()=>{closed=true;hashes.clear();for(const bytes of owned)bytes.fill(0);owned.clear();};
 const invalidate=()=>{if(closed)return;clear();try{options.invalidate();}catch{}};
 async function bounded<T>(work:(fresh:()=>boolean)=>Promise<T>):Promise<T>{
  const end=options.clock.now()+5000;let expired=false,cancel!:()=>void;
  const fresh=()=>!expired&&current()&&options.clock.now()<end;
  const deadline=new Promise<never>((_resolve,reject)=>{cancel=options.clock.at(end,()=>{expired=true;reject(unavailable());});});
  try{if(!fresh())throw unavailable();const value=await Promise.race([work(fresh),deadline]);if(!fresh())throw unavailable();return value;}
  finally{expired=true;cancel();}
 }
 return {
  async withValue<T>(name:string,use:(token:string)=>Promise<T>):Promise<T>{
   if(!names.has(name)||!current())throw unavailable();
   let borrowed:Uint8Array|undefined;
   try{
    const token=await bounded(async fresh=>{
     if(!fresh()||await options.source.generation()!==options.generation||!fresh())throw unavailable();
     const found=await options.source.read(name);
     if(!(found instanceof Uint8Array))throw unavailable();
     borrowed=found;owned.add(found);
     try{
      if(!fresh()||found.byteLength<1||found.byteLength>65536||found.includes(0))throw unavailable();
      if(await options.source.generation()!==options.generation||!fresh())throw unavailable();
      const hash=createHash('sha256').update('loom-bridge-credential-bytes-v1\0').update(name).update('\0').update(found).digest('hex'),old=hashes.get(name);
      if(old!==undefined&&old!==hash)throw unavailable();hashes.set(name,hash);
      return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(found);
     }finally{found.fill(0);owned.delete(found);}
    });
    if(!current())throw unavailable();
    const result=await use(token);
    if(!current())throw unavailable();
    await bounded(async fresh=>{if(await options.source.generation()!==options.generation||!fresh())throw unavailable();});
    return result;
   }catch{invalidate();throw unavailable();}
   finally{if(borrowed){borrowed.fill(0);owned.delete(borrowed);}}
  },
  close:clear,
 };
}
