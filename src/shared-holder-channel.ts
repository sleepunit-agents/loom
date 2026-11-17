/** Private inherited IPC. No socket, public operation, credential or executable selection. */
import {isHolderGeneration} from './pieces/secrets/role.js';
import {z} from 'zod';
import type {Clock} from './core/clock.js';
import type {HolderStore} from './pieces/secrets/holder-store.js';
import type {RecoverableSecretMutations} from './pieces/secrets/shared-values.js';
import {secretName} from './pieces/secrets/input.js';
export interface HolderChannel {
 readonly connected:boolean;
 /** Node advanced IPC snapshots synchronously; callback reports later IO. */
 send(value:unknown,callback:(error:Error|null)=>void):boolean;
 on(event:'message'|'disconnect'|'error',fn:(value?:unknown)=>void):unknown;
 off(event:'message'|'disconnect'|'error',fn:(value?:unknown)=>void):unknown;
 disconnect():void;
}
const failed=()=>new Error('Shared secret holder unavailable');
const bytes=z.instanceof(Uint8Array).refine(value=>value.byteLength>0&&value.byteLength<=65536);
const who=z.object({member:z.string().min(1).max(256),writeId:z.uuid()}).strict();
const generation=z.string().refine(isHolderGeneration,'Invalid holder generation');
const base={seq:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)};
const request=z.discriminatedUnion('op',[
 z.object({...base,op:z.literal('read'),name:secretName}).strict(),
 z.object({...base,op:z.literal('generation')}).strict(),
 z.object({...base,op:z.literal('set'),who,name:secretName,value:bytes,mode:z.enum(['add','replace'])}).strict(),
 z.object({...base,op:z.literal('remove'),who,name:secretName}).strict(),
 z.object({...base,op:z.literal('receipt'),who}).strict(),
 z.object({...base,op:z.literal('recover'),who}).strict(),
 z.object({...base,op:z.literal('close')}).strict(),
]);
type Command=z.infer<typeof request>;
type WithoutSequence<T>=T extends unknown?Omit<T,'seq'>:never;
type Input=WithoutSequence<Command>;
const response=z.discriminatedUnion('op',[
 z.object({op:z.literal('ready'),key:z.instanceof(Uint8Array).refine(value=>value.byteLength===32)}).strict(),
 z.object({...base,op:z.literal('result'),ok:z.boolean(),value:z.union([bytes,z.boolean(),z.enum(['committed','undone']),generation,z.null()])}).strict(),
]);
const erase=(value:unknown)=>{
 const pending=[value],seen=new Set<object>();
 while(pending.length){const item=pending.pop();if(item instanceof Uint8Array){item.fill(0);continue;}if(item&&typeof item==='object'&&!seen.has(item)){seen.add(item);for(const child of Object.values(item))pending.push(child);}}
};
const send=(channel:HolderChannel,value:unknown)=>new Promise<void>((yes,no)=>{try{if(!channel.connected)throw failed();channel.send(value,error=>error?no(failed()):yes());}catch{no(failed());}});
/** The child is trusted storage, not a household authorization service. The
 * parent's existing Root boundary authorizes every call before it reaches IPC. */
export function serveSharedHolderChannel(channel:HolderChannel,start:()=>Promise<{store:HolderStore;key:Uint8Array}>){
 let stopped=false,last=0,store:HolderStore|undefined,closing:Promise<void>|undefined;
 const active=new Set<Promise<void>>();let finish!:()=>void;
 const done=new Promise<void>(yes=>{finish=yes;});
 const close=()=>{
  stopped=true;
  if(!closing){closing=(async()=>{try{await startup.catch(()=>{});await Promise.allSettled([...active]);store?.close();}finally{detach();try{if(channel.connected)channel.disconnect();}finally{finish();}}})();void closing.catch(()=>{});}
  return closing;
 };
 const lost=()=>{void close();};
 const detach=()=>{channel.off('message',message);channel.off('disconnect',lost);channel.off('error',lost);};
 const execute=async(command:Command)=>{
  if(command.op==='close')return null;
  if(command.op==='read')return store!.read(command.name);
  if(command.op==='generation')return generation.parse(store!.generation());
  if(command.op==='set'){await store!.set(command.who,command.name,command.value,command.mode);return null;}
  if(command.op==='remove'){store!.remove(command.who,command.name);return null;}
  if(command.op==='receipt')return store!.hasReceipt(command.who);
  return store!.recover(command.who);
 };
 const message=(raw:unknown)=>{
  const parsed=request.safeParse(raw);
  if(stopped||!store||!parsed.success||parsed.data.seq!==last+1||active.size>=64){erase(raw);void close();return;}
  const command=parsed.data;last=command.seq;
  if(command.op==='close'){
   stopped=true;const pending=[...active];
   void (async()=>{await Promise.allSettled(pending);store!.close();await send(channel,{op:'result',seq:command.seq,ok:true,value:null});})().catch(()=>{}).finally(()=>{void close();});return;
  }
  const work=Promise.resolve().then(async()=>{
   let value:unknown=null,ok=false;
   try{value=await execute(command);ok=!stopped;}catch{/* Keep storage diagnostics off the channel. */}
   // Capacity belongs to storage work, not a later IPC write callback. Node's
   // advanced serializer snapshots in send(), before the peer can refill it.
   active.delete(work);
   try{if(!stopped)void send(channel,{op:'result',seq:command.seq,ok,value:ok?value:null}).catch(()=>{void close();});}
   finally{erase(command);if(value instanceof Uint8Array)value.fill(0);}
  });
  active.add(work);void work.finally(()=>active.delete(work)).catch(()=>{});
 };
 channel.on('message',message);channel.on('disconnect',lost);channel.on('error',lost);
 const startup=Promise.resolve().then(async()=>{
  const selected=await start();store=selected.store;
  try{if(stopped||!channel.connected)throw failed();await send(channel,{op:'ready',key:selected.key});}finally{selected.key.fill(0);}
 });
 void startup.catch(()=>{void close();});
 return {done,close};
}
/** A lost/timed-out/malformed exchange retires this original channel. It is
 * never reconnected or retried; the durable writer reconciles a later startup. */
