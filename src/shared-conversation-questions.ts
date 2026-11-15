/** Outside question targets and reads. Trusted producers/settlement stay free
 * of caller policy; no body inherits a member's general registry identity. */
import {getTableColumns,sql,eq,and,type AnyColumn,type SQL} from 'drizzle-orm';
import type {Viewer} from './policy.js';
import {maySee} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import type {DataDatabase} from './core/data/database.js';
import {tasks,approvals,members,inbox,secretRequests} from './core/data/schema.js';
import {bridgeSecretsVisibility} from './core/data/bridge-secrets-visibility.js';
import {taskVisibility} from './core/data/visibility.js';
import {workVisibility} from './core/data/work-visibility.js';
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
 const sourceVisibility=(viewer:Viewer,f:Fields)=>sql`(
  (${f.waitsOnKind} is null and ${f.waitsOnId} is null)
  or (${f.waitsOnKind}='task' and ${visibleSource(viewer,'task',f.waitsOnId)})
  or (${f.waitsOnKind}='approval' and ${visibleSource(viewer,'approval',f.waitsOnId)})
  or (${f.waitsOnKind}='secret-request' and exists(select 1 from ${secretRequests}
    where ${secretRequests.id}=${f.waitsOnId} and ${bridgeSecretsVisibility(viewer).secretRequests!(getTableColumns(secretRequests))}))
 )`;
 const visibility=(viewer:Viewer,f:Fields)=>sql`(${workVisibility(viewer).approvals!(f)}) and ${sourceVisibility(viewer,f)}`;
 const ask:BodyQuestionAuthority=(viewer,cv,q)=>{
  const recipient=db.select().from(members).where(eq(members.id,q.to)).get();
  // This checks the destination's visibility; it never acts as that member.
  if(!recipient||!maySee({kind:'member',id:recipient.id},{type:'conversation',agent:cv.agent,member:cv.member??undefined,project:cv.project??undefined},sharedSharing(db)))return false;
  if(!q.waitsOnKind&&!q.waitsOnId)return true;
  if(!q.waitsOnKind||!q.waitsOnId||!canRead({kind:'member',id:recipient.id},q.waitsOnKind,q.waitsOnId))return false;
  if(canRead(viewer,q.waitsOnKind,q.waitsOnId))return true;
  // A private current body may link its own context's source record, not
  // another private conversation or the member's whole task/approval registry.
  if(!cv.member||recipient.id!==cv.member)return false;
  if(q.waitsOnKind==='approval'){
   const row=db.select().from(approvals).where(eq(approvals.id,q.waitsOnId)).get();
   return !!row&&row.conversation===cv.id&&row.agent===cv.agent&&row.member===cv.member&&row.project===cv.project;
  }
  const row=db.select().from(tasks).where(eq(tasks.id,q.waitsOnId)).get();
  return !!row&&row.sourceKind==='conversation'&&row.sourceId===cv.id&&(!row.project||row.project===cv.project)&&(
   row.ownerKind==='member'&&row.owner===cv.member||row.ownerKind==='agent'&&row.owner===cv.agent||row.ownerKind==='household'&&recipient.role==='owner');
 };
 // Additional source constraint only; callers still establish recipient authority.
 const sourceAllowsItem=(viewer:Viewer,id:string)=>!!db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.id,id),sourceVisibility(viewer,getTableColumns(inbox)))).get();
 return {visibility,ask,sourceAllowsItem};
}
