/** Persistent separate holder composition. This module never opens loom.db. */
import { z } from 'zod';
import { isAbsolute, dirname, resolve } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import { privateBytes, listenLocalHolder, tlsMaterial, assertPrivateDirectory, privateSocket } from './pieces/secrets/local-holder.js';
import { openHolderStore, type HolderStore } from './pieces/secrets/holder-store.js';
import { listenHolderMutations } from './pieces/secrets/holder-mutations.js';
import { holderTls, certificateFingerprint, remoteHolderAuthority } from './pieces/secrets/holder-authority.js';
import { listenHolderHandoff } from './pieces/secrets/holder-handoff.js';
import { managedHolderAuthority } from './pieces/secrets/holder-routing.js';
import { remoteTicketAuthority } from './pieces/secrets/ticket-authority.js';
import { secretInputBindingSchema } from './pieces/secrets/worker-binding.js';
import { workerSecretTransport } from './runtime-runner/secret-transport.js';
const clientTls=holderTls.extend({servername:z.hostname()});
const handoffSchema=z.object({listen:holderTls,authority:clientTls,
  workers:z.array(z.object({binding:secretInputBindingSchema,config:clientTls,fingerprint:certificateFingerprint}).strict()).max(1024)}).strict();
const path=z.string().refine(isAbsolute);
const configSchema=z.object({read:holderTls,mutation:holderTls,authority:holderTls.extend({servername:z.hostname()}),
  directory:path,identity:path,fingerprintKey:path,previousIdentities:z.array(path).max(31).optional(),
  previousFingerprintKeys:z.array(path).max(31).optional(),daemonFingerprint:certificateFingerprint,handoff:handoffSchema.optional()}).strict();

export async function startPersistentHolder(file:string) {
  let bytes:Buffer|undefined;
  let store:Awaited<ReturnType<typeof openHolderStore>>|undefined;
  let reader:Awaited<ReturnType<typeof listenLocalHolder>>|undefined;
  let writer:Awaited<ReturnType<typeof listenHolderMutations>>|undefined;
  let handoff:Awaited<ReturnType<typeof listenHolderHandoff>>|undefined;
  let tickets:ReturnType<typeof remoteTicketAuthority>|undefined;
  let routes:ReturnType<typeof managedHolderAuthority>|undefined;
  const transports:ReturnType<typeof workerSecretTransport>[]=[];
  let available=false;
  const cleanup=async()=>{
    available=false;
    // Fence routes immediately, while original settlement authority still lives.
    // Drain ALL listeners/continuations before closing transports or storage.
    const listeners=await Promise.allSettled([routes?.close(),handoff?.close(),writer?.close(),reader?.close()]);
    const clients=await Promise.allSettled(transports.map(t=>t.close()).concat(tickets?[tickets.close()]:[]));
    store?.close();
    if([...listeners,...clients].some(r=>r.status==='rejected'))throw new Error('Persistent secret holder could not close');
  };
  try {
    bytes=privateBytes(file);
    const config=configSchema.parse(JSON.parse(bytes.toString('utf8')));
    const endpoints=[config.read,config.mutation,config.authority,
      ...(config.handoff?[config.handoff.listen,config.handoff.authority,...config.handoff.workers.map(w=>w.config)]:[])];
    // Reject lexical and filesystem aliases before comparing selections. A
    // not-yet-bound socket may be absent; its private parent must already exist.
    for(const endpoint of endpoints) {
      assertPrivateDirectory(dirname(endpoint.socket));
      if(endpoint.socket!==resolve(endpoint.socket)
        ||dirname(endpoint.socket)!==realpathSync(dirname(endpoint.socket)))throw Error();
      // Outbound sockets may not be bound yet. Existing selections must be
      // private real sockets, never final symlinks, regular files or public IO.
      try {lstatSync(endpoint.socket);privateSocket(endpoint.socket);}
      catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(new Set(endpoints.map(e=>e.socket)).size!==endpoints.length)throw Error();
    // Validate every peer and TLS material before the first listener or store.
    for(const endpoint of endpoints) {
      const material=tlsMaterial(endpoint);for(const bytes of Object.values(material))bytes.fill(0);
    }
    if(config.handoff) {
      tickets=remoteTicketAuthority(config.handoff.authority,config.daemonFingerprint);
      routes=managedHolderAuthority(tickets,config.handoff.workers.map(w=>{
        const transport=workerSecretTransport(w.config,w.fingerprint);transports.push(transport);
        return {binding:w.binding,transport};
      }));
    }
    const authority=remoteHolderAuthority(config.authority,config.daemonFingerprint);
    // Bind every fallible listener before committing key history. Until the
    // store is assigned, real authenticated requests fail closed at the gate.
    const ready=()=>{if(!available||!store)throw new Error('Persistent secret holder unavailable');return store;};
    reader=await listenLocalHolder(config.read,{read:name=>ready().read(name),generation:()=>ready().generation()},config.daemonFingerprint);
    writer=await listenHolderMutations(config.mutation,{
      set:(...args:Parameters<HolderStore['set']>)=>ready().set(...args),
      remove:(...args:Parameters<HolderStore['remove']>)=>ready().remove(...args),
      hasReceipt:(...args:Parameters<HolderStore['hasReceipt']>)=>ready().hasReceipt(...args),
    },authority);
    if(config.handoff)handoff=await listenHolderHandoff(config.handoff.listen,
      {read:name=>ready().read(name)},config.daemonFingerprint,async id=>available?routes!.authority(id):null);
    store=await openHolderStore(config.directory,config.identity,config.fingerprintKey,
      {identities:config.previousIdentities,fingerprintKeys:config.previousFingerprintKeys});
    available=true;
    let closing:Promise<void>|undefined;
    return {close(){return closing??=cleanup();}};
  } catch {
    try {await cleanup();} catch { /* Keep startup errors private. */ }
    throw new Error('Persistent secret holder could not start');
  } finally {bytes?.fill(0);}
}