export function sharedHolderClient(channel:HolderChannel,clock:Clock){
 let seq=0,stopped=false,retiring=false;let resolve!:(key:Uint8Array)=>void,reject!:(error:Error)=>void;
 const ready=new Promise<Uint8Array>((yes,no)=>{resolve=yes;reject=no;});void ready.catch(()=>{});
 const pending=new Map<number,{op:Command['op'];yes:(value:any)=>void;no:(error:Error)=>void;cancel:()=>void}>();
 const discard=(value?:unknown)=>erase(value);
 const detachDiscard=()=>{channel.off('message',discard);channel.off('disconnect',detachDiscard);channel.off('error',detachDiscard);};
 const retire=({fault}:{fault:boolean})=>{if(stopped)return;stopped=true;cancelReady();reject(failed());for(const item of pending.values()){item.cancel();item.no(failed());}pending.clear();detach();try{if(channel.connected){if(fault)channel.disconnect();else{channel.on('message',discard);channel.on('disconnect',detachDiscard);channel.on('error',detachDiscard);}}}catch{}};
 const stop=()=>retire({fault:true});
 const detach=()=>{channel.off('message',message);channel.off('disconnect',stop);channel.off('error',stop);};
 let welcomed=false;
 const message=(raw:unknown)=>{
  const parsed=response.safeParse(raw);
  if(stopped||!parsed.success){erase(raw);stop();return;}
  const value=parsed.data;
  if(value.op==='ready'){
   if(welcomed){erase(raw);stop();return;}welcomed=true;cancelReady();resolve(Buffer.from(value.key));value.key.fill(0);return;
  }
  const item=pending.get(value.seq);
  if(!welcomed||!item){erase(raw);stop();return;}
  const valid=!value.ok?value.value===null:item.op==='read'?value.value instanceof Uint8Array:item.op==='generation'?generation.safeParse(value.value).success:item.op==='receipt'?typeof value.value==='boolean':item.op==='recover'?value.value==='committed'||value.value==='undone':value.value===null;
  if(!valid){erase(raw);stop();return;}
  pending.delete(value.seq);item.cancel();
  if(!value.ok){item.no(failed());return;}
  if(value.value instanceof Uint8Array){const copy=Buffer.from(value.value);value.value.fill(0);item.yes(copy);}else item.yes(value.value);
 };
 const cancelReady=clock.at(clock.now()+5000,stop);
 channel.on('message',message);channel.on('disconnect',stop);channel.on('error',stop);
 const call=(input:Input):Promise<any>=>{
  if(stopped||!welcomed||retiring&&input.op!=='close'||pending.size>=64){erase(input);return Promise.reject(failed());}
  const id=++seq;return new Promise((yes,no)=>{
   pending.set(id,{op:input.op,yes,no,cancel:clock.at(clock.now()+5000,stop)});
   void send(channel,{...input,seq:id}).catch(stop);erase(input);
  });
 };
 const holder:RecoverableSecretMutations={
  async set(who,name,value,mode){await call({op:'set',who,name,value:Buffer.from(value),mode});},
  async remove(who,name){await call({op:'remove',who,name});},
  hasReceipt:who=>call({op:'receipt',who}),recover:who=>call({op:'recover',who}),
 };
 let closing:Promise<void>|undefined;
 return {ready,holder,source:{read:(name:string)=>call({op:'read',name}),generation:():Promise<string>=>call({op:'generation'})},stop,
  close(){retiring=true;return closing??=(async()=>{let acknowledged=false;try{if(welcomed&&!stopped){await call({op:'close'});acknowledged=true;}}finally{
   // The child closes its channel after the reply. Active parent disconnect
   // can suppress ChildProcess.close on Node24; retire IO without racing EOF.
   retire({fault:!acknowledged});
  }})();},
 };
}
