import { aliveOf, took, type WorkCard } from '../../steps';
import { messageView, type Message } from './message';

export interface WorkingThread {agent:string;working:boolean;workingSince?:number|null;alive?:{at:number;tokens?:number}}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Only authorized, retained cards from this working spell contribute. No heartbeat is body movement. */
export function workingView(thread:WorkingThread,messages:Message[],now:number,connected:boolean){
 if(!connected||!thread.working)return null;
 const cards:WorkCard[]=messages.filter(m=>m.kind==='card'&&m.text!==null).map(m=>{
  const view=messageView(m),meta=object(m.card),step=object(view.step);
  return {id:m.id,seq:m.seq,at:new Date(m.at).toISOString(),text:view.text,
   card:{...meta,...step,tool:view.tool,state:view.state}};
 });
 const alive=aliveOf({working_since:typeof thread.workingSince==='number'?new Date(thread.workingSince).toISOString():null,
  ...(thread.alive?{alive_at:new Date(thread.alive.at).toISOString(),tokens:thread.alive.tokens}:{})},cards,now);
 const on=alive.step?.text;
 const detail=alive.face==='working'?`${thread.agent} is working`
  :`${alive.over?`${on??'A step'} has run ${took(alive.running)}, past its limit`:`Quiet for ${took(alive.quiet)}`} — ${alive.face==='stuck'?'it may be stuck':`${thread.agent} is still running`}`;
 return {face:alive.face,text:detail+(on&&!alive.over?` · on ${on} for ${took(alive.running)}`:'')};
}
