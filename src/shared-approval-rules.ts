/** Owner-only rule editing; agents and ordinary readable members cannot grant. */
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { type Operations, OperationError } from './core/operations/index.js';
import { approvalRuleInput, approvalRuleKind, type approvalRulesService } from './apps/approval-rules.js';
import { workAnswersAllowed } from './shared-work-access.js';
export function registerSharedApprovalRules(operations:Operations,db:DataDatabase,service:ReturnType<typeof approvalRulesService>){
  operations.register({name:'approvals.setRule',write:true,recheckPolicy:true,input:approvalRuleInput,
    output:z.object({kind:approvalRuleKind,scope:z.string(),person:z.string()}).strict(),
    may:viewer=>workAnswersAllowed(db,viewer),
    run(ctx,input){
      if(ctx.viewer.kind!=='member')throw new OperationError('denied','A household owner is required');
      const key=service.set(input,ctx.viewer.id);ctx.changed('approval_rules',JSON.stringify(key));return key;
    },
  });
}
