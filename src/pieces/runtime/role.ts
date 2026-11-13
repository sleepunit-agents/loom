/** Runtime's seam for Clock, Comms and venue adapters. No runner or store imports. */
import type { Operations, Result, Scope, Viewer } from '../../core/index.js';
import { attentionRole, type AgentStatus } from '../attention/role.js';

/** Stable source ids let callers retry a scheduled wake or incoming message. */
export interface StartBody extends Scope {
  agent: string;
  brief: string;
  title: string;
  box?: string;
  model?: string;
  account?: string;
  conversation?: string;
  source?: { kind: 'wake' | 'spawn' | 'conversation' | 'manual'; id: string };
}
export type Sender =
  | { kind: 'person'; slug: string }
  | { kind: 'agent'; id: string }
  | { kind: 'schedule' | 'unknown' };
/** A source can address a conversation before it has a runtime binding.
 * The runtime derives the conversation from agent/venue/place. The authenticated
 * caller supplies source identity; it is never accepted from this input.
 */
export interface Deliver {
  id: string;
  agent: string;
  venue: string;
  place: string;
  from: Sender;
  kind: 'message' | 'wake';
  at: string;
  label?: string;
  text: string;
  local?: boolean;
}
export interface Reply {
  conversation: string;
  id: string;
  text: string;
  /** The bound runtime job. The operation verifies this binding. */
  job: string;
}
/** Operations return the registry Result. A successful write acknowledges ids/state;
 * it never echoes message words into the registry's retry-result storage.
 * Callers retain the original viewer; this role confers no extra authority.
 * Queueing is transactional. Dispatch to a runner or venue is after commit and
 * uses the composition root's OutsideEffects gate, including staging holds.
 */
export interface Runtime {
  startBody(viewer: Viewer, input: StartBody, operationId: string): Result;
  deliver(viewer: Viewer, input: Deliver, operationId: string): Result;
  reply(viewer: Viewer, input: Reply, operationId: string): Promise<Result>;
  /** The attention piece owns desk status; runtime has no second status record. */
  reportStatus(viewer: Viewer, input: Omit<AgentStatus, 'changedAt'>, operationId: string): Result;
}
/** Binding only: the runtime installer supplies the operations in later slices.
 * Missing operations fail closed with the registry's not-found result.
 */
export function runtimeRole(operations: Pick<Operations, 'call' | 'callAsync'>): Runtime {
  const attention = attentionRole(operations);
  return {
    startBody: (viewer, input, id) => operations.call('direct', viewer, 'runtime.startBody', input, id),
    deliver: (viewer, input, id) => operations.call('direct', viewer, 'runtime.deliver', input, id),
    reply: (viewer, input, id) => operations.callAsync('direct', viewer, 'runtime.reply', input, id),
    reportStatus: (viewer, input, id) => attention.reportStatus(viewer, input, id),
  };
}
