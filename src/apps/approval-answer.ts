/** Trusted answer history. A later explicit No must dominate a standing answer
 * for the same agent/kind/exact target until a later owner Allow supersedes it. */
import {and,desc,eq,inArray} from 'drizzle-orm';
import type {DataDatabase} from '../core/data/database.js';
import {approvals,approvalRecord} from '../core/data/schema.js';
import type {Approval} from './approvals.js';
export function lastApprovalAnswer(db:DataDatabase,agent:string,kind:Approval['kind'],target:string){
 return db.select({event:approvalRecord.event,approval:approvalRecord.approval}).from(approvalRecord)
  .innerJoin(approvals,eq(approvals.id,approvalRecord.approval))
  .where(and(eq(approvals.agent,agent),eq(approvals.kind,kind),eq(approvals.target,target),inArray(approvalRecord.event,['allow','deny'])))
  .orderBy(desc(approvalRecord.seq)).limit(1).get();
}
