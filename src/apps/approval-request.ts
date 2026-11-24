/** Trusted request composition shared by installed callers and the body door.
 * Callers supply authenticated context; this service never executes a command
 * or merge. Prepared settings/dangerous changes require explicit Allow. */
import {parseMergeTarget} from './merge-target.js';
import {eq} from 'drizzle-orm';
import type {DataDatabase} from '../core/data/database.js';
import {changes} from '../core/data/schema.js';
import type {approvalService,ApprovalRequest} from './approvals.js';
import type {approvalRulesService} from './approval-rules.js';
import {lastApprovalAnswer} from './approval-answer.js';
import {changeAnswers} from './changes-answers.js';
import {readsRepository} from './changes.js';
export type RuleApprovalRequest=Omit<ApprovalRequest,'kind'|'operation'>&{kind:'merge'|'command';operation?:null};
export function requestApprovalWithRules(db:DataDatabase,service:ReturnType<typeof approvalService>,rules:ReturnType<typeof approvalRulesService>,input:RuleApprovalRequest,literalShell=false){
 if(!['merge','command'].includes(input.kind)||input.operation)throw new Error('Prepared changes require explicit Allow');
 return db.transaction(()=>{
  const row=service.request(input,undefined,literalShell);
  // Existing standing rules grant named operations. They never granted arbitrary shell text.
  if(literalShell)return row;
  const rule=lastApprovalAnswer(db,row.agent,row.kind,row.target)?.event==='deny'?undefined:rules.resolve({kind:row.kind,target:row.target,project:row.project,actingFor:row.actingFor});
  if(rule&&rule.tier!=='ask'){
   const owner={kind:'member' as const,id:rule.setBy};
   const target=row.kind==='merge'?parseMergeTarget(row.target):undefined;
   const change=target?db.select().from(changes).where(eq(changes.id,target.change)).get():undefined;
   // A repository loom reads has its change here, or the card is stale. One it does not read has none to find.
   if(row.kind==='merge'&&!change&&(!target||readsRepository(db,target.repository)))throw new Error('Merge change is unavailable');
   {
    const basis=`Standing ${rule.tier} rule ${rule.scope} for ${rule.person||'household owner'}, set by ${rule.setBy}`;
    if(change&&target)changeAnswers(db,service).answer({change:change.id,head:target.head,approval:row.id,member:rule.setBy,allow:true,basis});
    else service.allow(row.id,rule.setBy,basis);
   }
  }
  return service.get(row.id);
 });
}
