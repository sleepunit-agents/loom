/** Sealed yes/no decisions re-enter their owning conversation as encrypted messages. */
import {z} from 'zod';
import {OperationError,type Viewer,type Context} from '../../core/index.js';
import type {Options} from './index.js';
import {commsMetadata} from './role.js';
import {append,thread,type MessageRow} from './store.js';
const projection=z.object({id:z.string(),member:z.string(),agent:z.string(),source:z.object({kind:z.literal('conversation'),id:z.string()}),
 privateQuestion:z.object({thread:z.string(),seq:z.number().int().positive()}),answers:z.literal('yes-no'),state:z.enum(['open','answered','resolved']),
 sourceManaged:z.literal(false).optional(),waits_on:z.never().optional(),
 answer:z.object({kind:z.enum(['yes','no']),by:z.object({kind:z.literal('member'),id:z.string()})}).passthrough().optional()}).passthrough();
const question=z.object({ask:z.string(),if_yes:z.string().optional(),if_no:z.string().optional(),answers:z.literal('yes-no')}).passthrough();
type Input={thread:string;ref:string;verdict:'yes'|'no';words?:string};
export function privateDecisions(o:Options & {closed():boolean}) {
 const deny=():never=>{throw new OperationError('denied','Question unavailable');};
 const lookup=(viewer:Viewer,i:Input)=>{
  if(o.closed()||viewer.kind!=='member'||i.words!==undefined||!o.attention.get||!o.attention.privateDecision)return deny();
  const got=o.attention.get(viewer,{id:i.ref});if(!got.ok)return deny();
  const parsed=projection.safeParse(got.value);if(!parsed.success)return deny();const a=parsed.data;
  if(a.id!==i.ref||a.member!==viewer.id)return deny();
  const t=commsMetadata(o.operations)?.privateThread(viewer,{id:a.source.id,agent:a.agent,member:a.member});
  if(!t||t.id!==i.thread||t.id!==a.privateQuestion.thread||t.archived!==null)return deny();
  const row=o.db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(t.id,a.privateQuestion.seq) as MessageRow|undefined;
  if(!row||row.id!==i.ref||row.kind!=='ask'||row.sender!==a.agent||!row.words||row.at+(o.days??14)*86400_000<=o.clock.now())return deny();
  const meta=JSON.parse(row.record);if(meta.encoding!=='ask'||meta.ref!==i.ref)return deny();
  const stored=thread(o.db,t.id);if(!stored)return deny();
  return {a,t:stored,row};
 };
 const route=(t:ReturnType<typeof lookup>['t'])=>[t.id,t.member,t.agent,t.conversation,t.project,t.archived];
 const unchanged=(current:ReturnType<typeof lookup>,before:ReturnType<typeof lookup>)=>JSON.stringify(route(current.t))===JSON.stringify(route(before.t))&&JSON.stringify(current.row)===JSON.stringify(before.row);
 const existing=(i:Input)=>o.db.prepare('SELECT * FROM comms_messages WHERE thread=? AND id=?').get(i.thread,`answer:${i.ref}`) as MessageRow|undefined;
 const hash=(i:Input)=>o.key.hash(JSON.stringify(i));
 const receipt=(s:ReturnType<typeof lookup>,i:Input)=>{
  const old=existing(i);
  if(s.a.state==='open'&&!old)return;
  if(s.a.state==='answered'&&s.a.answer?.kind===i.verdict&&s.a.answer.by.id===s.t.member&&old?.kind==='message'&&old.sender===s.t.member&&old.hash===hash(i))return old;
  throw new OperationError('conflict','Question is no longer open');
 };
 return {
  sealed(viewer:Viewer,ref:string){
   const got=o.attention.get?.(viewer,{id:ref});
   return !!got?.ok&&typeof got.value==='object'&&got.value!==null&&'privateQuestion' in got.value;
  },
  allowed(viewer:Viewer,i:Input){try{lookup(viewer,i);return true;}catch{return false;}},
  fingerprint(viewer:Viewer,i:Input,canonical:string){
   const {a,t,row}=lookup(viewer,i);
   return o.key.hash(JSON.stringify([canonical,[t.id,t.member,t.agent,t.conversation,t.project],
    a.id,a.agent,a.member,a.source,a.privateQuestion,a.answers,row]));
  },
  validateReplay(viewer:Viewer,i:Input,raw?:unknown){
   const p=(raw as {decision?:{before:ReturnType<typeof lookup>}}|undefined)?.decision;
   if(!p)return;
   const current=lookup(viewer,i);
   if(!unchanged(current,p.before))return deny();
  },
  async prepare(i:Input,viewer:Viewer){
   const before=lookup(viewer,i),old=receipt(before,i);
   const q=question.parse(JSON.parse(await o.key.open(before.row.words!)));
   const outcome=i.verdict==='yes'?q.if_yes:q.if_no;
   const text=`${i.verdict==='yes'?'Yes':'No'}, to: ${q.ask}${outcome?`\n\n${outcome}`:''}`;
   return {before,old,words:old?undefined:await o.key.seal(JSON.stringify({text,ref:i.ref,verdict:i.verdict}))};
  },
  run(ctx:Context,i:Input,p:{before:ReturnType<typeof lookup>;old:MessageRow|undefined;words:Buffer|undefined}){
   const current=lookup(ctx.viewer,i);
   // Route and ciphertext are immutable across decryption/encryption, even on replay.
   if(!unchanged(current,p.before))return deny();
   const old=receipt(current,i);
   if(old){
    const stable=(r:MessageRow)=>[r.thread,r.seq,r.id,r.kind,r.at,r.sender,r.hash];
    if(p.old&&(JSON.stringify(stable(old))!==JSON.stringify(stable(p.old))||!old.words?.equals(p.old.words!)))return deny();
    return {thread:i.thread,seq:old.seq};
   }
   if(JSON.stringify(current.a)!==JSON.stringify(p.before.a))return deny();
   const answer=o.attention.privateDecision!(ctx,{id:i.ref,conversation:current.t.conversation,agent:current.t.agent,member:current.t.member,thread:i.thread,seq:current.row.seq,verdict:i.verdict});
   if(!answer.ok)throw new OperationError(answer.code,answer.message);
   // Throwing on append failure rolls back Attention and the enclosing operation receipt too.
   const row=append(o.db,current.t,{id:`answer:${i.ref}`,kind:'message',at:ctx.now,sender:current.t.member,words:p.words!,hash:hash(i),record:JSON.stringify({delivery:'sending',attempted:false})});
   ctx.changed('thread',i.thread);ctx.changed('message',`${i.thread}/${row.seq}`);
   return {thread:i.thread,seq:row.seq};
  },
 };
}
