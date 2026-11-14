/** Owner-only command startup. fd3 is a dedicated, one-use credential input;
 * stdin, stdout and stderr are disconnected. No public operation installs this.
 */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { Writable } from 'node:stream';
import { workerSecretInputs, secretInputBindingSchema, type SecretInputBinding } from './secret-input.js';
import { listenWorkerSecretInput } from './secret-transport.js';
import { remoteWorkerTicketProof } from '../pieces/secrets/ticket-authority.js';
import type { LocalHolderConfig } from '../pieces/secrets/local-holder.js';

const failed=()=>new Error('Worker secret command unavailable');
export interface SecretCommandConfig {
  /** All process settings and peer endpoints are owner configuration. Never
   * construct these from an operation, model response or admission reply. */
  command:string; args:readonly string[]; cwd:string; env:NodeJS.ProcessEnv;
  input:Omit<LocalHolderConfig,'servername'>; holderFingerprint:string;
  authority:LocalHolderConfig; daemonFingerprint:string;
}
export interface SecretCommandRequest {
  binding:SecretInputBinding;
  /** ORIGINAL synchronous owner proof includes policy, grant, job and request
   * replacement. This remains the final local fence after remote authority. */
  current:()=>boolean;
  expiresAt:number;
}

/** Starts a real process and private input listener, then registers that exact
 * process pipe. The returned pending handle must go through trusted admission;
 * bindTicket is called once with its original reply, never by a body operation.
 * This is not the admission transport or complete standalone composition.
 */
export async function startSecretCommand(config:SecretCommandConfig,request:SecretCommandRequest) {
  let binding:SecretInputBinding;
  try {binding=Object.freeze(secretInputBindingSchema.parse(request.binding));}catch {throw failed();}
  const originalCurrent=request.current,expiresAt=request.expiresAt;
  const authority=Object.freeze({...config.authority}),daemonFingerprint=config.daemonFingerprint;
  const command=config.command,args=[...config.args],cwd=config.cwd,env={...config.env};
  let closed=false,invalid=false;
  const current=()=>{
    if(closed||invalid)return false;
    try {if(Date.now()<expiresAt&&originalCurrent()===true)return true;}catch { /* sticky revocation */ }
    invalid=true;return false;
  };
  if(!isAbsolute(command)||!isAbsolute(cwd)||!current()||!Number.isFinite(expiresAt)
    ||expiresAt>Date.now()+30_000||typeof originalCurrent!=='function')throw failed();
  const inputs=workerSecretInputs();
  const listener=await listenWorkerSecretInput({...config.input},config.holderFingerprint,inputs);
  let child:ReturnType<typeof spawn>|undefined,input:Writable|undefined;
  let pending:ReturnType<typeof inputs.register>|undefined;
  let proof:ReturnType<typeof remoteWorkerTicketProof>|undefined;
  let bound=false,consumed=false,timer:ReturnType<typeof setTimeout>|undefined,closing:Promise<void>|undefined;
  let exited:Promise<void>|undefined;
  let settle:(ok:boolean)=>void=()=>{};
  const completed=new Promise<boolean>(resolve=>{settle=resolve;});
  const close=():Promise<void>=>{
    if(closing)return closing;
    closed=true;clearTimeout(timer);pending?.cancel();inputs.close();input?.destroy();child?.kill('SIGKILL');
    settle(false);
    return closing=Promise.all([listener.close(),proof?.close(),exited]).then(()=>{});
  };
  try {
    if(!current())throw failed();
    // No inherited prompt or diagnostic channels and no secret in argv/env.
    child=spawn(command,args,{cwd,env,shell:false,
      stdio:['ignore','ignore','ignore','pipe']});
    const process=child;
    exited=new Promise<void>(resolve=>process.once('close',()=>resolve()));
    process.once('error',()=>{void close().catch(()=>{});});
    process.once('exit',code=>{
      settle(code===0&&consumed&&current());void close().catch(()=>{});
    });
    const pipe=process.stdio[3];
    if(!(pipe instanceof Writable))throw failed();
    let finishWrite:((error?:Error|null)=>void)|undefined;
    // One write closes fd3 so the owning consumer can read to EOF. Destruction
    // settles an outstanding callback before the registry erases borrowed bytes.
    input=new Writable({
      write(bytes,_encoding,done) {
        let settled=false;
        finishWrite=error=>{if(settled)return;settled=true;finishWrite=undefined;consumed=!error;done(error);};
        try {pipe.end(bytes,(error?:Error|null)=>finishWrite?.(error?failed():undefined));}catch {finishWrite(failed());}
      },
      destroy(_error,done) {
        const drained=()=>{finishWrite?.(failed());done();};
        if(pipe.closed){drained();return;}
        pipe.once('close',drained);pipe.destroy();
      },
    });
    input.on('error',()=>{void close().catch(()=>{});});
    pipe.on('error',()=>{finishWrite?.(failed());void close().catch(()=>{});});
    await new Promise<void>((resolve,reject)=>{process.once('spawn',resolve);process.once('error',()=>reject(failed()));});
    if(!current())throw failed();
    pending=inputs.register(binding,input,current,async()=>proof?proof.current():false,expiresAt);
    timer=setTimeout(()=>{void close().catch(()=>{});},Math.max(0,expiresAt-Date.now()));
    return Object.freeze({
      pending:Object.freeze({id:pending.id,binding:pending.binding,cancel:()=>{void close().catch(()=>{});}}),
      /** One retained proof for the ORIGINAL ticket/pending pair. An invalid
       * reply burns this startup too; no correction, reconstruction or retry. */
      bindTicket(ticketId:string) {
        if(bound||!current())throw failed();bound=true;
        try {proof=remoteWorkerTicketProof(authority,daemonFingerprint,ticketId,pending!.id);}
        catch {void close().catch(()=>{});throw failed();}
      },
      completed,close,
    });
  }catch {await close();throw failed();}
}
