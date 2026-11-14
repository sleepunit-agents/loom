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

/** Owner is the widest steering principal. Keep every named person when a meet
 * becomes unknown; saved attribution and legacy text never fill missing proof. */
export function narrowPrincipal(original: Authorship['principal'] | undefined, caller: Authorship['principal']): Authorship['principal'] {
  const before = original ?? { for: '?', people: [] };
  const principal = before.for === caller.for || caller.for === 'owner' ? before.for
    : before.for === 'owner' ? caller.for : '?';
  return { for: principal, people: [...new Set([...before.people, ...caller.people])].sort() };
}
/** A replacement is newly filed, but never for anyone wider than its predecessor. */
export function replacementAuthorship(original: Authorship | undefined, caller: Authorship): Authorship {
  const principal = narrowPrincipal(original?.principal, caller.principal);
  const result = { ...caller, principal };
  if (principal.for !== caller.principal.for && caller.conversation !== original?.conversation) delete result.conversation;
  return result;
}
/** A run retains the schedule's evidence for a member action. A body run would
 * use its own verified conversation, never the schedule's delivery destination. */
export function runAuthorship(original: Authorship | undefined, caller: Authorship): Authorship {
  const principal = narrowPrincipal(original?.principal, caller.principal);
  if (caller.origin) return { ...caller, principal };
  const result: Authorship = { ...original, principal };
  if (principal.for !== original?.principal.for) delete result.conversation;
  return result;
}
