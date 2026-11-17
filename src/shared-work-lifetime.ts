/** A single timer makes unused allowances expire even without a command or
 * GitHub read. Owned by the shared root; every write uses the shared publisher. */
import {parseMergeTarget} from './apps/merge-target.js';
import {and,eq,inArray} from 'drizzle-orm';
import type {Clock} from './core/clock.js';
import type {DataDatabase} from './core/data/database.js';
import type {DataWrites} from './core/data/writes.js';
import {approvals,changes} from './core/data/schema.js';
import {lastApprovalAnswer} from './apps/approval-answer.js';
export function workLifetime(db:DataDatabase,clock:Clock,writes:DataWrites,reportError:(error:unknown)=>void){
 let closed=false,cancel:(()=>void)|undefined;
 const report=()=>{try{reportError(new Error('Approval expiry unavailable'));}catch{}};
 const repairable=(card:typeof approvals.$inferSelect)=>{
  if(card.kind!=='merge'||lastApprovalAnswer(db,card.agent,card.kind,card.target)?.approval!==card.id)return;
  const target=parseMergeTarget(card.target);
  const change=target&&db.select().from(changes).where(eq(changes.id,target.change)).get();
  return change&&change.headCommit===target!.head&&change.agent===card.agent&&change.project===card.project&&change.state==='open'&&change.waitingOn==='agent'?change:undefined;
 };
 const rows=()=>db.select().from(approvals).where(inArray(approvals.state,['allowed','expired'])).all();
 const expire=()=>{
  const result=writes.run(()=>{
   for(const card of rows()){
    if(card.state==='allowed'){
     if(!card.expiresAt||Date.parse(card.expiresAt)>clock.now())continue;
     db.update(approvals).set({state:'expired'}).where(eq(approvals.id,card.id)).run();
    }
    const change=repairable(card);
    if(change)db.update(changes).set({waitingOn:'you'}).where(and(eq(changes.id,change.id),eq(changes.waitingOn,'agent'))).run();
   }
  });
  for(const _error of result.notificationErrors)report();
 };
 const schedule=()=>{
  cancel?.();cancel=undefined;if(closed)return;
  let next=Infinity;
  for(const card of rows()){
   if(card.state==='expired'){if(repairable(card))next=clock.now();}
   else{const time=Date.parse(card.expiresAt??'');if(Number.isFinite(time))next=Math.min(next,time);}
  }
  if(!Number.isFinite(next))return;
  cancel=clock.at(Math.max(clock.now(),next),()=>{
   cancel=undefined;if(closed)return;
   try{expire();schedule();}catch{report();if(!closed)cancel=clock.at(clock.now()+60000,schedule);}
  });
 };
 expire();const stop=writes.observe(schedule);schedule();
 return {close(){if(closed)return;closed=true;stop();cancel?.();cancel=undefined;}};
}
