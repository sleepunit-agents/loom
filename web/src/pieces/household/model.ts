import { createMutationStore } from '../../data/mutation';
export { idle, frozen } from '../../data/mutation';
import type { LiveRecord } from '../../data';
export interface Membership { person: string; role: 'owner' | 'member'; agents: '*' | string[] }
export interface Household extends LiveRecord {
  members: string[]; membership: Membership[]; agents: string[]; defaultAgent: string;
  agentAccounts: Record<string, { github: string[] }>;
}
export interface Project extends LiveRecord { slug: string; name: string; members: string[] }
export const mutation=createMutationStore();
export function memberInput(form: FormData) {
  return { person: String(form.get('person') ?? ''), agents: form.get('ownership') === 'household' ? '*' : form.getAll('agents').map(String) };
}
export function accountInput(form: FormData, agent: string) { return { agent, accounts: { github: String(form.get('github') ?? '').split(/[\s,]+/).filter(Boolean) } }; }

/** Nonsecret recovery breadcrumb survives navigation; never holds a request or bearer.
 * Deliberately separate from the short request store above, so no mint Call can be retained here. */
let attemptedLabel: string | undefined;
const attemptListeners = new Set<() => void>();
export const tokenAttempt = {
  getSnapshot: () => attemptedLabel,
  subscribe: (fn: () => void) => { attemptListeners.add(fn); return () => { attemptListeners.delete(fn); }; },
  set(label?: string) { attemptedLabel = label; attemptListeners.forEach(fn => fn()); },
};
