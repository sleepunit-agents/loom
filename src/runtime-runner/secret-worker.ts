/** Private worker-side startup owner. Never instantiate in the loom daemon.
 * Configuration and lifecycle methods are owner capabilities, not operations.
 * No supplied current callback, viewer or daemon receipt is local authority. */
import {isAbsolute,normalize} from 'node:path';
import {certificateFingerprint,holderTls} from '../pieces/secrets/holder-authority.js';
import {startAdmittedSecretCommand} from './admitted-secret-command.js';
import type {SecretCommandConfig} from './secret-command.js';
import type {LocalHolderConfig} from '../pieces/secrets/local-holder.js';
import {secretName} from '../pieces/secrets/input.js';
import {secretInputBindingSchema,type SecretInputBinding} from './secret-input.js';

type Command=Awaited<ReturnType<typeof startAdmittedSecretCommand>>;
export interface SecretWorkerJob {
  binding:SecretInputBinding;
  name:string;
  config:SecretCommandConfig&{admission:LocalHolderConfig};
  expiresAt:number;
}
const failed=()=>new Error('Secret worker unavailable');

/** A worker owns each original local record by identity. Revocation and close
 * fence synchronously, including while process/listener startup is awaiting IO.
 * Configuration is explicit authority for this dedicated command only; it does
 * not import a grant from the daemon or create permission for public callers. */
export function startSecretWorker(config:{policy:readonly string[];grants:readonly {binding:SecretInputBinding;name:string;expiresAt:number}[];jobs:readonly SecretWorkerJob[]}) {
  const policy={allowed:new Set(config.policy.map(name=>secretName.parse(name)))};
  const grants=config.grants.map(g=>({binding:Object.freeze(secretInputBindingSchema.parse(g.binding)),
    name:secretName.parse(g.name),expiresAt:g.expiresAt,active:true}));
  const jobs=config.jobs;
  let closed=false,closing:Promise<void>|undefined;
  const records=jobs.map(job=>{
    const binding=Object.freeze(secretInputBindingSchema.parse(job.binding));
    const config={...job.config,args:[...job.config.args],env:{...job.config.env},
      input:{...job.config.input},authority:{...job.config.authority},admission:{...job.config.admission}};
    // Preflight ALL selections before any job can read TLS files/listen/spawn.
    // File existence, permissions and certificate contents remain IO-time checks.
    const path=(value:unknown)=>typeof value==='string'&&isAbsolute(value)&&!value.includes('\0');
    const endpoint=(value:LocalHolderConfig|Omit<LocalHolderConfig,'servername'>)=>{
      const {socket,ca,cert,key}=value;
      return holderTls.safeParse({socket,ca,cert,key}).success&&[socket,ca,cert,key].every(path);
    };
    if(!path(config.command)||!path(config.cwd)||config.args.some(arg=>typeof arg!=='string'||arg.includes('\0'))
      ||Object.entries(config.env).some(([key,value])=>!key||/[=\0]/.test(key)
        ||value!==undefined&&(typeof value!=='string'||value.includes('\0')))
      ||![config.input,config.authority,config.admission].every(endpoint)
      ||![config.authority,config.admission].every(peer=>typeof peer.servername==='string'&&!!peer.servername&&!peer.servername.includes('\0'))
      ||![config.holderFingerprint,config.daemonFingerprint].every(pin=>certificateFingerprint.safeParse(pin).success))throw failed();
    const name=secretName.parse(job.name);
    const matching=grants.filter(g=>g.name===name&&JSON.stringify(g.binding)===JSON.stringify(binding));
    if(!policy.allowed.has(name)||matching.length!==1||!Number.isFinite(matching[0].expiresAt)
      ||matching[0].expiresAt<job.expiresAt||!Number.isFinite(job.expiresAt)
      ||job.expiresAt<=Date.now()||job.expiresAt>Date.now()+30_000)throw failed();
    // These records are minted here; no caller can provide a replacement proof.
    const grant=matching[0],assignment={active:true,binding};
    const request={active:true};
    return {name,expiresAt:job.expiresAt,config,policy,grant,assignment,request,
      command:undefined as Command|undefined,starting:undefined as Promise<Command>|undefined};
  });
  if(records.length>1024||new Set(records.map(r=>r.assignment.binding.job)).size!==records.length)throw failed();
  // Each job owns a distinct listener. Refuse aliasing before starting anything.
  if(new Set(records.map(r=>normalize(r.config.input.socket))).size!==records.length)throw failed();
  const fence=(record:typeof records[number])=>{record.request.active=false;};
  const drain=async(record:typeof records[number])=>{
    fence(record);
    try {const command=record.command??await record.starting;await command?.close();}catch { /* startup already drained */ }
  };
  for(const record of records) {
    const {policy,grant,assignment,request}=record;
    const current=()=>!closed&&policy.allowed.has(record.name)&&grant.active&&assignment.active&&request.active
      &&Date.now()<record.expiresAt&&Date.now()<grant.expiresAt;
    record.starting=startAdmittedSecretCommand(record.config,{binding:assignment.binding,
      name:record.name,expiresAt:record.expiresAt,current}).then(command=>{
        record.command=command;
        if(!current())void command.close().catch(()=>{});
        // No automatic restart, retry or request replacement after either result.
        void command.completed.then(()=>{fence(record);});
        return command;
      });
    // Install rejection handling before returning the startup handle.
    void record.starting.catch(()=>{fence(record);});
  }
  const select=(job:string)=>{const record=records.find(r=>r.assignment.binding.job===job);if(!record)throw failed();return record;};
  return Object.freeze({
    jobs:Object.freeze(records.map(record=>Object.freeze({
      job:record.assignment.binding.job,
      delivery:record.starting!.then(command=>command.delivery,()=>false),
      completed:record.starting!.then(command=>command.completed,()=>false),
    }))),
    /** Owner lifecycle events revoke original records; equal metadata cannot
     * restore them. Reassignment requires a fresh worker startup and admission. */
    revokePolicy(job:string){const r=select(job);r.policy.allowed.delete(r.name);return Promise.all(records.filter(other=>other.name===r.name).map(drain)).then(()=>{});},
    revokeGrant(job:string){const r=select(job);r.grant.active=false;return drain(r);},
    stopJob(job:string){const r=select(job);r.assignment.active=false;return drain(r);},
    cancelRequest(job:string){return drain(select(job));},
    close(){
      if(closing)return closing;
      closed=true;for(const record of records)fence(record);
      return closing=Promise.all(records.map(drain)).then(()=>{});
    },
  });
}
