/** Installed Changes reads the holder directly. Owner-to-name bindings are
 * startup configuration; no caller-selected secret or internal service grant. */
import {TextDecoder} from 'node:util';
import {githubReader} from './pieces/changes/github.js';
import {githubSecrets} from './pieces/changes/secrets.js';
import type {SecretValueSource} from './pieces/secrets/role.js';
import {secretValueSize} from './pieces/secrets/input.js';
type Options={source:SecretValueSource;bindings:Readonly<Record<string,string>>;request?:typeof fetch};
export function sharedForgeSecrets(options: Options){
 return githubSecrets({async withValue(name,use){
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
}
export function sharedChangesReader(options:Options){
 return githubReader(sharedForgeSecrets(options),options.request);
}
