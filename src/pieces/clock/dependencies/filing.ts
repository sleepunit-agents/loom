import { randomUUID } from 'node:crypto';
import type { Operations, Result } from '../../../core/index.js';
import { approvalsRole } from '../../approvals/role.js';
/** Trusted owning composition. Requests confer no authority; Allow applies via Clock. */
export interface VouchFiling { request(agent: string, target: string, details: string): Result; group?(agent: string, candidates: {id:string; automatic:boolean; details:string}[]): Result }
export function clockVouchFiling(operations: Operations): VouchFiling {
  const role = approvalsRole(operations, 'approvals');
  return { group(agent, candidates) {
    return operations.call('direct', {kind:'service',id:'approvals'}, 'approvals.piece-group-vouch', {
      caller:{who:{agent,where:"loom's clock"},for:'owner'}, candidates,
    }, randomUUID());
  }, request(agent, target, details) {
    return role.call('request', { who: { agent, where: "loom's clock" }, for: 'owner' }, {
      kind: 'vouch-wake', target, details,
      ask: 'Count these scheduled jobs as your work?',
      why: 'These imported jobs have no verified owner and remain held.',
      if_yes: 'Eligible jobs become your work with their saved words and due times.',
      if_no: 'The jobs remain held and are not asked about again.',
    }, randomUUID());
  } };
}
