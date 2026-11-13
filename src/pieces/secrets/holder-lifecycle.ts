/** Persistent separate holder composition. This module never opens loom.db. */
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { privateBytes, listenLocalHolder } from './local-holder.js';
import { openHolderStore } from './holder-store.js';
import { listenHolderMutations } from './holder-mutations.js';
import { holderTls, certificateFingerprint, remoteHolderAuthority } from './holder-authority.js';
const path=z.string().refine(isAbsolute);
const configSchema=z.object({read:holderTls,mutation:holderTls,authority:holderTls.extend({servername:z.hostname()}),
  directory:path,identity:path,fingerprintKey:path,daemonFingerprint:certificateFingerprint}).strict();

export async function startPersistentHolder(file:string) {
  let bytes:Buffer|undefined;
  let store:Awaited<ReturnType<typeof openHolderStore>>|undefined;
  let reader:Awaited<ReturnType<typeof listenLocalHolder>>|undefined;
  let writer:Awaited<ReturnType<typeof listenHolderMutations>>|undefined;
  try {
    bytes=privateBytes(file);
    const config=configSchema.parse(JSON.parse(bytes.toString('utf8')));
    if(new Set([config.read.socket,config.mutation.socket,config.authority.socket]).size!==3) throw Error();
    const authority=remoteHolderAuthority(config.authority,config.daemonFingerprint);
    store=await openHolderStore(config.directory,config.identity,config.fingerprintKey);
    reader=await listenLocalHolder(config.read,store,config.daemonFingerprint);
    writer=await listenHolderMutations(config.mutation,store,authority);
    let closing:Promise<void>|undefined;
    return {close(){return closing??=(async()=>{try{await writer!.close();}finally{try{await reader!.close();}finally{store!.close();}}})();}};
  } catch {
    try {await writer?.close();} finally {try{await reader?.close();}finally{store?.close();}}
    throw new Error('Persistent secret holder could not start');
  } finally {bytes?.fill(0);}
}
