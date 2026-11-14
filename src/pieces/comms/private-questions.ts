/** In-process source capability. Never enters generic operation input/receipt storage. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OperationError, mayUseThread } from '../../core/index.js';
import type { Options } from './index.js';
import type { Comms } from './role.js';
import { append, thread, type Thread } from './store.js';
const id=z.string().min(1).max(200);
const line=z.string().min(1).max(4000);
const input=z.object({id,question:z.object({ask:line,why:line.optional(),if_yes:line.optional(),if_no:line.optional(),
 href:z.string().max(2000).optional(),refs:z.array(id).max(100).optional(),answers:z.enum(['yes-no','words']).optional()}).strict()}).strict();
export function privateQuestionCreator(o:Options & {closed():boolean; changed(t:Thread,seq:number,ref:string):void}):Comms['ask'] {
 return async(agent,place,raw)=>{
  const parsed=input.parse(raw);
  const available=()=>{
   const t=thread(o.db,place);
   if(o.closed()||!t||t.agent!==agent||!mayUseThread({kind:'member',id:t.member},t,o.sharing()))throw new OperationError('denied','Thread unavailable');
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
   const projection=o.attention.privateQuestion!({db:o.db,viewer:{kind:'member',id:t.member},now:o.clock.now(),changed:()=>{}},
    {id:ref,conversation:t.conversation,agent:t.agent,member:t.member,thread:t.id,seq:result.seq,...(t.project?{project:t.project}:{}),answers:parsed.question.answers??'words'});
   if(!projection.ok)throw new OperationError(projection.code,projection.message);
   return {ref,seq:result.seq};
  })();
  o.changed(available(),result.seq,result.ref);return result;
 };
}
