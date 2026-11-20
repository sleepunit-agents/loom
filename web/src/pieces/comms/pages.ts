import type { Message } from './message';

/** A page may outlive its subscription. Keep only routing facts at its server deadline. */
export function retainedMessage(message:Message,now:number):Message {
 if(typeof message.keepUntil==='number'&&Number.isFinite(message.keepUntil)&&message.keepUntil>now)return message;
 return {id:message.id,thread:message.thread,seq:message.seq,at:message.at,kind:message.kind,from:message.from,text:null};
}
export class EarlierPages {
 private generation=0;
 rows:Message[]=[];
 begin(){return this.generation;}
 clear(){this.generation++;this.rows=[];}
 accept(generation:number,rows:Message[],now:number){
  if(generation!==this.generation)return false;
  const merged=new Map(this.rows.map(m=>[m.id,m]));
  for(const row of rows)merged.set(row.id,retainedMessage(row,now));
  this.rows=[...merged.values()].sort((a,b)=>a.seq-b.seq);this.expire(now);return true;
 }
 expire(now:number){this.rows=this.rows.map(m=>retainedMessage(m,now));}
}
