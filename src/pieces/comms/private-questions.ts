/** In-process source capability. Never enters generic operation input/receipt storage. */
import { createHash } from 'node:crypto';
import { OperationError, mayUseThread, mayCreate } from '../../core/index.js';
import type { Options } from './index.js';
import { privateQuestionInput, type Comms } from './role.js';
import { append, thread, type Thread } from './store.js';
export function privateQuestionCreator(o:Options & {closed():boolean; changed(t:Thread,seq:number,ref:string):void}):Comms['ask'] {
 return async(agent,place,raw,binding)=>{
  const parsed=privateQuestionInput.parse(raw);
  const available=()=>{
   const t=thread(o.db,place);
   if(o.closed()||!t||t.agent!==agent||!mayUseThread({kind:'member',id:t.member},t,o.sharing()))throw new OperationError('denied','Thread unavailable');
   if(!mayCreate({kind:'member',id:t.member},{type:'attention.ask',member:t.member,agent:t.agent,project:t.project},o.sharing(),'attention.raise'))throw new OperationError('denied','Ask unavailable');
   if(binding&&(binding.agent!==agent||binding.conversation!==t.conversation||!binding.valid()))throw new OperationError('denied','Body binding ended');
   if(t.archived!==null)throw new OperationError('conflict','Thread archived');
   if(!o.attention.privateQuestion)throw new OperationError('unavailable','Private question source unavailable');
   return t;
  };
  const before=available();
  // Namespace includes the owning thread; caller ids cannot impersonate another source.
  const ref=`comms:${createHash('sha256').update(JSON.stringify([place,parsed.id])).digest('hex')}`;
  const hash=o.key.hash(JSON.stringify(parsed));
  const words=await o.key.seal(JSON.stringify(parsed.question));
  const result=o.db.transaction(()=>{
   const t=available();
   if(t.member!==before.member||t.conversation!==before.conversation||t.project!==before.project)throw new OperationError('denied','Thread unavailable');
   let result;try{result=append(o.db,t,{id:ref,kind:'ask',at:o.clock.now(),sender:agent,words,hash,record:JSON.stringify({encoding:'ask',ref})});}
   catch{throw new OperationError('conflict','Question id already used');}
   // Message and projection were first committed atomically. A retry preserves
   // that original projection and answer, including its immutable source scope;
   // later authorized thread filing is not a new question identity.
   if(result.repeat)return {ref,seq:result.seq};
   const projection=o.attention.privateQuestion!({db:o.db,viewer:{kind:'member',id:t.member},now:o.clock.now(),changed:()=>{}},
    {id:ref,conversation:t.conversation,agent:t.agent,member:t.member,thread:t.id,seq:result.seq,...(t.project?{project:t.project}:{}),answers:parsed.question.answers??'words'});
   if(!projection.ok)throw new OperationError(projection.code,projection.message);
   return {ref,seq:result.seq};
  })();
  o.changed(available(),result.seq,result.ref);return result;
 };
}
