/** Clock owns the desk's schedule readings; consumers retain the original viewer. */
import type { Operations, Result, Viewer } from '../../core/index.js';
export type { AgentNext, ClockJob } from './desk.js';
export type { Runtime, StartResult } from './dependencies/runtime.js';
export interface Clock {
  agentNext(viewer: Viewer, input: { agent: string }): Result;
  jobs(viewer: Viewer, input: { agent: string }): Result;
}
export function clockRole(operations: Pick<Operations, 'call'>): Clock {
  return {
    agentNext: (viewer, input) => operations.call('direct', viewer, 'clock.agentNext', input),
    jobs: (viewer, input) => operations.call('direct', viewer, 'clock.jobs', input),
  };
}

/** Trusted composition role, called only by Approvals during its owner-answer
 * transaction on this same foundation. Approvals owns validation and spending
 * the receipt; Clock rechecks current owner and target policy and adopts rows.
 */
export function clockVouchApplication(operations: Pick<Operations, 'call'>): import('../approvals/role.js').ApprovalApplication {
  return { apply(approval, by) {
    if (approval.kind !== 'vouch-wake' || approval.state !== 'allowed' || approval.by !== by)
      return { ok: false, code: 'invalid', message: 'Expected the current owner Allow for wake vouching' };
    return operations.call('direct', { kind: 'member', id: by }, 'clock.vouch', { target: approval.target }, `clock-vouch:${approval.id}`);
  } };
}
