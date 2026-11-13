/** Normalize authorized decrypted records; expired records never expose nested private fields. */
export interface Message {id:string;thread:string;seq:number;at:number;kind:string;from:string;text:string|null;delivery?:string;[key:string]:unknown}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const words=(value:unknown)=>typeof value==='string'?value:undefined;
export function messageView(message:Message){
 const ask=object(message.ask),card=object(message.card),answer=object(message.answer);
 // Imported asks have null text even while their encrypted ask payload is retained.
 const retained=message.text!==null||typeof ask.ask==='string'||typeof ask.text==='string';
 if(!retained)return {text:null,tool:undefined,state:undefined,step:undefined,ask:undefined,nextRetry:undefined};
 const question=words(ask.ask)??words(ask.text)??(message.kind==='ask'?message.text??undefined:undefined);
 const verdict=words(answer.verdict);
 const notice=message.step===undefined?card:object(message.step);
 const retry=message.kind==='error'&&notice.error==='start-retry'&&!notice.settled?words(notice.retry_at):undefined;
 const nextRetry=retry&&Number.isFinite(Date.parse(retry))?new Date(retry).toISOString():undefined;
 return {text:message.text,nextRetry,tool:words(message.tool)??words(card.tool),state:words(message.state)??words(card.state),step:message.step??card.step,
  ask:message.kind==='ask'?{question:question??'Your answer is needed',why:words(ask.why),yes:words(ask.if_yes),no:words(ask.if_no),
   answer:verdict,answered:Object.keys(answer).length>0,canAnswer:Object.keys(answer).length===0&&ask.answers!=='words'&&typeof message.ref==='string'}:undefined};
}
