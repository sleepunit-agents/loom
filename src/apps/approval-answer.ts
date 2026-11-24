import {shellCommandRecord} from './shell-command-record.js';
import {and,desc,eq,inArray,exists,notExists} from 'drizzle-orm';
import type {DataDatabase} from '../core/data/database.js';
import {approvals,approvalRecord} from '../core/data/schema.js';
import type {Approval} from './approvals.js';
/** The request event is written by the service. A named target can contain any text,
 * including the digest used by a different shell card. */
export function sameCommandForm(db: DataDatabase, literal: boolean) {
 const request = db.select({seq:approvalRecord.seq}).from(approvalRecord)
   .where(and(eq(approvalRecord.approval,approvals.id),eq(approvalRecord.event,'request'),eq(approvalRecord.note,shellCommandRecord)));
 return literal ? exists(request) : notExists(request);
}
/** A later explicit No dominates a standing answer until a later owner Allow supersedes it. */
export function lastApprovalAnswer(db:DataDatabase,agent:string,kind:Approval['kind'],target:string,literalShell=false){
 return db.select({event:approvalRecord.event,approval:approvalRecord.approval}).from(approvalRecord)
  .innerJoin(approvals,eq(approvals.id,approvalRecord.approval))
  .where(and(eq(approvals.agent,agent),eq(approvals.kind,kind),eq(approvals.target,target),kind==='command'?sameCommandForm(db,literalShell):undefined,inArray(approvalRecord.event,['allow','deny'])))
  .orderBy(desc(approvalRecord.seq)).limit(1).get();
}
