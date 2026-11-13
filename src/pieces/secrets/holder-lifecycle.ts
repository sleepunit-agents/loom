/** Persistent separate holder composition. This module never opens loom.db. */
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { privateBytes, listenLocalHolder } from './local-holder.js';
import { openHolderStore, type HolderStore } from './holder-store.js';
import { listenHolderMutations } from './holder-mutations.js';
import { holderTls, certificateFingerprint, remoteHolderAuthority } from './holder-authority.js';
const path=z.string().refine(isAbsolute);
const configSchema=z.object({read:holderTls,mutation:holderTls,authority:holderTls.extend({servername:z.hostname()}),
  directory:path,identity:path,fingerprintKey:path,previousIdentities:z.array(path).max(31).optional(),
  previousFingerprintKeys:z.array(path).max(31).optional(),daemonFingerprint:certificateFingerprint}).strict();

export async function startPersistentHolder(file:string) {
  let bytes:Buffer|undefined;
  let store:Awaited<ReturnType<typeof openHolderStore>>|undefined;
  let reader:Awaited<ReturnType<typeof listenLocalHolder>>|undefined;
  let writer:Awaited<ReturnType<typeof listenHolderMutations>>|undefined;
  const cleanup=async()=>{try {await writer?.close();} finally {try {await reader?.close();} finally {store?.close();}}};
  try {
    bytes=privateBytes(file);
    const config=configSchema.parse(JSON.parse(bytes.toString('utf8')));
    if(new Set([config.read.socket,config.mutation.socket,config.authority.socket]).size!==3) throw Error();
    const authority=remoteHolderAuthority(config.authority,config.daemonFingerprint);
    // Bind every fallible listener before committing key history. Until the
    // store is assigned, real authenticated requests fail closed at the gate.
    const ready=()=>{if(!store)throw new Error('Persistent secret holder unavailable');return store;};
    reader=await listenLocalHolder(config.read,{read:name=>ready().read(name),generation:()=>ready().generation()},config.daemonFingerprint);
    writer=await listenHolderMutations(config.mutation,{
      set:(...args:Parameters<HolderStore['set']>)=>ready().set(...args),
      remove:(...args:Parameters<HolderStore['remove']>)=>ready().remove(...args),
      hasReceipt:(...args:Parameters<HolderStore['hasReceipt']>)=>ready().hasReceipt(...args),
    },authority);
    store=await openHolderStore(config.directory,config.identity,config.fingerprintKey,
      {identities:config.previousIdentities,fingerprintKeys:config.previousFingerprintKeys});
    let closing:Promise<void>|undefined;
    return {close(){return closing??=cleanup();}};
  } catch {
    try {await cleanup();} catch { /* Keep startup errors private. */ }
    throw new Error('Persistent secret holder could not start');
  } finally {bytes?.fill(0);}
}
