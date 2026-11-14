/** Typed private replies never pass their words through Attention or its receipts. */
import { z } from 'zod';
import { operation, OperationError, mayUseThread, type Viewer, type Result } from '../../core/index.js';
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
  return {ask:a,thread:matches[0]};
 };
 const row=(place:string,ref:string)=>db.prepare("SELECT * FROM comms_messages WHERE thread=? AND kind='message' AND id=?").get(place,`private-reply:${ref}`) as MessageRow|undefined;
 const route=(t:Thread)=>[t.id,t.member,t.agent,t.conversation,t.project,t.archived];
 operations.register(operation({name:'comms.replyToAsk',doors:['socket'],windowOnly:true,write:true,
  inputHash:value=>key.hash(`comms-operation\0${value}`),
  input:z.object({ref:id,text:z.string().min(1).max(4000).refine(s=>!!s.trim())}).strict(),output:z.object({thread:id,seq:z.number().int().positive()}),
  may:(viewer,input)=>{try{lookup(viewer,input.ref);return true;}catch{return false;}},
  async prepare(input,{viewer}) {
   const before=lookup(viewer,input.ref),old=row(before.thread.id,input.ref),hash=key.hash(JSON.stringify(input));
   if(before.thread.archived!==null)throw new OperationError('conflict','Unarchive this thread first');
   if(old&&(before.ask.state!=='answered'||old.sender!==before.thread.member))throw new OperationError('conflict','Private reply state changed');
   if(old&&old.hash!==hash)throw new OperationError('conflict','This ask already has a different reply');
   if(!old&&before.ask.state!=='open')throw new OperationError('conflict','Ask is no longer open');
   return {before,old,hash,words:old?undefined:await key.seal(JSON.stringify({text:input.text}))};
  },
  run(ctx,input,prepared) {
   const p=prepared as {before:ReturnType<typeof lookup>;old:MessageRow|undefined;hash:string;words:Buffer|undefined};
   const current=lookup(ctx.viewer,input.ref),t=current.thread;
   if(JSON.stringify(route(t))!==JSON.stringify(route(p.before.thread))||JSON.stringify(current.ask)!==JSON.stringify(p.before.ask)
     ||JSON.stringify(row(t.id,input.ref))!==JSON.stringify(p.old))throw new OperationError('conflict','Ask changed; check it again');
   let seq=p.old?.seq;
   if(!seq){
    seq=append(db,t,{id:`private-reply:${input.ref}`,kind:'message',at:ctx.now,sender:t.member,words:p.words!,hash:p.hash,record:JSON.stringify({delivery:'sending',attempted:false})}).seq;
   }
   const answer=o.attention.privateReply!(ctx,{id:input.ref,conversation:t.conversation,agent:t.agent,member:t.member,thread:t.id,seq});
   if(!answer.ok)throw new OperationError(answer.code,answer.message);
   ctx.changed('thread',t.id);ctx.changed('message',messageId(t.id,seq));
   return {thread:t.id,seq};
  },after:(input,result)=>{if(result.ok){const r=result.value as {thread:string;seq:number};const t=thread(db,r.thread);if(t&&!o.closed())o.changed(t,r.seq);}o.after(input,result);},
 }));
}
