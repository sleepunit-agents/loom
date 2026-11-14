/** Private source owner, outside all registry doors. The supervisor supplies
 * capabilities for its separately owned daemon and holder; no holder keys or
 * values enter this owner. One selection owns those exclusive route slots. */
import type {Foundation} from './core/app.js';
import type {Sharing} from './core/index.js';
import {signin} from './core/signin/index.js';
import {runtimeHouseDestination} from './pieces/runtime/role.js';
import type {PersistentHolderWorkers} from './secret-holder-startup.js';
import type {SecretWorkersConfig} from './secret-worker-startup.js';
import type {SecretWorkerSelection,SecretWorkerJob} from './runtime-runner/secret-worker.js';

export interface SecretAssignment {
  selection:SecretWorkerSelection;
  current():boolean;
  close():Promise<void>;
}
export interface SecretAssignmentSource {readonly signal:AbortSignal;claimed(job:string):Promise<SecretAssignment>;own(drain:()=>Promise<void>):void;close():Promise<void>}
const failed=()=>new Error('Secret job assignment unavailable');
/** Capture explicit local selections BEFORE claim IO. Resolve the original
 * Signin/Runtime destination only AFTER claim, never predict claimedAt. This
 * source is single-use, including on failure; replacing an old proof requires
 * a new owner, never a refresh of this one. */
export function secretJobAssignment(app:Foundation,sharing:()=>Sharing,
  config:{job:string;agent:string;tokenDigest:string;fingerprint:string;policy:readonly string[];
    name:string;expiresAt:number;grantExpiresAt:number;command:SecretWorkerJob['config'];
    holder:Omit<PersistentHolderWorkers[number],'binding'>},
  owners:{daemon:{replaceWorkers(workers:SecretWorkersConfig['workers']):void};
    holder:{replaceWorkers(workers:PersistentHolderWorkers):Promise<void>}}):SecretAssignmentSource {
  config=structuredClone(config);
  const replaceDaemon=owners.daemon.replaceWorkers.bind(owners.daemon),replaceHolder=owners.holder.replaceWorkers.bind(owners.holder);
  const stop=new AbortController();
  let used=false,active:SecretAssignment|undefined,closing:Promise<void>|undefined,drain:(()=>Promise<void>)|undefined;
  const retire=()=>{
    stop.abort();
    return closing??=(async()=>{
      const outcomes=await Promise.allSettled([
        Promise.resolve().then(()=>active?.close()),Promise.resolve().then(()=>drain?.()),
      ]);
      if(outcomes.some(result=>result.status==='rejected'))throw failed();
    })();
  };
  return Object.freeze({signal:stop.signal,close:retire,
    own(closeWorker:()=>Promise<void>) {
      if(used||stop.signal.aborted||drain||typeof closeWorker!=='function')throw failed();
      drain=closeWorker;
    },async claimed(job:string) {
    if(used||stop.signal.aborted)throw failed();used=true;
    if(app.db.inTransaction||job!==config.job)throw failed();
    const viewer=signin(app).token(config.tokenDigest)?.viewer;
    const destination=viewer&&runtimeHouseDestination(app,sharing,viewer);
    if(!destination||destination.job!==job||destination.agent!==config.agent||!destination.current())throw failed();
    const {agent,runner,box,claimedAt,service}=destination;
    const binding={agent,job,runner,box,claimedAt,...(service===undefined?{}:{service})};
    let retired=false,closing:Promise<void>|undefined;
    const current=()=>{
      if(retired||stop.signal.aborted)return false;
      try {if(Date.now()<config.expiresAt&&Date.now()<config.grantExpiresAt&&destination.current())return true;}catch {}
      retired=true;void retire().catch(()=>{});return false;
    };
    const close=()=>{
      if(closing)return closing;
      retired=true;
      // Both generations are fenced even if one retirement fails. Do not
      // reconstruct a route or retry a failed lifecycle transfer.
      return closing=(async()=>{
        const outcomes=await Promise.allSettled([
          Promise.resolve().then(()=>replaceDaemon([])),Promise.resolve().then(()=>replaceHolder([])),
        ]);
        if(outcomes.some(result=>result.status==='rejected'))throw failed();
      })();
    };
    active=Object.freeze({selection:{policy:config.policy,
      grants:[{binding,name:config.name,expiresAt:config.grantExpiresAt}],
      jobs:[{binding,name:config.name,config:config.command,expiresAt:config.expiresAt}]},current,close});
    try {
      replaceDaemon([{tokenDigest:config.tokenDigest,fingerprint:config.fingerprint}]);
      await replaceHolder([{...config.holder,binding}]);
      if(!current())throw failed();
      return active;
    }catch {try {await close();}catch {}throw failed();}
  }});
}
