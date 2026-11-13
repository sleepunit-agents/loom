import { z } from 'zod';
import type { Operations } from '../../core/index.js';
import { ownerApprovalsRole } from '../approvals/role.js';
import type { Approvals } from './roles.js';

const rule = z.object({
 tier:z.enum(['do','tell','ask']),
 approval:z.object({state:z.string()}).optional(),
 asked_for:z.array(z.object({for:z.string(),name:z.string(),state:z.string()})).optional(),
});
/** The real owner-facing Approvals seam; permissions remain in its operations. */
export function changesApprovals(operations:Operations):Approvals {
 const approvals=ownerApprovalsRole(operations);
 return {
  rule(viewer,agent,target) {
   const result=approvals.rule(viewer,agent,target);
   if(!result.ok) return;
   const parsed=z.record(z.string(),rule).safeParse(result.value);
   if(!parsed.success) return;
   const row=parsed.data[target];
   if(!row) return;
   const person=row.asked_for?.find(p=>p.state==='pending')??row.asked_for?.find(p=>p.state==='allowed');
   return {tier:row.tier,...(row.approval?{approval:row.approval}:{}),...(person?{for:{slug:person.for,name:person.name,state:person.state}}:{})};
  },
  answer(viewer,input,id) {
   if(input.alwaysProject) {
    const result=approvals.projectRule(viewer,input.alwaysProject,`${id}:rule`);
    if(!result.ok) return result;
   }
   return approvals.grant(viewer,input,`${id}:grant`);
  },
 };
}
