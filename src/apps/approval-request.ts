/** Trusted request composition shared by installed callers and the body door.
 * Callers supply authenticated context; this service never executes a command
 * or merge. Prepared settings/dangerous changes require explicit Allow. */
import {eq} from 'drizzle-orm';
import type {DataDatabase} from '../core/data/database.js';
import {changes} from '../core/data/schema.js';
import type {approvalService,ApprovalRequest} from './approvals.js';
import type {approvalRulesService} from './approval-rules.js';
import type {WorkAnswerAuthority} from '../shared-work-commands.js';
import {lastApprovalAnswer} from './approval-answer.js';
import {changeAnswers} from './changes-answers.js';
export type RuleApprovalRequest=Omit<ApprovalRequest,'kind'|'operation'>&{kind:'merge'|'command';operation?:null};
export function requestApprovalWithRules(db:DataDatabase,service:ReturnType<typeof approvalService>,rules:ReturnType<typeof approvalRulesService>,input:RuleApprovalRequest,authority?:WorkAnswerAuthority){
 if(!['merge','command'].includes(input.kind)||input.operation)throw new Error('Prepared changes require explicit Allow');
 return db.transaction(()=>{
  const row=service.request(input);
  const rule=lastApprovalAnswer(db,row.agent,row.kind,row.target)?.event==='deny'?undefined:rules.resolve({kind:row.kind,target:row.target,project:row.project,actingFor:row.actingFor});
  if(rule&&rule.tier!=='ask'){
   const owner={kind:'member' as const,id:rule.setBy};
   const match=row.kind==='merge'?/^(github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9][0-9]*)@([a-f0-9]{40})$/.exec(row.target):null;
   const change=match?db.select().from(changes).where(eq(changes.id,match[1])).get():undefined;
   if(row.kind==='merge'&&!change)throw new Error('Merge change is unavailable');
   if((!authority||authority.approval(owner,row)===true)&&(!change||!authority||authority.change(owner,change,row)===true)){
    const basis=`Standing ${rule.tier} rule ${rule.scope} for ${rule.person||'household owner'}, set by ${rule.setBy}`;
    if(change&&match)changeAnswers(db,service).answer({change:change.id,head:match[2],approval:row.id,member:rule.setBy,allow:true,basis});
    else service.allow(row.id,rule.setBy,basis);
   }
  }
  return service.get(row.id);
 });
}
