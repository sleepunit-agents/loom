import { isClosing, type Foundation } from '../../core/app.js';
import { signin } from '../../core/signin/index.js';
import { runtimeStore } from './store.js';
import { currentExecution } from './control.js';
import { bodyPolicyExecutionHeld } from './policy-store.js';
/** Runtime's seam for Clock, Comms and venue adapters. No runner or store imports. */
import type { Operations, Result, Scope, Viewer, Sharing } from '../../core/index.js';
import { attentionRole, type AgentStatus } from '../attention/role.js';

/** Trusted in-process provenance, never a public read or a permission grant.
 * Consumers must preserve member/project and still check central policy. The
 * conversation is issued only for an exact authenticated, currently bound body;
 * it must not be reconstructed from a job's public conversation argument.
 */
export interface ClockProvenance {
  agent: string;
  conversation: string;
  member: string;
  project?: string;
  service?: string;
  principal: { for: string; people: string[] };
}
export type ClockProvenanceReader = (viewer: Viewer) => ClockProvenance | undefined;

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

/** Exact active body scope for trusted in-process consumers. No caller input or
 * copied viewer can confer a job. Keep Runtime storage/policy behind its role.
 */
export function runtimeHouseContext(app: Foundation, viewer: Viewer): {agent: string; job: string; service?: string} | undefined {
  const proof = signin(app).body(viewer);
  if (!proof || viewer.kind !== 'agent' || proof.agent !== viewer.id) return;
  const store = runtimeStore(app.db), job = store.read('job', proof.job), box = job && store.read('box', job.box);
  if (!job || job.agent !== proof.agent || job.service !== proof.service || job.imported || job.endedAt !== undefined
    || !['starting', 'running', 'waiting'].includes(job.state) || !box || box.revokedAt !== undefined
    || bodyPolicyExecutionHeld(app.db, job.agent)) return;
  return {agent: job.agent, job: job.id, ...(job.service === undefined ? {} : {service: job.service})};
}

/** Metadata-only destination binding for Secrets. This role grants no secret,
 * supplies no URL/path/certificate, and never receives credential bytes. The
 * owning runner transport must authenticate its peer and bind its own pending
 * sink to this exact job/runner/box before release. Tickets and staging belong
 * to Secrets; a true current() is necessary but is not a release capability.
 */
export interface HouseDestination {
  readonly agent: string;
  readonly job: string;
  readonly runner: string;
  readonly box: string;
  readonly claimedAt: number;
  readonly service?: string;
  current(): boolean;
}
export function runtimeHouseDestination(app: Foundation, sharing: () => Sharing, viewer: Viewer): HouseDestination | undefined {
  const resolve = () => {
    if (isClosing(app)) return;
    const scope = runtimeHouseContext(app, viewer);
    if (!scope) return;
    const access = sharing();
    if (!Object.values(access.members).some(member => member.agents.includes(scope.agent))) return;
    const store = runtimeStore(app.db), job = store.read('job', scope.job);
    // Existing runner operations require both the assigned runner and box ids
    // to match. An imported/malformed split assignment is not a destination.
    if (!job || job.runner !== job.box || job.claimedAt === undefined || job.principalReset || job.writtenOff
      || !currentExecution(store, job, access)) return;
    return { ...scope, runner: job.runner, box: job.box, claimedAt: job.claimedAt };
  };
  let bound: ReturnType<typeof resolve>;
  try { bound = resolve(); } catch { return; }
  if (!bound) return;
  const identity = JSON.stringify(bound);
  return Object.freeze({ ...bound, current() {
    try { return JSON.stringify(resolve()) === identity; }
    catch { return false; }
  }});
}
