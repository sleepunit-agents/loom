/** Typed private replies never pass their words through Attention or its receipts. */
import { z } from 'zod';
import { operation, OperationError, mayUseThread, type Viewer, type Result } from '../../core/index.js';
import { commsMetadata } from './role.js';
import type { Options } from './index.js';
import { append, messageId, thread, type Thread, type MessageRow } from './store.js';
const id=z.string().min(1).max(200);
const ask=z.object({id,agent:id,member:id,source:z.object({kind:z.literal('conversation'),id}),state:z.enum(['open','answered','resolved'])}).passthrough();
export function installPrivateReplies(o:Options & {closed():boolean;changed(t:Thread,seq?:number):void;after(input:unknown,result:Result):void}) {
 const {db,operations,key}=o;
 const deny=(message='Ask unavailable'):never=>{throw new OperationError('denied',message);};
 const lookup=(viewer:Viewer,ref:string)=>{
  if(o.closed()||!o.attention.get||!o.attention.privateReply)return deny();
  const result=o.attention.get(viewer,{id:ref});
  if(!result.ok)return deny();
  const parsed=ask.safeParse(result.value);if(!parsed.success)return deny();const a=parsed.data;
  if(a.id!==ref||viewer.kind!=='member'||a.member!==viewer.id)return deny();
  const matches=(db.prepare("SELECT record FROM comms_threads WHERE member=? AND agent=? AND json_extract(record,'$.conversation')=? LIMIT 2").all(a.member,a.agent,a.source.id) as {record:string}[])
   .map(r=>JSON.parse(r.record) as Thread);
  if(matches.length!==1||matches[0].agent!==a.agent||!mayUseThread(viewer,matches[0],o.sharing()))return deny();
  const t=matches[0];
  // Sealed provenance comes from the owning projection, never a ref prefix.
  let source:MessageRow|undefined;
  if('privateQuestion' in a){
   const q=z.object({thread:id,seq:z.number().int().positive()}).safeParse(a.privateQuestion);
   const route=commsMetadata(operations)?.privateThread(viewer,{id:a.source.id,member:a.member,agent:a.agent});
   if(!q.success||!route||route.id!==t.id||q.data.thread!==t.id||t.archived!==null)return deny();
   source=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(t.id,q.data.seq) as MessageRow|undefined;
   if(!source||source.id!==ref||source.kind!=='ask'||source.sender!==a.agent||!source.words||source.at+(o.days??14)*86400_000<=o.clock.now())return deny();
   const meta=JSON.parse(source.record);if(meta.encoding!=='ask'||meta.ref!==ref)return deny();
  }
  return {ask:a,thread:t,source};
 };
 const row=(place:string,ref:string)=>db.prepare("SELECT * FROM comms_messages WHERE thread=? AND kind='message' AND id=?").get(place,`private-reply:${ref}`) as MessageRow|undefined;
 const question=({state:_,changedAt:__,answer:___,...rest}:Record<string,unknown>)=>JSON.stringify(rest);
 const sourceIdentity=(s:ReturnType<typeof lookup>)=>s.source?[s.thread.id,s.thread.member,s.thread.agent,s.thread.conversation,s.thread.project,question(s.ask),s.source]:null;
 const validate=(current:ReturnType<typeof lookup>,before:ReturnType<typeof lookup>)=>{
  if(JSON.stringify(sourceIdentity(current))!==JSON.stringify(sourceIdentity(before)))return deny();
 };
 const route=(t:Thread)=>[t.id,t.member,t.agent,t.conversation,t.project,t.archived];
 operations.register(operation({name:'comms.replyToAsk',doors:['socket'],windowOnly:true,write:true,
  inputHash:(value,identity)=>{
   const s=lookup(identity.actor,(identity.input as {ref:string}).ref),source=sourceIdentity(s);
   return source?key.hash(JSON.stringify([value,source])):key.hash(`comms-operation\0${value}`);
  },
  validateReplay:(viewer,input,prepared)=>{
   const current=lookup(viewer,input.ref),p=prepared as {before:ReturnType<typeof lookup>}|undefined;
   if(p)validate(current,p.before);
  },
  input:z.object({ref:id,text:z.string().min(1).max(4000).refine(s=>!!s.trim())}).strict(),output:z.object({thread:id,seq:z.number().int().positive()}),
  may:(viewer,input)=>{try{lookup(viewer,input.ref);return true;}catch{return false;}},
  async prepare(input,{viewer}) {
   const before=lookup(viewer,input.ref),old=row(before.thread.id,input.ref),hash=key.hash(JSON.stringify(before.source?[input,sourceIdentity(before)]:input));
   if(before.thread.archived!==null)throw new OperationError('conflict','Unarchive this thread first');
   if(old&&(before.ask.state!=='answered'||old.sender!==before.thread.member))throw new OperationError('conflict','Private reply state changed');
   if(old&&old.hash!==hash)throw new OperationError('conflict','This ask already has a different reply');
   if(!old&&before.ask.state!=='open')throw new OperationError('conflict','Ask is no longer open');
   return {before,old,hash,words:old?undefined:await key.seal(JSON.stringify({text:input.text,ref:input.ref}))};
  },
  run(ctx,input,prepared) {
   const p=prepared as {before:ReturnType<typeof lookup>;old:MessageRow|undefined;hash:string;words:Buffer|undefined};
   const current=lookup(ctx.viewer,input.ref),t=current.thread;
   if(JSON.stringify(route(t))!==JSON.stringify(route(p.before.thread)))throw new OperationError('conflict','Thread changed; check it again');
   validate(current,p.before);
   const existing=row(t.id,input.ref);
   const unchanged=JSON.stringify(current.ask)===JSON.stringify(p.before.ask)&&JSON.stringify(existing)===JSON.stringify(p.old);
   let seq=p.old?.seq;
   if(!unchanged){
    // A concurrent identical first answer is a receipt, not a competing answer.
    // Delivery metadata may move, but an observed reply's identity/words cannot.
    const stable=(r:MessageRow)=>[r.thread,r.seq,r.id,r.kind,r.at,r.sender,r.hash];
    const sameWords=!p.old||!!existing&&JSON.stringify(stable(existing))===JSON.stringify(stable(p.old))
     &&(p.old.words===null?existing.words===null:!!existing.words?.equals(p.old.words)||existing.words===null&&existing.at+(o.days??14)*86400_000<=ctx.now);
    if(!existing||existing.hash!==p.hash||existing.sender!==t.member||current.ask.state!=='answered'
     ||question(current.ask)!==question(p.before.ask)||!sameWords)throw new OperationError('conflict','Ask changed; check it again');
    seq=existing.seq;
   }
   if(!seq)seq=append(db,t,{id:`private-reply:${input.ref}`,kind:'message',at:ctx.now,sender:t.member,words:p.words!,hash:p.hash,record:JSON.stringify({delivery:'sending',attempted:false})},input.text).seq;
   const answer=o.attention.privateReply!(ctx,{id:input.ref,conversation:t.conversation,agent:t.agent,member:t.member,thread:t.id,seq});
   if(!answer.ok)throw new OperationError(answer.code,answer.message);
   ctx.changed('thread',t.id);ctx.changed('message',messageId(t.id,seq));
   return {thread:t.id,seq};
  },after:(input,result)=>{if(result.ok){const r=result.value as {thread:string;seq:number};const t=thread(db,r.thread);if(t&&!o.closed())o.changed(t,r.seq);}o.after(input,result);},
 }));
}
