/** Original filing evidence. Never a Viewer or a substitute for current policy. */
import { mayAct, type Sharing, type Viewer } from '../../core/index.js';
import type { ClockProvenanceReader } from '../runtime/role.js';
import type { Work } from './store.js';
export interface Authorship {
  origin?: string;
  conversation?: string;
  member?: string;
  project?: string;
  service?: string;
  principal: { for: string; people: string[] };
}
/** Called with the exact current Signin Viewer, never with a stored attribution. */
export function filing(viewer: Viewer, input: Work, sharing: Sharing, resolve?: ClockProvenanceReader): Work | undefined {
  const proof = viewer.kind === 'agent' ? resolve?.(viewer) : undefined;
  if (proof) {
    if (viewer.kind !== 'agent' || viewer.id !== proof.agent || input.agent !== proof.agent
      || input.member !== undefined && input.member !== proof.member
      || input.project !== undefined && input.project !== proof.project) return;
    return { ...input, member: proof.member, project: proof.project,
      authorship: { origin: proof.agent, conversation: proof.conversation, member: proof.member,
        ...(proof.project === undefined ? {} : { project: proof.project }),
        ...(proof.service === undefined ? {} : { service: proof.service }),
        principal: structuredClone(proof.principal) } };
  }
  const principal = viewer.kind === 'member'
    ? { for: mayAct(viewer, {}, sharing, 'household') ? 'owner' : viewer.id, people: [viewer.id] }
    : { for: '?', people: [] };
  return { ...input, authorship: { ...(viewer.kind === 'agent' ? { origin: viewer.id } : {}),
    ...(input.member === undefined ? {} : { member: input.member }),
    ...(input.project === undefined ? {} : { project: input.project }), principal } };
}
