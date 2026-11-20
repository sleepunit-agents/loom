import type { Db } from '../../core/index.js';
import { log } from './domain.js';
import { load, persist } from './store.js';
import { type Caller, maySpend, samePrincipal, pieceSpent, stateOf } from './model.js';
import { exactTarget, covered } from './targets.js';

/** Runs only from the registry's post-rollback audit hook. No receipt changes. */
export function auditRefusedUse(db: Db, input: Record<string,unknown>, caller: Caller, now: number, piece = false) {
  if (!piece && pieceSpent.has(String(input.kind))) return;
  try { exactTarget(String(input.target)); } catch { return; }
  const state = load(db), approval = state.approvals.find(a => a.id === input.id);
  if (!approval) return;
  let extra: Record<string,unknown> | undefined;
  if (!maySpend(approval.who,caller.who)) extra = {who_used:caller.who};
  else if (stateOf(approval,now) === 'allowed') {
    if (approval.kind !== input.kind || approval.target !== input.target) extra = {kind_used:input.kind,target_used:input.target};
    else if (!(piece && approval.kind === 'grant') && !samePrincipal(approval,caller)) extra = {for_used:caller.for};
    else {
      const denial = state.approvals.find(a => a.id !== approval.id && a.kind === approval.kind && a.state === 'denied'
        && a.who.agent === approval.who.agent && (a.decided ?? '') > (approval.decided ?? '')
        && (a.target === approval.target || covered(a).some(id => covered(approval).includes(id))));
      if (denial) extra = {denied_by:denial.id};
    }
  }
  if (!extra) return;
  log(state,'refused-use',approval,now,extra);
  persist(db,state,now);
}
