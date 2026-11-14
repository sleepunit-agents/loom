/** Composition-root configuration only. Never accepted through an operation,
 * environment discovery or a worker message. No holder source/value lives here. */
import type {Foundation} from './core/app.js';
import type {OutsideEffects} from './core/effects.js';
import type {Sharing} from './core/index.js';
import {signin} from './core/signin/index.js';
import {runtimeHouseDestination} from './pieces/runtime/role.js';
import {secretTickets} from './pieces/secrets/tickets.js';
import {listenTicketAuthority} from './pieces/secrets/ticket-authority.js';
import {listenWorkerAdmission} from './pieces/secrets/worker-admission.js';
import {certificateFingerprint} from './pieces/secrets/holder-authority.js';
import {localHolderHandoff} from './pieces/secrets/holder-handoff.js';
import type {LocalHolderConfig} from './pieces/secrets/local-holder.js';

type ServerConfig=Omit<LocalHolderConfig,'servername'>;
export interface SecretWorkersConfig {
  authority:ServerConfig;
  admission:ServerConfig;
  holder:{config:LocalHolderConfig;fingerprint:string};
  /** Existing owner-selected job credential, resolved by Signin at startup.
   * This is its digest, never a newly issued credential or a supplied viewer. */
  workers:readonly {tokenDigest:string;fingerprint:string}[];
}
const failed=()=>new Error('Secret worker startup unavailable');
/** Capture all owner selections before the composition root's first await. */
export function snapshotSecretWorkers(config:SecretWorkersConfig):SecretWorkersConfig {
  return {authority:{...config.authority},admission:{...config.admission},
    holder:{config:{...config.holder.config},fingerprint:config.holder.fingerprint},
    workers:Array.from(config.workers,w=>({tokenDigest:w.tokenDigest,fingerprint:w.fingerprint}))};
}

export async function startSecretWorkers(app:Foundation,sharing:()=>Sharing,effects:OutsideEffects,config:SecretWorkersConfig) {
  let holder:ReturnType<typeof localHolderHandoff>|undefined;
  let authority:Awaited<ReturnType<typeof listenTicketAuthority>>|undefined;
  let admission:Awaited<ReturnType<typeof listenWorkerAdmission>>|undefined;
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{
    // Retire/drain original dispatches while central authority and SQLite live.
    try {await admission?.close();}
    finally {try {await authority?.close();}finally {await holder?.close();}}
  })();
  try {
    config=snapshotSecretWorkers(config);
    if(app.db.inTransaction||config.authority.socket===config.admission.socket
      ||!config.workers.length||config.workers.length>1024)throw failed();
    holder=localHolderHandoff(config.holder.config,config.holder.fingerprint);
    const originalHolder=holder;
    const resolve=(selected:SecretWorkersConfig['workers'])=>{
    if(selected.length>1024)throw failed();
    const workers=Array.from(selected,worker=>{
      const fingerprint=certificateFingerprint.parse(worker.fingerprint);
      if(fingerprint===config.holder.fingerprint)throw failed();
      if(!/^[a-f0-9]{64}$/.test(worker.tokenDigest))throw failed();
      const viewer=signin(app).token(worker.tokenDigest)?.viewer;
      const destination=viewer&&runtimeHouseDestination(app,sharing,viewer);
      if(!viewer||!destination||!destination.current())throw failed();
      const {agent,job,runner,box,claimedAt,service}=destination;
      return {fingerprint,viewer,holder:originalHolder,
        binding:{agent,job,runner,box,claimedAt,...(service===undefined?{}:{service})}};
    });
    if(new Set(workers.map(w=>w.fingerprint)).size!==workers.length)throw failed();
    return workers;
    };
    const workers=resolve(config.workers);
    // SAME ticket owner for worker admission and holder/worker authority.
    const tickets=secretTickets(app,sharing,effects);
    authority=await listenTicketAuthority(config.authority,config.holder.fingerprint,tickets,workers);
    admission=await listenWorkerAdmission(config.admission,tickets,workers);
    return Object.freeze({close,
      /** Trusted source composition only: resolve fresh ORIGINAL Signin/Runtime
       * capabilities, then replace both listeners without rediscovery or IO. */
      replaceWorkers(selected:SecretWorkersConfig['workers']) {
        try {
          if(closing||app.db.inTransaction)throw failed();
          const next=resolve(selected);
          authority!.replaceWorkers(next);
          admission!.replaceWorkers(next);
        }catch {throw failed();}
      },
    });
  }catch {try {await close();}catch { /* preserve generic startup error */ }throw failed();}
}
