/** Ordinary activity contains labels only; never retain arbitrary private envelope fields. */
export interface ConversationStep {
 seq:number;conversation:string;at:number;keepUntil:number;text:string|null;
 run?:string;id?:string;tool?:string;state?:'running'|'done'|'failed';
}
export function retainedStep(step:ConversationStep,now:number):ConversationStep {
 const routing={seq:step.seq,conversation:step.conversation,at:step.at,keepUntil:step.keepUntil,text:null};
 if(!Number.isFinite(step.keepUntil)||step.keepUntil<=now||step.text===null)return routing;
 return {...routing,text:step.text,run:step.run,id:step.id,tool:step.tool,state:step.state};
}
export class ConversationPages {
 private generation=0;
 rows:ConversationStep[]=[];
 begin(){return this.generation;}
 clear(){this.generation++;this.rows=[];}
 accept(generation:number,rows:ConversationStep[],now:number){
  if(generation!==this.generation)return false;
  const merged=new Map(this.rows.map(row=>[row.seq,row]));
  for(const row of rows)merged.set(row.seq,retainedStep(row,now));
  this.rows=[...merged.values()].sort((a,b)=>a.seq-b.seq);this.expire(now);return true;
 }
 expire(now:number){this.rows=this.rows.map(row=>retainedStep(row,now));}
}
