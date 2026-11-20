import {randomUUID} from 'node:crypto';
import {and,desc,eq,sql} from 'drizzle-orm';
import {Conversations,lateMailWaits} from './core/conversations/index.js';
import type {DataDatabase} from './core/data/database.js';
import {boxes,inbox} from './core/data/schema.js';
import {kitReasons,type KitUnavailable} from './runtime/kit-availability.js';
import {householdOwners} from './shared-sharing.js';

export function recordKitAvailability(db:DataDatabase,now:()=>string,job:{agent:string;box:string|null},
  unavailable:KitUnavailable[],offered:readonly string[]) {
  const mail=new Conversations(db,now,lateMailWaits);
  const prefix=(kit:string)=>`kit-unavailable:${JSON.stringify([job.agent,job.box,kit])}:`;
  for(const kit of offered){
    const rows=db.selectDistinct({sourceId:inbox.sourceId}).from(inbox)
      .where(and(eq(inbox.source,'notice'),eq(inbox.state,'waiting'),sql`instr(${inbox.sourceId},${prefix(kit)})=1`)).all();
    for(const {sourceId} of rows) if(sourceId) mail.resolveSource('notice',sourceId,'A later job was offered the kit');
  }
  if(!unavailable.length)return;
  const box=job.box && db.select({name:boxes.name}).from(boxes).where(eq(boxes.id,job.box)).get()?.name;
  const agent=job.agent[0].toUpperCase()+job.agent.slice(1);
  for(const {kit,reason} of unavailable){
    const key=prefix(kit)+reason+':';
    const {why,fix}=kitReasons[reason];
    for(const to of householdOwners(db)){
      const last=db.select({state:inbox.state}).from(inbox)
        .where(and(eq(inbox.source,'notice'),eq(inbox.toKind,'person'),eq(inbox.to,to),sql`instr(${inbox.sourceId},${key})=1`))
        .orderBy(desc(sql`rowid`)).get();
      if(last && last.state!=='resolved')continue;
      mail.send({toKind:'person',to,member:to,source:'notice',sourceId:key+randomUUID(),fromKind:'unknown',
        words:`${agent}'s ${kit} kit had unavailable tools on the machine ${box || job.box}: ${why}. ${fix}`});
    }
  }
}
