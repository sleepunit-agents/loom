/** Private inherited IPC only. No listener, discovery, values, paths or keys.
 * Possession belongs to the spawning supervisor; reconnect/adoption is absent. */
import {z} from 'zod';
import {secretInputBindingSchema} from './pieces/secrets/worker-binding.js';
import {certificateFingerprint} from './pieces/secrets/holder-authority.js';
import type {PersistentHolderWorkers} from './secret-holder-startup.js';
const workers=z.array(z.object({binding:secretInputBindingSchema,fingerprint:certificateFingerprint}).strict()).max(1024);
const request=z.discriminatedUnion('op',[
  z.object({op:z.literal('replace'),seq:z.number().int().positive(),workers}).strict(),
  z.object({op:z.literal('close'),seq:z.number().int().positive()}).strict(),
]);
const reply=z.object({op:z.enum(['ready','replaced','closed']),seq:z.number().int().nonnegative()}).strict();
const failed=()=>new Error('Secret holder owner unavailable');
/** Node's already-inherited process/ChildProcess IPC capability. Callers must
 * never implement this by opening a public listener or looking up a pid. */
export interface HolderOwnerChannel {
  readonly connected:boolean;
  send(message:unknown,callback:(error:Error|null)=>void):boolean;
  on(event:'message'|'disconnect'|'error',listener:(value?:unknown)=>void):unknown;
  off(event:'message'|'disconnect'|'error',listener:(value?:unknown)=>void):unknown;
  disconnect():void;
}
interface OwnedHolder {
  replaceOwnedWorkers(selected:z.infer<typeof workers>):Promise<void>;
  close():Promise<void>;
}
/** Install before startup IO. Channel loss fences the original handle even
 * when startup resolves late; done joins startup, requests, and actual close. */
export function serveHolderOwner(channel:HolderOwnerChannel,start:()=>Promise<OwnedHolder>) {
  let holder:OwnedHolder|undefined,stopped=false,busy=false,seq=0,cleanClose=false,fault=false;
  let finish!:()=>void,reject!:(error:Error)=>void;
  const done=new Promise<void>((yes,no)=>{finish=yes;reject=no;});
  let pending:Promise<void>=Promise.resolve(),closing:Promise<void>|undefined;
  let startup:Promise<void>,retiring:Promise<void>|undefined;
  const retire=()=>retiring??=Promise.resolve().then(()=>holder?.close());
  const detach=()=>{channel.off('message',message);channel.off('disconnect',lost);channel.off('error',lost);};
  const close=(clean=cleanClose)=>{
    stopped=true;
    // Fence the original owner immediately, before joining a held replacement.
    // Waiting for its ack first would leave that generation live on channel loss.
    if(holder)void retire().catch(()=>{});
    if(!closing) {
    closing=(async()=>{
      let ok=clean;
      try {await startup;}catch {ok=false;}
      try {await pending;}catch {ok=false;}
      try {await retire();}catch {ok=false;}
      detach();try {if(channel.connected)channel.disconnect();}catch {ok=false;}
      if(ok&&!fault)finish();else {reject(failed());throw failed();}
    })();
    void closing.catch(()=>{});
    }
    return closing;
  };
  const send=(value:z.infer<typeof reply>)=>new Promise<void>((yes,no)=>{
    try {if(!channel.connected)throw failed();channel.send(value,error=>error?no(failed()):yes());}catch {no(failed());}
  });
  const lost=()=>{if(!cleanClose)fault=true;void close();};
  const message=(value:unknown)=>{
    const parsed=request.safeParse(value);
    if(stopped||busy||!holder||!parsed.success||parsed.data.seq!==seq+1){fault=true;void close();return;}
    const command=parsed.data;seq=command.seq;busy=true;
    pending=(async()=>{
      if(command.op==='replace') {
        await holder!.replaceOwnedWorkers(command.workers);
        if(stopped)throw failed();
        await send({op:'replaced',seq});busy=false;
      }else {
        // The close acknowledgement is sent only after every original route,
        // listener, transport and storage owner has joined retirement.
        stopped=true;await retire();if(fault)throw failed();cleanClose=true;await send({op:'closed',seq});
      }
    })();
    void pending.then(()=>{if(command.op==='close')void close(true);},()=>{void close();});
  };
  channel.on('message',message);channel.on('disconnect',lost);channel.on('error',lost);
  startup=Promise.resolve().then(async()=>{
    if(!channel.connected||stopped)throw failed();
    holder=await start();
    if(stopped)return;
    await send({op:'ready',seq:0});
  });
  void startup.catch(()=>{void close();});
  // The owner must observe done; keep early transport loss from becoming an
  // unhandled rejection before its caller attaches a shutdown continuation.
  void done.catch(()=>{});
  return Object.freeze({done,close:()=>close(true)});
}

/** A single original child channel, with no retries or generation adoption.
 * A timeout/wrong/lost ack permanently poisons it; no slot reuse until done. */
export function holderOwner(channel:HolderOwnerChannel,timeoutMs=5000) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw failed();
  let stopped=false,seq=0,ready=false;
  let resolveReady!:()=>void,rejectReady!:(error:Error)=>void;
  const started=new Promise<void>((yes,no)=>{resolveReady=yes;rejectReady=no;});
  let waiting:{op:'replaced'|'closed';seq:number;yes:()=>void;no:(error:Error)=>void}|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const clear=()=>{if(timer)clearTimeout(timer);timer=undefined;};
  const stop=()=>{
    if(stopped)return;stopped=true;clear();rejectReady(failed());waiting?.no(failed());waiting=undefined;
    channel.off('message',message);channel.off('disconnect',stop);channel.off('error',stop);
    try {if(channel.connected)channel.disconnect();}catch {}
  };
  const arm=()=>{clear();timer=setTimeout(stop,timeoutMs);};
  const message=(value:unknown)=>{
    const result=reply.safeParse(value);if(stopped)return;
    if(!result.success){stop();return;}
    const response=result.data;
    if(!ready&&response.op==='ready'&&response.seq===0){ready=true;clear();resolveReady();return;}
    if(!waiting||response.op!==waiting.op||response.seq!==waiting.seq){stop();return;}
    const {yes}=waiting;waiting=undefined;clear();yes();
    if(response.op==='closed')stop();
  };
  channel.on('message',message);channel.on('disconnect',stop);channel.on('error',stop);
  arm();if(!channel.connected)stop();
  void started.catch(()=>{});
  const call=async(command:{op:'replace';workers:z.infer<typeof workers>}|{op:'close'})=>{
    // Snapshot before awaiting readiness. Only bindings and peer pins cross;
    // executable/transport/key selections cannot be supplied over this channel.
    command=structuredClone(command);
    await started;
    if(stopped||waiting) {stop();throw failed();}
    const current=++seq;
    return new Promise<void>((yes,no)=>{
      waiting={op:command.op==='replace'?'replaced':'closed',seq:current,yes,no};arm();
      try {channel.send({...command,seq:current},error=>{if(error)stop();});}catch {stop();}
    });
  };
  let closing:Promise<void>|undefined;
  return Object.freeze({ready:started,
    replaceWorkers(selected:PersistentHolderWorkers) {
      try {
        // The source retains local transport selections. The holder uses its
        // own startup peers, never these caller-provided paths or key material.
        const value=workers.parse(selected.map(({binding,fingerprint})=>({binding,fingerprint})));
        return call({op:'replace',workers:value});
      }catch {stop();return Promise.reject(failed());}
    },close:()=>closing??=call({op:'close'}),abort:stop});
}
