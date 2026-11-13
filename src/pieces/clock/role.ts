/** Clock owns the desk's schedule readings; consumers retain the original viewer. */
import type { Operations, Result, Viewer } from '../../core/index.js';
export type { AgentNext, ClockJob } from './desk.js';
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
