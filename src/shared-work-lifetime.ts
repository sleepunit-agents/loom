/** A single timer makes unused allowances expire even without a command or
 * GitHub read. Owned by the shared root; every write uses the shared publisher. */
import {and,eq} from 'drizzle-orm';
import type {Clock} from './core/clock.js';
import type {DataDatabase} from './core/data/database.js';
import type {DataWrites} from './core/data/writes.js';
import {approvals,changes} from './core/data/schema.js';
import {lastApprovalAnswer} from './apps/approval-answer.js';
export function workLifetime(db:DataDatabase,clock:Clock,writes:DataWrites,reportError:(error:unknown)=>void){
 let closed=false,cancel:(()=>void)|undefined;
 const report=()=>{try{reportError(new Error('Approval expiry unavailable'));}catch{}};
 const expire=()=>{
  const result=writes.run(()=>{
   const rows=db.select().from(approvals).where(eq(approvals.state,'allowed')).all();
   for(const card of rows){
    if(!card.expiresAt||Date.parse(card.expiresAt)>clock.now())continue;
    db.update(approvals).set({state:'expired'}).where(eq(approvals.id,card.id)).run();
    const latest=lastApprovalAnswer(db,card.agent,card.kind,card.target);
    if(card.kind!=='merge'||latest?.approval!==card.id)continue;
    const match=/^(github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9][0-9]*)@([a-f0-9]{40})$/.exec(card.target);
    const change=match&&db.select().from(changes).where(eq(changes.id,match[1])).get();
    if(change&&change.headCommit===match![2]&&change.agent===card.agent&&change.project===card.project&&change.state==='open'&&change.waitingOn==='agent')
     db.update(changes).set({waitingOn:'you'}).where(and(eq(changes.id,change.id),eq(changes.waitingOn,'agent'))).run();
   }
  });
  for(const _error of result.notificationErrors)report();
 };
 const schedule=()=>{
  cancel?.();cancel=undefined;if(closed)return;
  const times=db.select({at:approvals.expiresAt}).from(approvals).where(eq(approvals.state,'allowed')).all().map(row=>Date.parse(row.at??'')).filter(Number.isFinite);
  if(!times.length)return;
  cancel=clock.at(Math.max(clock.now(),Math.min(...times)),()=>{
   cancel=undefined;if(closed)return;
   try{expire();schedule();}catch{report();if(!closed)cancel=clock.at(clock.now()+60000,schedule);}
  });
 };
 expire();const stop=writes.observe(schedule);schedule();
 return {close(){if(closed)return;closed=true;stop();cancel?.();cancel=undefined;}};
}
