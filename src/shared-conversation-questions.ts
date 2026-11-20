/** Outside question targets and reads. Trusted producers/settlement stay free
 * of caller policy; no body inherits a member's general registry identity. */
import {getTableColumns,sql,eq,and,type AnyColumn,type SQL} from 'drizzle-orm';
import {addressee,mayBeAskedAbout,rules,type Viewer} from './policy.js';
import {sqlRule} from './policy-sql.js';
import {canReadSharedConversation,sharedSharing} from './shared-sharing.js';
import type {DataDatabase} from './core/data/database.js';
import {tasks,approvals,inbox} from './core/data/schema.js';
import {taskVisibility} from './core/data/visibility.js';
import {workVisibility} from './core/data/work-visibility.js';
import {talkVisibility} from './core/data/conversation-visibility.js';
import type {BodyQuestionAuthority} from './core/conversations/body-operations.js';
type Fields=Record<string,AnyColumn>;
type Kind='task'|'approval';
export function conversationQuestionPolicy(db:DataDatabase){
 const visibleSource=(viewer:Viewer,kind:Kind,id:AnyColumn|string):SQL=>{
  const table=kind==='task'?tasks:approvals;
  const allowed=kind==='task'?taskVisibility(viewer).tasks!(getTableColumns(tasks)):workVisibility(viewer).approvals!(getTableColumns(approvals));
  return sql`exists(select 1 from ${table} where ${table.id}=${id} and ${allowed})`;
 };
 const canRead=(viewer:Viewer,kind:Kind,id:string)=>db.get<{allowed:number}>(sql`select ${visibleSource(viewer,kind,id)} as allowed`)?.allowed===1;
 // The record an item waits on must be readable too. That is part of the inbox rule (policy.ts,
 // waitsOnReadable); it is asked alone where a door has settled who the item is for by another rule.
 const sourceVisibility=(viewer:Viewer,f:Fields)=>sqlRule(rules.waitsOnReadable,viewer,f);
 const visibility=(viewer:Viewer,f:Fields)=>talkVisibility(viewer).inbox(f);
 const ask:BodyQuestionAuthority=(viewer,cv,q)=>{
  // Could the person asked read this conversation, and the record the question waits on? Somebody who is
  // not in the household now reads nothing. This never acts as that member (policy.ts, addressee).
  const to=addressee(q.to);
  if(!canReadSharedConversation(db,to,cv.id))return false;
  if(!q.waitsOnKind&&!q.waitsOnId)return true;
  if(!q.waitsOnKind||!q.waitsOnId)return false;
  // A question about a task goes only to someone who could read the task: the one rule a task's own
  // question and a move are held to (policy.ts, mayBeAskedAbout). An approval card has its own read rule.
  if(q.waitsOnKind==='task'){const asked=db.select().from(tasks).where(eq(tasks.id,q.waitsOnId)).get();if(!asked||!mayBeAskedAbout(q.to,asked,sharedSharing(db)))return false;}
  else if(!canRead(to,q.waitsOnKind,q.waitsOnId))return false;
  if(canRead(viewer,q.waitsOnKind,q.waitsOnId))return true;
  // The body's own token does not read the record. A private current body may still link a record of its
  // own context: one raised in this very conversation. Whether the member may read it was decided above,
  // by the record's own rule; nothing about that rule is repeated here. It may not link another private
  // conversation's record or anything else from the member's registry.
  if(!cv.member||q.to!==cv.member)return false;
  if(q.waitsOnKind==='approval'){
   const row=db.select().from(approvals).where(eq(approvals.id,q.waitsOnId)).get();
   return !!row&&row.conversation===cv.id&&row.agent===cv.agent&&row.member===cv.member&&row.project===cv.project;
  }
  const row=db.select().from(tasks).where(eq(tasks.id,q.waitsOnId)).get();
  return !!row&&row.sourceKind==='conversation'&&row.sourceId===cv.id;
 };
 // Additional source constraint only; callers still establish recipient authority.
 const sourceAllowsItem=(viewer:Viewer,id:string)=>!!db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.id,id),sourceVisibility(viewer,getTableColumns(inbox)))).get();
 return {visibility,ask,sourceAllowsItem,sourceVisibility};
}
