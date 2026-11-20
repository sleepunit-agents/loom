/** Installed Changes reads the holder directly. Owner-to-name bindings are
 * startup configuration; no caller-selected secret or internal service grant. */
import {TextDecoder} from 'node:util';
import {githubReader} from './pieces/changes/github.js';
import {githubSecrets} from './pieces/changes/secrets.js';
import type {SecretValueSource} from './pieces/secrets/role.js';
import {secretValueSize} from './pieces/secrets/input.js';
export function sharedChangesReader(options:{source:SecretValueSource;bindings:Readonly<Record<string,string>>;request?:typeof fetch}, exactRepository = false){
 const secrets=githubSecrets({async withValue(name,use){
  let bytes:Uint8Array|undefined;
  try{
   bytes=await options.source.read(name);
   if(!(bytes instanceof Uint8Array)||!secretValueSize(bytes.byteLength)||bytes.includes(0))throw Error();
   let token:string;
   try{token=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}finally{bytes.fill(0);}
   return await use(token);
  }catch{throw new Error('GitHub credential unavailable');}
  finally{bytes?.fill(0);}
 }},options.bindings);
 return githubReader(secrets,options.request,exactRepository);
}
