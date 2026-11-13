import type { Call, CallState, LiveRecord } from '../../data';
export interface Membership { person: string; role: 'owner' | 'member'; agents: '*' | string[] }
export interface Household extends LiveRecord {
  members: string[]; membership: Membership[]; agents: string[]; defaultAgent: string;
  agentAccounts: Record<string, { github: string[] }>;
}
export interface Project extends LiveRecord { slug: string; name: string; members: string[] }
export const idle: CallState = { pending: false, status: 'done' };
export function frozen(state: CallState): boolean { return state.pending || state.result?.ok === false && state.result.code === 'unavailable'; }
/** Window lifetime: navigation or a dock move cannot forget an uncertain write. */
let current: { request?: Call; label?: string } = {};
const listeners = new Set<() => void>();
export const mutation = {
  getSnapshot: () => current,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  set(request: Call, label: string) { current = { request, label }; listeners.forEach(fn => fn()); },
};
export function memberInput(form: FormData) {
  return { person: String(form.get('person') ?? ''), agents: form.get('ownership') === 'household' ? '*' : form.getAll('agents').map(String) };
}
export function accountInput(form: FormData, agent: string) { return { agent, accounts: { github: String(form.get('github') ?? '').split(/[\s,]+/).filter(Boolean) } }; }

/** Nonsecret recovery breadcrumb survives navigation; never holds a request or bearer. */
let attemptedLabel: string | undefined;
const attemptListeners = new Set<() => void>();
export const tokenAttempt = {
  getSnapshot: () => attemptedLabel,
  subscribe: (fn: () => void) => { attemptListeners.add(fn); return () => { attemptListeners.delete(fn); }; },
  set(label?: string) { attemptedLabel = label; attemptListeners.forEach(fn => fn()); },
};
